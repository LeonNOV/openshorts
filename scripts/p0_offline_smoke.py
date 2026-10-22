"""P0 feasibility smoke test for the DW-shorts desktop build.

Validates the core claim of the desktop plan: with a *bundled* set of
resources (local Whisper CT2 dir + local YOLO weights + bundled ffmpeg on
PATH) the pipeline runs its local stages with **no network access** and
produces a rendered video.

What it does
------------
1. Unit-checks ``desktop_runtime.install()`` resolves WHISPER_MODEL /
   YOLO_MODEL_PATH / PATH from ``DW_SHORTS_BUNDLE`` (the mechanism the
   desktop build relies on).
2. Builds a tiny synthetic clip with the bundled ffmpeg.
3. Runs ``python -u main.py -i <clip> -o <out> --skip-analysis`` fully
   offline (proxy vars stripped) and asserts:
     - a ``.mp4`` is produced, and
     - the combined log contains no download / network markers.

Usage:
    python scripts/p0_offline_smoke.py [bundle_dir]

Defaults bundle_dir to ``desktop/resources`` next to the repo root.
"""

import os
import re
import shutil
import subprocess
import sys
import tempfile

REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if REPO not in sys.path:
    sys.path.insert(0, REPO)

# Strings that, if they appear in the pipeline log, prove the run reached out
# to the network (the opposite of what an offline desktop build must do).
DOWNLOAD_MARKERS = (
    "downloading",
    "snapshot_download",
    "fetching",
    "huggingface",
    "http://",
    "https://",
    "connectionerror",
    "could not connect",
)


def unit_check_install(bundle: str) -> None:
    """Assert desktop_runtime wires the bundle into os.environ."""
    saved = dict(os.environ)
    try:
        os.environ["DW_SHORTS_BUNDLE"] = bundle
        # Ensure we don't inherit a dev override that would mask the resolution.
        os.environ.pop("WHISPER_MODEL", None)
        os.environ.pop("YOLO_MODEL_PATH", None)
        import desktop_runtime

        desktop_runtime.install()

        whisper = os.environ.get("WHISPER_MODEL", "")
        yolo = os.environ.get("YOLO_MODEL_PATH", "")
        path = os.environ.get("PATH", "")
        assert whisper and os.path.isfile(os.path.join(whisper, "model.bin")), \
            f"WHISPER_MODEL not resolved to a local dir: {whisper!r}"
        assert yolo and os.path.exists(yolo), \
            f"YOLO_MODEL_PATH not resolved to a local file: {yolo!r}"
        assert os.path.join(bundle, "bin") in path, \
            "bundle/bin not prepended to PATH"
        print(f"[unit] WHISPER_MODEL -> {whisper}")
        print(f"[unit] YOLO_MODEL_PATH -> {yolo}")
        print("[unit] PATH includes bundle/bin: OK")
    finally:
        os.environ.clear()
        os.environ.update(saved)


def make_test_clip(ffmpeg: str, out_path: str) -> None:
    """Render a 12s color-bars + sine-tone clip (no network needed)."""
    cmd = [
        ffmpeg, "-y", "-f", "lavfi", "-i",
        "color=c=blue:s=720x1280:r=30:d=12", "-f", "lavfi", "-i",
        "sine=frequency=440:duration=12", "-shortest", "-c:v", "libx264",
        "-pix_fmt", "yuv420p", "-c:a", "aac", "-b:a", "128k", out_path,
    ]
    subprocess.run(cmd, check=True, stdout=subprocess.DEVNULL,
                   stderr=subprocess.DEVNULL)


def run_pipeline(python: str, bundle: str, clip: str, out_dir: str) -> str:
    """Run main.py --skip-analysis fully offline; return combined log."""
    env = dict(os.environ)
    env["DW_SHORTS_BUNDLE"] = bundle
    env["DW_SHORTS_DATA_DIR"] = out_dir
    env["PATH"] = os.path.join(bundle, "bin") + os.pathsep + env.get("PATH", "")
    # Strip anything that could let the run reach the network.
    for k in ("HTTP_PROXY", "HTTPS_PROXY", "http_proxy", "https_proxy",
              "ALL_PROXY", "all_proxy", "HF_ENDPOINT"):
        env.pop(k, None)
    env["PYTHONIOENCODING"] = "utf-8"
    env["PYTHONUNBUFFERED"] = "1"

    proc = subprocess.run(
        [python, "-u", "main.py", "-i", clip, "-o", out_dir, "--skip-analysis"],
        cwd=REPO, env=env, capture_output=True, text=True, errors="replace",
        timeout=1200,
    )
    log = (proc.stdout or "") + "\n" + (proc.stderr or "")
    if proc.returncode != 0:
        print("[run] pipeline exited non-zero; tail of log:")
        print("\n".join(log.splitlines()[-40:]))
        raise SystemExit(f"pipeline failed (rc={proc.returncode})")
    return log


def main() -> None:
    bundle = sys.argv[1] if len(sys.argv) > 1 else os.path.join(REPO, "desktop", "resources")
    if not os.path.isdir(os.path.join(bundle, "models", "faster-whisper-small")):
        raise SystemExit(f"bundle not prepared: missing {bundle}/models/faster-whisper-small")
    ffmpeg = os.path.join(bundle, "bin", "ffmpeg")
    if not os.path.exists(ffmpeg):
        raise SystemExit(f"bundle missing ffmpeg: {ffmpeg}")

    print(f"[p0] bundle = {bundle}")
    unit_check_install(bundle)

    with tempfile.TemporaryDirectory(prefix="dw_p0_") as tmp:
        clip = os.path.join(tmp, "test.mp4")
        out_dir = os.path.join(tmp, "output")
        os.makedirs(out_dir, exist_ok=True)
        print("[p0] generating synthetic test clip ...")
        make_test_clip(ffmpeg, clip)

        print("[p0] running offline pipeline (--skip-analysis) ...")
        log = run_pipeline(sys.executable, bundle, clip, out_dir)

        # Assertions
        clips = [f for f in os.listdir(out_dir) if f.endswith(".mp4")]
        assert clips, "no .mp4 produced by the pipeline"
        low = log.lower()
        hits = [m for m in DOWNLOAD_MARKERS if m in low]
        assert not hits, f"network/download markers found in log: {hits}"

        print(f"[p0] produced {len(clips)} clip(s): {clips[:5]}")
        print("[p0] no download/network markers in log: OK")
        print("\nP0 FEASIBILITY: PASS (local stack renders offline)")


if __name__ == "__main__":
    main()
