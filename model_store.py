"""Where the AI model weights live, and how to fetch them when they are missing.

The installer no longer ships the weights. They are ~470 MB of float tensors
that barely compress (470 MB -> 431 MB zipped), so they dominated what the
user had to download for a 650 MB app that is otherwise ready to run. The app
now fetches them on demand into its own data directory and loads them from
disk, exactly like the bundled ones were loaded.

Layout under the data directory (``DW_SHORTS_DATA_DIR``)::

    models/
      faster-whisper-small/
        config.json  model.bin  tokenizer.json  vocabulary.txt
      yolov8n.pt

Sources:

* Whisper (CTranslate2) comes from the ``Systran/faster-whisper-*`` repos on
  Hugging Face. ``huggingface.co`` is unreachable from mainland China, so the
  default base URL points at the widely used public mirror. Set
  ``DW_MODEL_BASE_URL`` to use your own CDN — it must serve the same layout::

      <base>/Systran/faster-whisper-small/config.json
      <base>/Systran/faster-whisper-small/model.bin
      ...

* YOLO comes from the ultralytics GitHub release, which is reachable from
  China and needs no mirror.

Downloads are resumable (HTTP Range into a ``.part`` file) and report
progress through a callback ``(downloaded_bytes, total_bytes_or_None, label)``.
"""

import os
import shutil
import time
import urllib.error
import urllib.request

# huggingface.co is blocked in mainland China; this mirror is not.
DEFAULT_HF_BASE = "https://hf-mirror.com"
WHISPER_REPO = "Systran/faster-whisper-{size}"
# The files faster-whisper needs at load time. README.md / .gitattributes are
# deliberately left out.
WHISPER_FILES = ("config.json", "model.bin", "tokenizer.json", "vocabulary.txt")
YOLO_FILE = "yolov8n.pt"
YOLO_URL = "https://github.com/ultralytics/assets/releases/download/v8.4.0/yolov8n.pt"

# Approximate download size per Whisper size, for the UI.
WHISPER_SIZES = {
    "small": 464,
    "medium": 1530,
    "large-v3-turbo": 1620,
}

_CHUNK = 1 << 20
# A model download is a few hundred MB over a consumer connection: a read
# timeout is normal, not fatal. Retry with a backoff and resume from the
# partial file instead of starting over.
_TIMEOUT = 60
_RETRIES = 5
_BACKOFF = 2.0


def base_url() -> str:
    """The Hugging Face-compatible base URL the weights are fetched from."""
    return (os.environ.get("DW_MODEL_BASE_URL") or DEFAULT_HF_BASE).rstrip("/")


def data_dir() -> str:
    """The app's writable data directory (same rule as desktop_runtime)."""
    return os.environ.get("DW_SHORTS_DATA_DIR") or os.getcwd()


def models_root() -> str:
    """Where the weights live on disk."""
    return os.path.join(data_dir(), "models")


def whisper_dir(size: str = "small") -> str:
    return os.path.join(models_root(), f"faster-whisper-{size}")


def yolo_path() -> str:
    return os.path.join(models_root(), YOLO_FILE)


def whisper_ready(size: str = "small") -> bool:
    """True when the size is fully downloaded (model.bin is the big one)."""
    return os.path.isfile(os.path.join(whisper_dir(size), "model.bin"))


def yolo_ready() -> bool:
    return os.path.isfile(yolo_path())


def ready_sizes() -> list:
    """The Whisper sizes that are present on disk."""
    root = models_root()
    if not os.path.isdir(root):
        return []
    out = []
    for name in sorted(os.listdir(root)):
        if name.startswith("faster-whisper-") and whisper_ready(name[len("faster-whisper-"):]):
            out.append(name[len("faster-whisper-"):])
    return out


def _download(url: str, dest: str, progress=None, label: str = "") -> str:
    """Download ``url`` to ``dest``, resuming a partial file if there is one.

    Writes to ``dest.part`` and renames it into place at the end, so an
    interrupted download never leaves a half-written file where the app would
    happily try to load it. A transient network failure is retried; the retry
    continues the partial file rather than starting over.
    """
    tmp = dest + ".part"
    last_error = None
    for attempt in range(1, _RETRIES + 1):
        try:
            _download_once(url, tmp, progress, label)
            os.replace(tmp, dest)
            return dest
        except Exception as e:  # noqa: BLE001 - network errors are expected
            last_error = e
            if attempt == _RETRIES:
                break
            wait = _BACKOFF * attempt
            print(f"[model_store] {label or url}: {e}; retrying in {wait:.0f}s "
                  f"({attempt}/{_RETRIES})", flush=True)
            time.sleep(wait)
    # Give up, but keep the partial file: the next attempt resumes from it.
    raise last_error


def _download_once(url: str, tmp: str, progress=None, label: str = "") -> None:
    """One download attempt, appending to ``tmp`` (resuming when possible)."""
    have = os.path.getsize(tmp) if os.path.exists(tmp) else 0
    req = urllib.request.Request(url, headers={"User-Agent": "DW-shorts"})
    if have:
        req.add_header("Range", f"bytes={have}-")
    with urllib.request.urlopen(req, timeout=_TIMEOUT) as resp:
        # A server that ignores Range replies 200 with the whole file; in that
        # case start over instead of appending to the partial file.
        resuming = have > 0 and resp.status == 206
        if not resuming:
            have = 0
        length = resp.headers.get("Content-Length")
        total = (int(length) if length else 0) + (have if resuming else 0)
        with open(tmp, "ab" if resuming else "wb") as fh:
            while True:
                chunk = resp.read(_CHUNK)
                if not chunk:
                    break
                fh.write(chunk)
                have += len(chunk)
                if progress:
                    progress(have, total or None, label)


def download_whisper(size: str = "small", progress=None) -> str:
    """Fetch a faster-whisper (CTranslate2) model into the data directory."""
    if size not in WHISPER_SIZES:
        raise ValueError(f"unknown whisper size: {size!r}")
    target = whisper_dir(size)
    os.makedirs(target, exist_ok=True)
    base = f"{base_url()}/{WHISPER_REPO.format(size=size)}"
    for name in WHISPER_FILES:
        url = f"{base}/resolve/main/{name}"
        _download(url, os.path.join(target, name), progress, f"{size}/{name}")
    return target


def download_yolo(progress=None) -> str:
    """Fetch the YOLO detection weights into the data directory."""
    os.makedirs(models_root(), exist_ok=True)
    url = f"{base_url()}/{YOLO_FILE}" if os.environ.get("DW_MODEL_BASE_URL") else YOLO_URL
    return _download(url, yolo_path(), progress, YOLO_FILE)


def status() -> dict:
    """A snapshot of what is on disk, for the UI."""
    sizes = ready_sizes()
    return {
        "base_url": base_url(),
        "whisper": {
            "sizes": sizes,
            "ready": bool(sizes),
            "available": sorted(WHISPER_SIZES),
            "approximate_mb": WHISPER_SIZES,
        },
        "yolo": {
            "ready": yolo_ready(),
            "path": yolo_path() if yolo_ready() else None,
        },
    }


def clear() -> None:
    """Remove every downloaded weight (used when the user resets the app)."""
    shutil.rmtree(models_root(), ignore_errors=True)


if __name__ == "__main__":
    import sys

    size = sys.argv[1] if len(sys.argv) > 1 else "small"
    print("whisper ->", download_whisper(size, lambda d, t, l: print(f"  {l}: {d}/{t or '?'}")))
    print("yolo    ->", download_yolo(lambda d, t, l: print(f"  {l}: {d}/{t or '?'}")))
    print(status())
