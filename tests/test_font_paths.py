"""The bundled fonts have to be found from any working directory.

The desktop app starts the backend from the app bundle, where the working
directory is not the source tree. A font path built from the working
directory then does not resolve, and PIL answers "cannot open resource" —
the render still happened, but with Pillow's default typeface instead of
the one the look asked for, so the "pill" hooks came out in the wrong
font on Windows only.

subtitles.py already resolves its fonts directory from its own location;
hooks.py was the one place that did not.

Usage: python -m pytest tests/test_font_paths.py -v
(or: python tests/test_font_paths.py)
"""
import os
import subprocess
import sys
import tempfile

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)

import hooks  # noqa: E402

BUNDLED = [
    "Montserrat-ExtraBold.ttf",
    "Anton-Regular.ttf",
    "NotoSerif-Bold.ttf",
]


def test_font_dir_is_absolute():
    """The directory must not depend on where the process was started."""
    assert os.path.isabs(hooks.FONT_DIR), (
        f"FONT_DIR is relative ({hooks.FONT_DIR!r}) — it resolves against the "
        "working directory, which is not the source tree in the desktop app"
    )


def test_the_bundled_fonts_exist():
    for name in BUNDLED:
        p = os.path.join(hooks.FONT_DIR, name)
        assert os.path.exists(p), f"{name} is missing from {hooks.FONT_DIR}"


def test_every_hook_font_resolves_to_a_real_file():
    """HOOK_FONTS maps a look to a file; all of them have to be there."""
    for look, (path, _factor) in hooks.HOOK_FONTS.items():
        assert os.path.isabs(path), f"the {look} font path is relative: {path}"
        assert os.path.exists(path), f"the {look} font file is missing: {path}"


def test_the_font_loads_from_any_working_directory():
    """The real check: load a font with the CWD somewhere else entirely."""
    from PIL import ImageFont
    with tempfile.TemporaryDirectory() as elsewhere:
        code = (
            "import os, sys\n"
            f"sys.path.insert(0, {ROOT!r})\n"
            f"os.chdir({elsewhere!r})\n"
            "from PIL import ImageFont\n"
            "import hooks\n"
            "f = ImageFont.truetype(hooks.PILL_FONT_PATH, 40)\n"
            "print('loaded', f.getname())\n"
        )
        p = subprocess.run(
            [sys.executable, "-c", code],
            capture_output=True, text=True, timeout=120,
        )
        assert p.returncode == 0, (
            f"loading the font from another directory failed:\n{p.stdout}\n{p.stderr}"
        )
        assert "loaded" in p.stdout, p.stdout


if __name__ == '__main__':
    failures = 0
    for name, fn in sorted(globals().items()):
        if name.startswith('test_') and callable(fn):
            try:
                fn()
                print(f"PASS  {name}")
            except Exception as e:  # noqa: BLE001
                print(f"FAIL  {name}\n      {e}")
                failures += 1
    print(f"\n{'FAILED' if failures else 'PASSED'}: {failures} failed")
    sys.exit(1 if failures else 0)
