"""The provider either/or, end to end through the HTTP API.

Gemini and DeepSeek are two ways to answer the pipeline's text prompts;
ElevenLabs and Fish Audio are two ways to make a voice. These tests drive
the real endpoints with the real headers the dashboard sends, and check
that the chosen provider is the one that gets used — and that the other
one's key is not.
"""
import asyncio
import json

import httpx
import pytest

# Self-host mode is guaranteed by tests/conftest.py (BILLING_ENABLED=0).
import app as app_module
from app import app


def _get(path, headers=None):
    async def _run():
        transport = httpx.ASGITransport(app=app)
        async with httpx.AsyncClient(transport=transport, base_url="http://t") as client:
            return await client.get(path, headers=headers or {})
    return asyncio.run(_run())


def _post(path, payload=None, headers=None):
    async def _run():
        transport = httpx.ASGITransport(app=app)
        async with httpx.AsyncClient(transport=transport, base_url="http://t") as client:
            return await client.post(path, json=payload or {},
                                     headers=headers or {})
    return asyncio.run(_run())


# --- the LLM provider ------------------------------------------------------

class TestLlmProvider:
    def test_a_deepseek_key_selects_deepseek(self, monkeypatch):
        monkeypatch.setenv("GEMINI_API_KEY", "")
        provider, key = asyncio.run(app_module.resolve_llm(
            _FakeRequest({"X-DeepSeek-Key": "sk-user"})))
        assert provider == "deepseek"
        assert key == "sk-user"

    def test_a_gemini_key_selects_gemini(self, monkeypatch):
        monkeypatch.setenv("GEMINI_API_KEY", "env-gemini")
        provider, key = asyncio.run(app_module.resolve_llm(
            _FakeRequest({"X-Gemini-Key": "sk-gemini"})))
        assert provider == "gemini"
        assert key == "sk-gemini"

    def test_without_a_header_the_environment_decides(self, monkeypatch):
        monkeypatch.setenv("GEMINI_API_KEY", "env-gemini")
        provider, key = asyncio.run(app_module.resolve_llm(_FakeRequest({})))
        assert provider == "gemini"
        assert key == "env-gemini"

    def test_a_job_runs_with_the_deepseek_key_in_its_environment(self, monkeypatch):
        """The subprocess has to be told which provider answers, or the
        moment picker would look for a Gemini key that is not there."""
        monkeypatch.setenv("GEMINI_API_KEY", "")
        monkeypatch.setenv("UPLOAD_POST_API_KEY", "x")
        resp = _post("/api/process",
                     {"url": "https://www.youtube.com/watch?v=ok",
                      "acknowledged": True},
                     headers={"X-DeepSeek-Key": "sk-user"})
        assert resp.status_code == 200
        env = app_module.jobs[resp.json()["job_id"]]["env"]
        assert env["LLM_PROVIDER"] == "deepseek"
        assert env["DEEPSEEK_API_KEY"] == "sk-user"

    def test_a_gemini_job_does_not_inherit_a_deepseek_key(self, monkeypatch):
        """A stale DeepSeek key in the server env must not answer a job
        that asked for Gemini."""
        monkeypatch.setenv("GEMINI_API_KEY", "env-gemini")
        monkeypatch.setenv("DEEPSEEK_API_KEY", "env-deepseek")
        monkeypatch.setenv("UPLOAD_POST_API_KEY", "x")
        resp = _post("/api/process",
                     {"url": "https://www.youtube.com/watch?v=ok",
                      "acknowledged": True},
                     headers={"X-Gemini-Key": "sk-gemini"})
        assert resp.status_code == 200
        env = app_module.jobs[resp.json()["job_id"]]["env"]
        assert env["GEMINI_API_KEY"] == "sk-gemini"
        assert "DEEPSEEK_API_KEY" not in env
        assert "LLM_PROVIDER" not in env

    def test_a_job_without_any_key_is_refused(self, monkeypatch):
        monkeypatch.setenv("GEMINI_API_KEY", "")
        monkeypatch.setenv("DEEPSEEK_API_KEY", "")
        monkeypatch.setenv("LLM_BASE_URL", "")
        monkeypatch.setenv("LLM_PROVIDER", "")
        resp = _post("/api/process",
                     {"url": "https://www.youtube.com/watch?v=ok",
                      "acknowledged": True})
        assert resp.status_code == 400

    def test_a_deepseek_job_keeps_the_gemini_key_out(self, monkeypatch):
        """A DeepSeek key is not a Google key.

        The frame-based stages (layout picker, screen check) talk to Google
        with GEMINI_API_KEY, so the DeepSeek key must never land there — it
        would make them fail with an auth error instead of degrading.
        """
        monkeypatch.setenv("GEMINI_API_KEY", "")
        monkeypatch.setenv("UPLOAD_POST_API_KEY", "x")
        resp = _post("/api/process",
                     {"url": "https://www.youtube.com/watch?v=ok",
                      "acknowledged": True},
                     headers={"X-DeepSeek-Key": "sk-user"})
        assert resp.status_code == 200
        env = app_module.jobs[resp.json()["job_id"]]["env"]
        assert env["DEEPSEEK_API_KEY"] == "sk-user"
        assert "GEMINI_API_KEY" not in env

    def test_both_keys_travel_together_when_both_are_given(self, monkeypatch):
        """DeepSeek answers the text stages, Gemini still answers the
        frame-based ones — so the child needs both, each in its own slot."""
        monkeypatch.setenv("GEMINI_API_KEY", "")
        monkeypatch.setenv("UPLOAD_POST_API_KEY", "x")
        resp = _post("/api/process",
                     {"url": "https://www.youtube.com/watch?v=ok",
                      "acknowledged": True},
                     headers={"X-DeepSeek-Key": "sk-user",
                              "X-Gemini-Key": "sk-gemini"})
        assert resp.status_code == 200
        env = app_module.jobs[resp.json()["job_id"]]["env"]
        assert env["DEEPSEEK_API_KEY"] == "sk-user"
        assert env["GEMINI_API_KEY"] == "sk-gemini"
        assert env["LLM_PROVIDER"] == "deepseek"

    def test_the_text_provider_and_the_frame_provider_are_separate(self, monkeypatch):
        """resolve_llm picks the text provider, resolve_gemini picks the key
        the frame-based stages need — they are two different questions."""
        monkeypatch.setenv("GEMINI_API_KEY", "env-gemini")
        request = _FakeRequest({"X-DeepSeek-Key": "sk-user",
                                 "X-Gemini-Key": "sk-gemini"})
        provider, key = asyncio.run(app_module.resolve_llm(request))
        assert (provider, key) == ("deepseek", "sk-user")
        gemini = asyncio.run(app_module.resolve_gemini(request))
        assert gemini == "sk-gemini"


