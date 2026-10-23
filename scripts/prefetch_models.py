"""Pre-fetch the models bundled with DW-shorts for offline use.

Run ONCE on the build machine (needs network the first time). It copies the
resulting directories into ``desktop/resources/models`` so the desktop build
can ship them and ``faster-whisper`` loads the CT2 weights from disk at
runtime — no HuggingFace download, no ``HF_ENDPOINT`` / ``HF_HUB_DISABLE_XET``
dance, ever.

Usage:
    python scripts/prefetch_models.py [dest_dir] [whisper_size]

Defaults: dest_dir=desktop/resources/models, whisper_size=small.
Override the size with ``DW_WHISPER_SIZE`` or the second argument.
"""

import os
import shutil
import sys


def configure_hf_endpoint() -> None:
    """Point huggingface_hub at a reachable endpoint.

    ``huggingface.co`` is unreachable from mainland China, and the failure
    mode is a long hang rather than a clear error. ``hf-mirror.com`` serves
    the same layout, so it is the default; set ``DW_HF_ENDPOINT`` (or
    ``HF_ENDPOINT``) to use a different one, including the official host on a
    machine that can reach it.

    ``HF_HUB_DISABLE_XET`` is required with the mirror: the mirror serves the
    metadata but not ``cas-server.xethub.hf.co``, so Xet answers 401.
    """
    endpoint = os.environ.get("DW_HF_ENDPOINT") or os.environ.get("HF_ENDPOINT")
    if not endpoint:
        endpoint = "https://hf-mirror.com"
        os.environ["HF_ENDPOINT"] = endpoint
        # Only the mirror needs this; leaving it on for the official host
        # would needlessly slow the download down.
        os.environ.setdefault("HF_HUB_DISABLE_XET", "1")
    else:
        os.environ["HF_ENDPOINT"] = endpoint
    print(f"huggingface endpoint: {os.environ['HF_ENDPOINT']}")


def main() -> None:
    configure_hf_endpoint()

    # ABSOLUTE paths only. The YOLO step below chdir()s into a temp directory
    # and then looks for the downloaded weights by joining a RELATIVE path —
    # which, after the chdir, resolves against the wrong directory and the
    # file appears to be missing. Absolute paths make it cwd-independent.
    dest = os.path.abspath(sys.argv[1] if len(sys.argv) > 1 else "desktop/resources/models")
    whisper_size = (
        os.environ.get("DW_WHISPER_SIZE")
        or (sys.argv[2] if len(sys.argv) > 2 else "small")
    )
    os.makedirs(dest, exist_ok=True)

    # 1) Whisper (CT2) — resolve/download into the HF cache, then copy out so
    #    the build ships a self-contained directory with model.bin in it.
    from faster_whisper.utils import download_model

    src = download_model(whisper_size)
    if not os.path.isdir(src):
        raise SystemExit(f"download_model returned a non-directory: {src!r}")
    target = os.path.join(dest, f"faster-whisper-{whisper_size}")
    if os.path.isdir(target):
        shutil.rmtree(target)
    shutil.copytree(src, target)
    print(f"whisper -> {target}")

    # 2) YOLO — let ultralytics fetch yolov8n.pt into a temp dir, then copy it.
    from ultralytics import YOLO

    dl = os.path.join(dest, ".dl_yolo")
    os.makedirs(dl, exist_ok=True)
    prev_cwd = os.getcwd()
    os.chdir(dl)
    try:
        YOLO("yolov8n.pt")
        yolo_src = os.path.join(dl, "yolov8n.pt")
        if not os.path.exists(yolo_src):
            raise SystemExit("yolov8n.pt was not produced by ultralytics")
        shutil.copy(yolo_src, os.path.join(dest, "yolov8n.pt"))
    finally:
        os.chdir(prev_cwd)
        shutil.rmtree(dl, ignore_errors=True)
    print(f"yolo    -> {os.path.join(dest, 'yolov8n.pt')}")

    print("done ->", dest)


if __name__ == "__main__":
    main()
