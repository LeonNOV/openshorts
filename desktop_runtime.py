"""DW-shorts desktop runtime assembly.

Single point where the bundled desktop application wires its resources into
the running Python process. Every entry point (``app.py``, ``main.py`` and
any CLI helper) imports this module and calls ``install()`` once, near the
top, before any heavy model is loaded or any ``ffmpeg`` subprocess is spawned.

Behavior is fully gated on the ``DW_SHORTS_BUNDLE`` environment variable:

* When it is **not** set (normal developer / CI runs) ``install()`` does
  nothing and the process behaves exactly as before — no behavior change for
  the existing workflow.
* When it **is** set (a desktop build) it:

  1. prepends ``<bundle>/bin`` to ``PATH`` so the ~21 bare ``ffmpeg`` /
     ``ffprobe`` calls resolve to the bundled static binaries instead of
     whatever happens to be on the host;
  2. points ``WHISPER_MODEL`` at the bundled faster-whisper directory (only
     if the caller has not set it already) so ``faster-whisper`` loads the
     CT2 weights from disk instead of downloading them;
  3. points ``YOLO_MODEL_PATH`` at the bundled ``yolov8n.pt`` (only if
     unset).

The model resolution is intentionally "set-if-unset" so a user who passes an
explicit ``WHISPER_MODEL`` / ``YOLO_MODEL_PATH`` always wins.
"""

import glob
import os


def _resolve_whisper_model(models_dir: str):
    """Return the first bundled ``faster-whisper-*`` directory that actually
    contains ``model.bin``, or ``None`` when nothing suitable is found."""
    if not models_dir or not os.path.isdir(models_dir):
        return None
    for path in sorted(glob.glob(os.path.join(models_dir, "faster-whisper-*"))):
        if os.path.isfile(os.path.join(path, "model.bin")):
            return path
    return None


def install() -> None:
    """Wire bundled resources into ``os.environ``. No-op without a bundle."""
    bundle = os.environ.get("DW_SHORTS_BUNDLE")
    if not bundle:
        return

    # 1) ffmpeg / ffprobe — let the bare commands resolve to the bundle copy.
    bin_dir = os.path.join(bundle, "bin")
    if os.path.isdir(bin_dir):
        os.environ["PATH"] = bin_dir + os.pathsep + os.environ.get("PATH", "")

    # 2) models — only fill the gaps the caller has not already set.
    models_dir = os.path.join(bundle, "models")
    if models_dir and os.path.isdir(models_dir):
        if not os.environ.get("WHISPER_MODEL"):
            whisper = _resolve_whisper_model(models_dir)
            if whisper:
                os.environ["WHISPER_MODEL"] = whisper
        if not os.environ.get("YOLO_MODEL_PATH"):
            yolo = os.path.join(models_dir, "yolov8n.pt")
            if os.path.exists(yolo):
                os.environ["YOLO_MODEL_PATH"] = yolo


def resolve_data_dir() -> str:
    """Where user-writable data (uploads/output/logs) should live.

    Honors ``DW_SHORTS_DATA_DIR``; falls back to the current working
    directory so developer / CI runs are unaffected. The installer writes
    into read-only locations (``/Applications``, ``Program Files``), so the
    app must keep its mutable state in a writable directory instead.
    """
    return os.environ.get("DW_SHORTS_DATA_DIR") or os.getcwd()
