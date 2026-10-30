"""Tests for handing a local file to the backend by path instead of uploading it.

The desktop app runs on the user's own machine, so a video they picked is
already on disk. Pushing it through the loopback HTTP server copies a
multi-gigabyte file for nothing, and the upload cap (2 GB) stops being about
the upload and starts being about the user's footage.

So the app hands over the path instead, and the backend links the file into
the job. Two things have to hold for that to be safe:

* only the desktop app may do it — the backend listens on loopback, and
  anything in the user's browser can reach it, so a path without the app's
  token would be a way to read arbitrary files off their disk;
* the user's original file must come out untouched. The pipeline edits its
  source in place in one place (the source-duration cap replaces the file),
  so the job's source has to be a separate directory entry — a hard link,
  not the file itself and not a copy.

Usage: python -m pytest tests/test_local_source.py -v
(or: python tests/test_local_source.py)
"""
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import app  # noqa: E402


class _FakeRequest:
    """Just enough Request for the token check."""

    def __init__(self, token=None):
        self.headers = {} if token is None else {"X-Desktop-Token": token}


def _make_video(path, size=1024):
    with open(path, "wb") as fh:
        fh.write(b"\x00" * size)
    return path


# ---- the token ---------------------------------------------------------------

def test_no_token_in_the_environment_means_no_local_paths():
    os.environ.pop("DW_SHORTS_DESKTOP_TOKEN", None)
    assert not app._desktop_token_ok(_FakeRequest("anything"))
    assert not app._desktop_token_ok(_FakeRequest())


def test_the_wrong_token_is_refused():
    os.environ["DW_SHORTS_DESKTOP_TOKEN"] = "the-real-one"
    assert not app._desktop_token_ok(_FakeRequest("something-else"))
    assert not app._desktop_token_ok(_FakeRequest())
    assert not app._desktop_token_ok(_FakeRequest("the-real-on"))
    assert not app._desktop_token_ok(_FakeRequest("the-real-one "))
    del os.environ["DW_SHORTS_DESKTOP_TOKEN"]


def test_the_right_token_is_accepted():
    os.environ["DW_SHORTS_DESKTOP_TOKEN"] = "the-real-one"
    assert app._desktop_token_ok(_FakeRequest("the-real-one"))
    del os.environ["DW_SHORTS_DESKTOP_TOKEN"]


# ---- linking the file --------------------------------------------------------

def test_the_source_is_linked_not_copied(tmp_path=None):
    import tempfile
    with tempfile.TemporaryDirectory() as tmp:
        src = _make_video(os.path.join(tmp, "clip.mp4"))
        dst = app._link_local_source(src, "job1")
        try:
            assert os.path.exists(dst)
            # Same inode: the bytes are not duplicated.
            assert os.stat(src).st_ino == os.stat(dst).st_ino
            assert os.stat(src).st_nlink >= 2
            # And it sits where the rest of the code looks for a job's source.
            assert os.path.basename(dst).startswith("job1_")
        finally:
            if os.path.exists(dst):
                os.remove(dst)


def test_a_missing_file_is_refused():
    import tempfile
    with tempfile.TemporaryDirectory() as tmp:
        missing = os.path.join(tmp, "gone.mp4")
        try:
            app._link_local_source(missing, "job1")
        except Exception as e:
            assert "no longer exists" in str(e.detail)
            return
        raise AssertionError("a missing file was accepted")


def test_a_file_that_is_not_a_video_is_refused():
    import tempfile
    with tempfile.TemporaryDirectory() as tmp:
        src = os.path.join(tmp, "secrets.txt")
        with open(src, "w") as fh:
            fh.write("not a video")
        try:
            app._link_local_source(src, "job1")
        except Exception as e:
            assert "not a video container" in str(e.detail)
            return
        raise AssertionError("a text file was accepted")


def test_a_path_that_escapes_nowhere_is_still_just_a_path():
    # The path is used as given (the user picked it); only the extension and
    # the existence matter. The name that lands in UPLOAD_DIR is the basename,
    # so it cannot escape that directory.
    import tempfile
    with tempfile.TemporaryDirectory() as tmp:
        nested = os.path.join(tmp, "sub")
        os.makedirs(nested)
        src = _make_video(os.path.join(nested, "clip.mp4"))
        dst = app._link_local_source(src, "job1")
        try:
            assert os.path.dirname(dst) == app.UPLOAD_DIR
            assert "/" not in os.path.basename(dst)
        finally:
            if os.path.exists(dst):
                os.remove(dst)


def test_the_users_original_survives_an_in_place_edit():
    # The pipeline replaces its source file when it caps the duration
    # (os.replace over the path). That must replace the JOB's entry, not the
    # user's file.
    import tempfile
    with tempfile.TemporaryDirectory() as tmp:
        src = _make_video(os.path.join(tmp, "clip.mp4"), size=4096)
        dst = app._link_local_source(src, "job1")
        try:
            before = open(src, "rb").read()
            replacement = os.path.join(tmp, "capped.mp4")
            with open(replacement, "wb") as fh:
                fh.write(b"\x01" * 16)
            os.replace(replacement, dst)
            # The user's file still has its own bytes.
            assert open(src, "rb").read() == before
            # And the job's entry is the new one.
            assert open(dst, "rb").read() == b"\x01" * 16
        finally:
            if os.path.exists(dst):
                os.remove(dst)


if __name__ == "__main__":
    failures = 0
    for name, fn in sorted(globals().items()):
        if name.startswith("test_") and callable(fn):
            try:
                fn()
                print(f"PASS  {name}")
            except Exception as e:  # noqa: BLE001
                print(f"FAIL  {name}\n      {e}")
                failures += 1
    print(f"\n{'FAILED' if failures else 'PASSED'}: {failures} failed")
    sys.exit(1 if failures else 0)