# --- the voice provider ----------------------------------------------------

class TestVoiceProvider:
    def test_the_voices_endpoint_answers_for_the_chosen_provider(self, monkeypatch):
        monkeypatch.setattr(app_module.tts, "voices",
                            lambda provider, key: [{"voice_id": f"{provider}-1"}]
                            if provider == "fish_audio" else [{"voice_id": "el-1"}])
        resp = _get("/api/saasshorts/voices?provider=fish_audio",
                    headers={"X-Fish-Audio-Key": "sk-fish"})
        assert resp.status_code == 200
        body = resp.json()
        assert body["source"] == "fish_audio"
        assert body["voices"][0]["voice_id"] == "fish_audio-1"
        assert [m["id"] for m in body["models"]] == [
            "s2.1-pro", "s2.1-pro-free", "s2-pro", "s1"]

    def test_an_unknown_voice_provider_is_refused(self):
        resp = _get("/api/saasshorts/voices?provider=robovoice")
        assert resp.status_code == 400

    def test_fish_audio_without_a_voice_says_so(self, monkeypatch):
        monkeypatch.setattr(app_module.tts, "voices", lambda provider, key: [])
        resp = _get("/api/saasshorts/voices?provider=fish_audio",
                    headers={"X-Fish-Audio-Key": "sk-fish"})
        body = resp.json()
        assert body["voices"] == []
        assert "fish.audio" in body["detail"].lower()

    def test_generation_needs_the_key_of_the_chosen_provider(self, monkeypatch):
        """A Fish Audio job must not be accepted on an ElevenLabs key."""
        resp = _post("/api/saasshorts/generate",
                     {"script": {}, "tts_provider": "fish_audio"},
                     headers={"X-Fal-Key": "sk-fal",
                              "X-ElevenLabs-Key": "sk-el"})
        assert resp.status_code == 400
        assert "Fish Audio" in resp.json()["detail"]

    def test_generation_needs_the_fal_key_too(self, monkeypatch):
        resp = _post("/api/saasshorts/generate",
                     {"script": {}, "tts_provider": "fish_audio"},
                     headers={"X-Fish-Audio-Key": "sk-fish"})
        assert resp.status_code == 400
        assert "fal.ai" in resp.json()["detail"]

    def test_the_chosen_provider_reaches_the_pipeline(self, monkeypatch):
        """The provider, its key and its model have to travel into the
        config the pipeline runs on."""
        seen = {}

        def fake_generate(script, config, output_dir, log=print):
            seen.update(config)
            return {"video_filename": "v.mp4", "duration": 1.0, "cost_estimate": {}}

        monkeypatch.setattr(app_module, "generate_full_video", fake_generate)
        resp = _post("/api/saasshorts/generate",
                     {"script": {"title": "t"}, "tts_provider": "fish_audio",
                      "tts_model": "s2-pro"},
                     headers={"X-Fal-Key": "sk-fal",
                              "X-Fish-Audio-Key": "sk-fish"})
        assert resp.status_code == 200
        assert seen["tts_provider"] == "fish_audio"
        assert seen["tts_key"] == "sk-fish"
        assert seen["tts_model"] == "s2-pro"

    def test_dubbing_needs_the_key_of_the_chosen_provider(self, monkeypatch):
        monkeypatch.setenv("GEMINI_API_KEY", "env-gemini")
        resp = _post("/api/translate",
                     {"job_id": "j", "clip_index": 0, "target_language": "es",
                      "tts_provider": "fish_audio"},
                     headers={"X-ElevenLabs-Key": "sk-el"})
        assert resp.status_code == 400
        assert "Fish Audio" in resp.json()["detail"]


class _CaseInsensitiveHeaders(dict):
    """Starlette's Headers lookups ignore the case of the name."""

    def get(self, name, default=None):
        for key, value in self.items():
            if key.lower() == name.lower():
                return value
        return default


class _FakeRequest:
    """Just enough Request for resolve_llm: it reads headers."""

    def __init__(self, headers):
        self.headers = _CaseInsensitiveHeaders(
            {k.lower(): v for k, v in headers.items()})
