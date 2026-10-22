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
    """Return the bundled ``faster-whisper-*`` directory that should be used.

    Honors an explicit ``WHISPER_MODEL`` (set by ``install()`` or the user),
    then an optional ``DW_SHORTS_WHISPER_SIZE`` (e.g. ``small``), and finally
    falls back to the first directory that actually contains ``model.bin``.
    Returns ``None`` when nothing suitable is found.
    """
    explicit = os.environ.get("WHISPER_MODEL")
    if explicit and os.path.isdir(explicit):
        return explicit
    if not models_dir or not os.path.isdir(models_dir):
        return None
    size = os.environ.get("DW_SHORTS_WHISPER_SIZE")
    if size:
        cand = os.path.join(models_dir, f"faster-whisper-{size}")
        if os.path.isfile(os.path.join(cand, "model.bin")):
            return cand
    for path in sorted(glob.glob(os.path.join(models_dir, "faster-whisper-*"))):
        if os.path.isfile(os.path.join(path, "model.bin")):
            return path
    return None


def available_whisper_sizes():
    """List the whisper model sizes present in the bundle (e.g. ['small']).

    Used by the first-run wizard to offer only models that ship with the app.
    """
    bundle = os.environ.get("DW_SHORTS_BUNDLE")
    models_dir = os.path.join(bundle, "models") if bundle else None
    if not models_dir or not os.path.isdir(models_dir):
        return []
    sizes = []
    for path in sorted(glob.glob(os.path.join(models_dir, "faster-whisper-*"))):
        if os.path.isfile(os.path.join(path, "model.bin")):
            sizes.append(os.path.basename(path).replace("faster-whisper-", ""))
    return sizes


def selfcheck():
    """Offline readiness probe for the bundled desktop app (plan §6.3 step 1).

    Verifies the bundled ffmpeg runs, the whisper CT2 directory and YOLO
    weights exist, the data directory is writable, and the key Python
    dependencies import. Returns a structured report; never raises.
    """
    checks = {}
    overall = True

    # 1) ffmpeg / ffprobe — resolves via the PATH injected by install().
    try:
        import subprocess
        r = subprocess.run(
            ["ffmpeg", "-version"], capture_output=True, timeout=20,
            env={**os.environ, "PATH": os.environ.get("PATH", "")},
        )
        ok = r.returncode == 0 and b"ffmpeg version" in r.stdout
        checks["ffmpeg"] = {
            "ok": ok,
            "detail": (r.stdout.split(b"\n", 1)[0].decode(errors="replace")
                       if ok else "ffmpeg not found or failed to run"),
        }
    except Exception as e:  # noqa: BLE001 - report, don't crash
        checks["ffmpeg"] = {"ok": False, "detail": f"ffmpeg check failed: {e}"}
    overall = overall and checks["ffmpeg"]["ok"]

    # 2) whisper CT2 model directory
    whisper = _resolve_whisper_model(
        os.path.join(os.environ.get("DW_SHORTS_BUNDLE", ""), "models")
        if os.environ.get("DW_SHORTS_BUNDLE") else None
    )
    # _resolve_whisper_model already checks WHISPER_MODEL / bundle; fall back to
    # the bare env value for the path reported to the UI.
    whisper_path = whisper or os.environ.get("WHISPER_MODEL")
    if whisper_path and os.path.isfile(os.path.join(whisper_path, "model.bin")):
        checks["whisper_model"] = {"ok": True, "path": whisper_path}
    else:
        checks["whisper_model"] = {
            "ok": False,
            "path": whisper_path or "",
            "detail": "missing model.bin — run the model prefetch step",
        }
    overall = overall and checks["whisper_model"]["ok"]

    # 3) YOLO weights
    yolo = os.environ.get("YOLO_MODEL_PATH") or (
        os.path.join(os.environ.get("DW_SHORTS_BUNDLE", ""), "models", "yolov8n.pt")
        if os.environ.get("DW_SHORTS_BUNDLE") else None
    )
    if yolo and os.path.exists(yolo):
        checks["yolo"] = {"ok": True, "path": yolo}
    else:
        checks["yolo"] = {
            "ok": False, "path": yolo or "",
            "detail": "missing yolov8n.pt — run the model prefetch step",
        }
    overall = overall and checks["yolo"]["ok"]

    # 4) data directory writable
    data_dir = resolve_data_dir()
    try:
        os.makedirs(data_dir, exist_ok=True)
        probe = os.path.join(data_dir, ".selfcheck-write-test")
        with open(probe, "w") as fh:
            fh.write("ok")
        os.remove(probe)
        checks["data_dir_writable"] = {"ok": True, "path": data_dir}
    except Exception as e:  # noqa: BLE001
        checks["data_dir_writable"] = {"ok": False, "path": data_dir, "detail": str(e)}
    overall = overall and checks["data_dir_writable"]["ok"]

    # 5) key Python dependencies import
    deps = ["faster_whisper", "ultralytics", "mediapipe", "torch", "av",
            "cv2", "scenedetect", "transnetv2_pytorch"]
    missing = []
    for mod in deps:
        try:
            __import__(mod)
        except Exception:  # noqa: BLE001
            missing.append(mod)
    checks["python_deps"] = {"ok": not missing, "missing": missing}
    overall = overall and checks["python_deps"]["ok"]

    return {
        "ok": overall,
        "bundle": os.environ.get("DW_SHORTS_BUNDLE") or None,
        "whisper_sizes_available": available_whisper_sizes(),
        "checks": checks,
    }


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
