"""Unit tests for desktop_runtime — the single-point bundle wiring.

These guard the mechanism the desktop build depends on: from DW_SHORTS_BUNDLE,
``install()`` must point ffmpeg/PATH, WHISPER_MODEL and YOLO_MODEL_PATH at the
bundled resources, and must be a strict no-op when the variable is unset (so
developer / CI runs are untouched).
"""

import os
import textwrap
from pathlib import Path

import pytest

import desktop_runtime


def _make_bundle(root: Path) -> Path:
    bundle = root / "bundle"
    (bundle / "bin").mkdir(parents=True)
    (bundle / "bin" / "ffmpeg").write_text("")
    (bundle / "bin" / "ffprobe").write_text("")
    models = bundle / "models"
    (models / "faster-whisper-small").mkdir(parents=True)
    (models / "faster-whisper-small" / "model.bin").write_text("")
    (models / "yolov8n.pt").write_text("")
    return bundle


def test_noop_without_bundle(monkeypatch, tmp_path):
    monkeypatch.delenv("DW_SHORTS_BUNDLE", raising=False)
    monkeypatch.delenv("WHISPER_MODEL", raising=False)
    monkeypatch.delenv("YOLO_MODEL_PATH", raising=False)
    old_path = os.environ.get("PATH", "")
    desktop_runtime.install()
    # Nothing should be set or changed.
    assert "WHISPER_MODEL" not in os.environ
    assert "YOLO_MODEL_PATH" not in os.environ
    assert os.environ.get("PATH", "") == old_path


def test_resolves_bundle(monkeypatch, tmp_path):
    bundle = _make_bundle(tmp_path)
    monkeypatch.setenv("DW_SHORTS_BUNDLE", str(bundle))
    monkeypatch.delenv("WHISPER_MODEL", raising=False)
    monkeypatch.delenv("YOLO_MODEL_PATH", raising=False)
    desktop_runtime.install()

    assert os.environ["WHISPER_MODEL"] == str(bundle / "models" / "faster-whisper-small")
    assert os.environ["YOLO_MODEL_PATH"] == str(bundle / "models" / "yolov8n.pt")
    assert str(bundle / "bin") in os.environ["PATH"].split(os.pathsep)[0]


def test_does_not_override_explicit_model(monkeypatch, tmp_path):
    bundle = _make_bundle(tmp_path)
    monkeypatch.setenv("DW_SHORTS_BUNDLE", str(bundle))
    monkeypatch.setenv("WHISPER_MODEL", "/custom/whisper")
    monkeypatch.setenv("YOLO_MODEL_PATH", "/custom/yolo.pt")
    desktop_runtime.install()

    # Explicit caller values must win.
    assert os.environ["WHISPER_MODEL"] == "/custom/whisper"
    assert os.environ["YOLO_MODEL_PATH"] == "/custom/yolo.pt"
    # But ffmpeg PATH injection still happens.
    assert str(bundle / "bin") in os.environ["PATH"]


def test_resolve_data_dir(monkeypatch):
    monkeypatch.setenv("DW_SHORTS_DATA_DIR", "/data/dir")
    assert desktop_runtime.resolve_data_dir() == "/data/dir"
    monkeypatch.delenv("DW_SHORTS_DATA_DIR", raising=False)
    assert desktop_runtime.resolve_data_dir() == os.getcwd()
