"""Fish Audio as a voice provider (fish_audio.py / tts.py / fish_dub.py).

Fish Audio synthesizes speech from text with a model per call, and its voice
library is the account's own clones. These tests pin the request shape the
API documents (the model in a header, the voice in reference_id, the answer
is the audio bytes) and the either/or the dashboard drives.
"""
import json
import os

import httpx
import pytest

import fish_audio
import fish_dub
import tts


@pytest.fixture(autouse=True)
def _no_real_calls(monkeypatch):
    """Every test must not reach the network."""
    monkeypatch.setattr(fish_audio.httpx, "Client",
                        lambda *a, **kw: _boom("network call in a test"))


def _boom(msg):
    raise AssertionError(msg)


# --- the TTS request -------------------------------------------------------

def test_the_model_travels_in_a_header_and_the_answer_is_the_audio(monkeypatch):
    seen = {}

    class _Resp:
        status_code = 200
        content = b"ID3-fake-mp3-bytes"

    class _Client:
        def __init__(self, *a, **kw):
            pass

        def __enter__(self):
            return self

        def __exit__(self, *a):
            return False

        def post(self, url, json=None, headers=None):
            seen["url"] = url
            seen["body"] = json
            seen["headers"] = headers
            return _Resp()

    monkeypatch.setattr(fish_audio.httpx, "Client", _Client)
    out = os.path.join("/tmp", "voice.mp3")
    try:
        fish_audio.generate_speech("hello there", "sk-test", out,
                                   model="s2.1-pro", reference_id="ref-1")
        assert os.path.exists(out)
        with open(out, "rb") as f:
            assert f.read() == b"ID3-fake-mp3-bytes"
    finally:
        if os.path.exists(out):
            os.remove(out)

    assert seen["url"] == "https://api.fish.audio/v1/tts"
    assert seen["headers"]["Authorization"] == "Bearer sk-test"
    assert seen["headers"]["model"] == "s2.1-pro"
    assert seen["body"]["text"] == "hello there"
    assert seen["body"]["reference_id"] == "ref-1"


def test_the_voice_is_omitted_when_there_is_none(monkeypatch):
    """A fresh account has no clone yet, and a missing voice must not
    block the first render."""
    seen = {}

    class _Resp:
        status_code = 200
        content = b"x"

    class _Client:
        def __init__(self, *a, **kw):
            pass

        def __enter__(self):
            return self

        def __exit__(self, *a):
            return False

        def post(self, url, json=None, headers=None):
            seen["body"] = json
            return _Resp()

    monkeypatch.setattr(fish_audio.httpx, "Client", _Client)
    out = os.path.join("/tmp", "voice2.mp3")
    try:
        fish_audio.generate_speech("hi", "sk-test", out)
    finally:
        if os.path.exists(out):
            os.remove(out)
    assert "reference_id" not in seen["body"]


def test_an_api_error_is_reported_with_its_status(monkeypatch):
    class _Resp:
        status_code = 401
        text = "invalid api key"

    class _Client:
        def __init__(self, *a, **kw):
            pass

        def __enter__(self):
            return self

        def __exit__(self, *a):
            return False

        def post(self, url, json=None, headers=None):
            return _Resp()

    monkeypatch.setattr(fish_audio.httpx, "Client", _Client)
    with pytest.raises(Exception) as exc:
        fish_audio.generate_speech("hi", "sk-bad", "/tmp/never.mp3")
    assert "401" in str(exc.value)


def test_empty_text_is_refused_before_the_call():
    with pytest.raises(Exception) as exc:
        fish_audio.generate_speech("   ", "sk-test", "/tmp/never.mp3")
    assert "empty" in str(exc.value).lower()


# --- the voice library -----------------------------------------------------

def test_only_trained_voices_are_offered(monkeypatch):
    """A voice that is still training cannot speak, so it must not be in
    the list the user picks from."""
    class _Resp:
        status_code = 200

        def json(self):
            return {"total": 3, "items": [
                {"_id": "a", "title": "Narrator", "state": "trained",
                 "language": "en", "tags": ["male", "deep"]},
                {"_id": "b", "title": "Training", "state": "training"},
                {"_id": "c", "title": "Broken", "state": "failed"},
            ]}

    class _Client:
        def __init__(self, *a, **kw):
            pass

        def __enter__(self):
            return self

        def __exit__(self, *a):
            return False

        def get(self, url, params=None, headers=None):
            return _Resp()

    monkeypatch.setattr(fish_audio.httpx, "Client", _Client)
    voices = fish_audio.list_voices("sk-test")
    assert [v["voice_id"] for v in voices] == ["a"]
    assert voices[0]["name"] == "Narrator"


