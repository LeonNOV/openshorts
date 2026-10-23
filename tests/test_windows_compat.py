"""Tests for the Windows compatibility of the job runner.

The desktop app runs the same backend as the cloud, and the backend spawns
a child process per job. That spawn was written for POSIX and broke on
Windows with

    Error: Execution error: preexec_fn is not supported on Windows platforms

because subprocess.Popen refuses preexec_fn there, and os.nice() — the
thing the preexec_fn called — does not exist on Windows either.

These tests pin the platform split down: the spawn options have to be
valid for the platform they run on, and a real process has to start.

Usage: python -m pytest tests/test_windows_compat.py -v
(or: python tests/test_windows_compat.py)
"""
import os
import subprocess
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from app import _job_popen_kwargs  # noqa: E402


def test_popen_kwargs_are_accepted_by_popen():
    """The options must be ones the running platform's Popen accepts.

    This is the regression: on Windows, passing preexec_fn raised
    "preexec_fn is not supported on Windows platforms" and the job never
    started.
    """
    kwargs = _job_popen_kwargs()
    assert isinstance(kwargs, dict)
    # Spawning a real process with them is the check that matters — Popen
    # raises ValueError for options the platform does not support.
    p = subprocess.Popen(
        [sys.executable, "-c", "print('ok')"],
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        **kwargs,
    )
    out, _ = p.communicate(timeout=60)
    assert p.returncode == 0, out.decode(errors="replace")
    assert b"ok" in out


def test_priority_is_still_lowered():
    """The point of the options is a lower priority, on both platforms.

    POSIX: os.nice() in a preexec_fn.
    Windows: BELOW_NORMAL_PRIORITY_CLASS as a creation flag.
    """
    kwargs = _job_popen_kwargs()
    if os.name == 'posix':
        assert 'preexec_fn' in kwargs, "POSIX should lower the priority with os.nice()"
        assert 'creationflags' not in kwargs
    else:
        assert 'preexec_fn' not in kwargs, (
            "Windows must not pass preexec_fn — Popen refuses it there"
        )
        assert 'creationflags' in kwargs, (
            "Windows should lower the priority with a creation flag"
        )
        flags = kwargs['creationflags']
        below = getattr(subprocess, 'BELOW_NORMAL_PRIORITY_CLASS', 0x00004000)
        assert flags & below, "BELOW_NORMAL_PRIORITY_CLASS is not set"
        # Without CREATE_NO_WINDOW Windows opens a console window for every
        # child process, and the desktop app would flash a black box for each
        # ffmpeg the pipeline runs.
        no_window = getattr(subprocess, 'CREATE_NO_WINDOW', 0x08000000)
        assert flags & no_window, "CREATE_NO_WINDOW is not set"


def test_the_priority_is_really_applied():
    """Spawn a child and read back its priority class / nice value."""
    if os.name == 'posix':
        code = "import os; print(os.nice(0))"
    else:
        # GetPriorityClass reports the class it was given, so the value is
        # BELOW_NORMAL_PRIORITY_CLASS itself (16384), not 32.
        code = (
            "import ctypes;k=ctypes.windll.kernel32;"
            "k.GetPriorityClass.restype=ctypes.c_uint;"
            "k.GetPriorityClass.argtypes=[ctypes.c_void_p];"
            "k.GetCurrentProcess.restype=ctypes.c_void_p;"
            "k.GetCurrentProcess.argtypes=[];"
            "print(k.GetPriorityClass(k.GetCurrentProcess()))"
        )
    p = subprocess.Popen(
        [sys.executable, "-c", code],
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        **_job_popen_kwargs(),
    )
    out, _ = p.communicate(timeout=60)
    assert p.returncode == 0, out.decode(errors="replace")
    value = int(out.decode().strip().splitlines()[-1])
    if os.name == 'posix':
        assert value > 0, f"the child should run at a lower nice value, got {value}"
    else:
        below = getattr(subprocess, 'BELOW_NORMAL_PRIORITY_CLASS', 0x00004000)
        assert value == below, (
            f"the child should be BELOW_NORMAL_PRIORITY_CLASS ({below}), got {value}"
        )


def test_resource_is_optional():
    """`resource` is Unix-only, and main.py's atexit handler imports it.

    Without the guard the handler raises on Windows and the job never
    prints its JOB_CPU line, which app.py parses.
    """
    main_py = os.path.join(
        os.path.dirname(os.path.dirname(os.path.abspath(__file__))), 'main.py')
    with open(main_py, encoding='utf-8') as fh:
        body = fh.read()
    i = body.find('def _report_job_cpu')
    assert i >= 0, '_report_job_cpu is gone'
    block = body[i:i + 900]
    assert 'except ImportError' in block, (
        'the resource import in _report_job_cpu is not guarded — it raises on Windows'
    )


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
