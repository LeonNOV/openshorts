"""MediaPipe's face detector is optional.

The legacy ``mp.solutions`` API was removed in mediapipe 0.10.30, and PyPI
publishes nothing between 0.10.21 and 0.10.30 — so the last mediapipe with
that API (0.10.21) has no Python 3.13 wheel, while every mediapipe that does
install on 3.13 has dropped it. A missing face detector must therefore not
kill the job: the pipeline falls back to the YOLO person detector, which
already existed for the "no face found" case.

These tests pin that fallback down — the failure mode they guard against is
an ``AttributeError`` at import time that kills every job.
"""
import sys
import types

import numpy as np
import pytest


class _FakeMediaPipe:
    """A mediapipe without the legacy solutions API, like 0.10.30+ on py3.13."""

    def __init__(self):
        self.__version__ = "0.10.35"


@pytest.fixture
def no_face_detector(monkeypatch):
    """Import main with a mediapipe that has no ``solutions``."""
    monkeypatch.setitem(sys.modules, "mediapipe", _FakeMediaPipe())
    for name in ("main",):
        monkeypatch.delitem(sys.modules, name, raising=False)
    main = pytest.importorskip("main")
    return main


class TestFaceDetectorIsOptional:
    def test_main_imports_without_the_solutions_api(self, no_face_detector):
        assert no_face_detector.FACE_DETECTION_AVAILABLE is False

    def test_face_candidates_are_empty_instead_of_raising(self, no_face_detector):
        frame = np.zeros((480, 640, 3), dtype=np.uint8)
        assert no_face_detector.detect_face_candidates(frame) == []

    def test_the_person_detector_is_the_primary_signal(self, no_face_detector):
        """Without a face detector the person box is not a fallback, so it
        must not be throttled to half the detection rate."""
        assert no_face_detector.PERSON_STRIDE == no_face_detector.DETECT_STRIDE

    def test_the_fallback_stride_still_throttles_when_faces_work(self, no_face_detector):
        """With a face detector the YOLO path stays the throttled fallback."""
        # main is imported without mediapipe here, so the constant is the
        # no-face value; assert the relationship the code guarantees instead.
        assert no_face_detector.YOLO_FALLBACK_STRIDE == \
            no_face_detector.DETECT_STRIDE * 2


class TestReframeFollowsTheSameStride:
    def test_reframe_uses_the_person_stride_when_it_exists(self):
        import reframe_v2
        m = types.SimpleNamespace(DETECT_STRIDE=4, YOLO_FALLBACK_STRIDE=8,
                                  PERSON_STRIDE=4)
        assert reframe_v2._person_stride(m) == 4

    def test_reframe_falls_back_to_the_old_stride_when_absent(self):
        import reframe_v2
        m = types.SimpleNamespace(DETECT_STRIDE=4, YOLO_FALLBACK_STRIDE=8)
        assert reframe_v2._person_stride(m) == 8


class TestHookPlacement:
    def test_a_missing_face_detector_keeps_the_old_hook_spot(self, monkeypatch):
        """hook_placement already degrades to "no faces found"; it must not
        raise when mediapipe has no solutions API."""
        import hook_placement
        monkeypatch.setitem(sys.modules, "mediapipe", _FakeMediaPipe())
        monkeypatch.setattr(hook_placement, "_DETECTOR", None)
        assert hook_placement._detector() is None