# --- the provider either/or -------------------------------------------------

def test_the_two_providers_are_listed_with_their_models():
    assert tts.PROVIDERS == ("elevenlabs", "fish_audio")
    assert tts.default_provider() == "elevenlabs"
    assert [m["id"] for m in tts.models("fish_audio")] == [
        "s2.1-pro", "s2.1-pro-free", "s2-pro", "s1"]
    assert "eleven_multilingual_v2" in [m["id"] for m in tts.models("elevenlabs")]


def test_fish_audio_voices_are_shaped_like_the_elevenlabs_ones(monkeypatch):
    """The dashboard renders one list for both providers, so the Fish Audio
    voices have to carry the same keys."""
    monkeypatch.setattr(fish_audio, "list_voices", lambda key, **kw: [
        {"voice_id": "ref-1", "name": "Narrator", "description": "calm",
         "language": "en", "tags": ["male"]},
    ])
    voices = tts.voices("fish_audio", "sk-test")
    assert len(voices) == 1
    v = voices[0]
    assert v["voice_id"] == "ref-1"
    assert v["name"] == "Narrator"
    assert v["category"] == "fish_audio"
    # The dashboard filters on labels.gender; a clone tagged "male" reads
    # as a male voice there.
    assert v["labels"]["gender"] == "male"
    assert v["labels"]["language"] == "en"


def test_synthesis_goes_to_the_provider_that_was_chosen(monkeypatch):
    calls = {}

    def fake_synthesize(text, api_key, output_path, model=None, reference_id=None):
        calls["fish"] = {"text": text, "key": api_key, "model": model,
                         "reference_id": reference_id}
        return output_path

    monkeypatch.setattr(fish_audio, "generate_speech", fake_synthesize)
    tts.synthesize("hello", "/tmp/out.mp3", provider="fish_audio",
                   api_key="sk-fish", voice_id="ref-9", model="s2-pro")

    assert calls["fish"]["key"] == "sk-fish"
    assert calls["fish"]["model"] == "s2-pro"
    assert calls["fish"]["reference_id"] == "ref-9"


def test_a_missing_key_is_refused_before_the_call():
    with pytest.raises(Exception) as exc:
        tts.synthesize("hello", "/tmp/out.mp3", provider="fish_audio", api_key="")
    assert "Fish Audio" in str(exc.value)


# --- the dubbing pipeline ---------------------------------------------------

def test_only_the_segments_inside_the_clip_are_dubbed():
    transcript = {"segments": [
        {"start": 0.0, "end": 5.0, "text": "before the clip"},
        {"start": 10.0, "end": 15.0, "text": "inside the clip"},
        {"start": 20.0, "end": 25.0, "text": "after the clip"},
    ]}
    segs = fish_dub.segments_for_clip(transcript, 8.0, 18.0)
    assert [s["text"] for s in segs] == ["inside the clip"]
    # The timings are relative to the clip's own start, so they can be
    # used directly as placement offsets.
    assert segs[0]["start"] == 2.0


def test_the_translations_are_paired_with_their_segments():
    segments = [{"start": 0.0, "end": 1.0, "text": "one"},
                {"start": 1.0, "end": 2.0, "text": "two"}]
    out = fish_dub.translate_segments(
        segments, "es", lambda texts, lang: [t.upper() for t in texts])
    assert [s["text"] for s in out] == ["ONE", "TWO"]
    assert out[1]["start"] == 1.0


def test_a_translation_of_the_wrong_length_is_refused():
    """A mismatch means the words and the audio no longer line up."""
    segments = [{"start": 0.0, "end": 1.0, "text": "one"},
                {"start": 1.0, "end": 2.0, "text": "two"}]
    with pytest.raises(Exception) as exc:
        fish_dub.translate_segments(segments, "es", lambda texts, lang: ["ONE"])
    assert "2" in str(exc.value)


def test_a_clip_without_a_transcript_cannot_be_dubbed():
    with pytest.raises(Exception) as exc:
        fish_dub.dub_clip(
            video_path="/tmp/v.mp4", output_path="/tmp/o.mp4",
            transcript={"segments": []}, clip_start=0.0, clip_end=5.0,
            target_language="es", api_key="sk-test", work_dir="/tmp/w",
            translate_fn=lambda texts, lang: texts)
    assert "transcript" in str(exc.value).lower()


def test_the_languages_offered_match_the_ones_the_other_provider_offers():
    """The dubbing UI shows one list; Fish Audio has to cover the same
    languages or the choice would silently narrow them."""
    from translate import get_supported_languages
    assert set(fish_dub.SUPPORTED_LANGUAGES) == set(get_supported_languages())
