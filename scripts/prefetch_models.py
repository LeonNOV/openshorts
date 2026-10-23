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
import urllib.error
import urllib.request

OFFICIAL_ENDPOINT = "https://huggingface.co"
MIRROR_ENDPOINT = "https://hf-mirror.com"
# A tiny file that exists in every model repo, used to see whether the host
# answers at all. HEAD is enough and does not pull the weights.
PROBE_PATH = "api/models/Systran/faster-whisper-small"


def _reachable(endpoint: str, timeout: float = 8.0) -> bool:
    """True if the endpoint answers a request within the timeout."""
    try:
        req = urllib.request.Request(
            f"{endpoint}/{PROBE_PATH}",
            headers={"User-Agent": "DW-shorts-build"},
        )
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            return resp.status < 400
    except urllib.error.HTTPError as e:
        # A redirect or an auth challenge still proves the host is reachable.
        return e.code in (301, 302, 307, 308, 401, 403)
    except Exception:
        return False


def configure_hf_endpoint() -> None:
    """Point huggingface_hub at an endpoint that actually answers.

    ``huggingface.co`` is unreachable from mainland China, and the failure
    mode is a long hang rather than a clear error. ``hf-mirror.com`` serves
    the same layout, so it is the fallback.

    But the official host is reachable from plenty of machines (CI runners,
    and any desktop with a working proxy), and it is the faster of the two.
    So probe it first and only fall back to the mirror when it does not
    answer. Set ``DW_HF_ENDPOINT`` to pin a specific one.

    ``HF_HUB_DISABLE_XET`` is required with the mirror: the mirror serves the
    metadata but not ``cas-server.xethub.hf.co``, so Xet answers 401. The
    official host does not need it and is faster with it enabled.
    """
    pinned = os.environ.get("DW_HF_ENDPOINT") or os.environ.get("HF_ENDPOINT")
    if pinned:
        os.environ["HF_ENDPOINT"] = pinned
        if "hf-mirror" in pinned:
            os.environ.setdefault("HF_HUB_DISABLE_XET", "1")
        print(f"huggingface endpoint: {pinned} (pinned)")
        return

    if _reachable(OFFICIAL_ENDPOINT):
        os.environ["HF_ENDPOINT"] = OFFICIAL_ENDPOINT
        print(f"huggingface endpoint: {OFFICIAL_ENDPOINT}")
        return

    print(f"huggingface.co is not reachable, falling back to {MIRROR_ENDPOINT}")
    os.environ["HF_ENDPOINT"] = MIRROR_ENDPOINT
    os.environ.setdefault("HF_HUB_DISABLE_XET", "1")


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
