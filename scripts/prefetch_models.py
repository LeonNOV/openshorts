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


def main() -> None:
    dest = sys.argv[1] if len(sys.argv) > 1 else "desktop/resources/models"
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

    # 2) YOLO — let ultralytics fetch yolov8n.pt into CWD, then copy it.
    from ultralytics import YOLO

    YOLO("yolov8n.pt")
    yolo_src = "yolov8n.pt"
    if not os.path.exists(yolo_src):
        raise SystemExit("yolov8n.pt was not produced by ultralytics")
    shutil.copy(yolo_src, os.path.join(dest, "yolov8n.pt"))
    print(f"yolo    -> {os.path.join(dest, 'yolov8n.pt')}")

    print("done ->", dest)


if __name__ == "__main__":
    main()
