"""Fish Audio text-to-speech.

The second voice provider: where ElevenLabs covers dubbing and TTS with one
API key, Fish Audio is a separate account with its own models, its own voice
library and its own key. The dashboard lets the user pick one; this module is
the Fish Audio half of that choice.

Reference: https://docs.fish.audio/overview/capabilities and
https://docs.fish.audio/api-reference/endpoint/openapi-v1/text-to-speech

Two endpoints matter here:

* ``POST /v1/tts`` — synthesis. The model travels in the ``model`` header
  (not the body), the voice in ``reference_id``, and the answer is the audio
  bytes themselves.
* ``GET /model`` — the voice library. ``self=true`` lists the voices the
  account owns; without it the public library is searched instead. Only
  voices in the ``trained`` state can be used for synthesis.
"""
from __future__ import annotations

import os
import time
from typing import Optional

import httpx

FISH_AUDIO_API_BASE = "https://api.fish.audio"

# The models the TTS endpoint accepts, newest first. "speech-1.5"/"speech-1.6"
# were retired on 2026-02-28 and "s1" is on its way out (2026-12-31), so they
# are not offered.
FISH_AUDIO_MODELS = [
    {
        "id": "s2.1-pro",
        "label": "S2.1 Pro",
        "hint": "recommended — best quality, multi-speaker, emotion tags",
    },
    {
        "id": "s2.1-pro-free",
        "label": "S2.1 Pro Free",
        "hint": "same model, $0 — no latency or uptime guarantee",
    },
    {
        "id": "s2-pro",
        "label": "S2 Pro",
        "hint": "previous generation — multi-speaker, natural-language direction",
    },
    {
        "id": "s1",
        "label": "S1",
        "hint": "previous generation — (parenthesis) emotion tags",
    },
]

DEFAULT_FISH_AUDIO_MODEL = "s2.1-pro"

# HTTP status codes worth retrying (server-side / rate-limit hiccups).
_TRANSIENT_STATUS = {429, 500, 502, 503, 504}


def default_model() -> str:
    return (os.environ.get("FISH_AUDIO_MODEL") or DEFAULT_FISH_AUDIO_MODEL).strip()


def model_ids() -> list:
    return [m["id"] for m in FISH_AUDIO_MODELS]


def is_valid_model(model: Optional[str]) -> bool:
    """True when ``model`` is one the API serves (or unset, meaning default)."""
    if not model:
        return True
    return model.strip() in model_ids()


def _headers(api_key: str, model: Optional[str] = None) -> dict:
    """Auth plus the model header the TTS endpoint reads."""
    headers = {
        "Authorization": f"Bearer {api_key}",
        "Content-Type": "application/json",
    }
    chosen = (model or default_model()).strip()
    if chosen:
        headers["model"] = chosen
    return headers


def _with_retry(operation, description, max_attempts=3, base_delay=2.0):
    """Run ``operation`` with exponential backoff on transient failures."""
    for attempt in range(1, max_attempts + 1):
        try:
            return operation()
        except httpx.TransportError as e:
            if attempt >= max_attempts:
                raise Exception(f"[FishAudio] {description} failed after {max_attempts} attempts: {e}")
            delay = base_delay * (2 ** (attempt - 1))
            print(f"[FishAudio] {description} transient error (attempt {attempt}/{max_attempts}): {e}. "
                  f"Retrying in {int(delay)}s...")
            time.sleep(delay)


def generate_speech(text: str, api_key: str, output_path: str,
                    model: Optional[str] = None, reference_id: Optional[str] = None,
                    speed: Optional[float] = None, fmt: str = "mp3",
                    sample_rate: int = 44100) -> str:
    """Synthesize ``text`` into ``output_path`` and return the path.

    ``reference_id`` is the voice to speak with. Left empty, the API uses its
    own default voice — the account may not have cloned one yet, and a
    missing voice should not block the very first render.
    """
    if not (text or "").strip():
        raise Exception("[FishAudio] Nothing to synthesize (empty text).")

    url = f"{FISH_AUDIO_API_BASE}/v1/tts"
    body = {
        "text": text,
        "format": fmt,
        "sample_rate": sample_rate,
    }
    if reference_id:
        body["reference_id"] = reference_id
    if speed:
        body["prosody"] = {"speed": speed}
    elif fmt == "mp3":
        body["mp3_bitrate"] = 128

    def _submit():
        with httpx.Client(timeout=180.0) as client:
            resp = client.post(url, json=body, headers=_headers(api_key, model))
        if resp.status_code in _TRANSIENT_STATUS:
            raise httpx.TransportError(f"HTTP {resp.status_code}: {resp.text[:200]}")
        if resp.status_code != 200:
            raise Exception(f"Fish Audio TTS error ({resp.status_code}): {resp.text[:400]}")
        return resp

    response = _with_retry(_submit, "text-to-speech")
    with open(output_path, "wb") as f:
        f.write(response.content)
    return output_path


def list_voices(api_key: str, own_only: bool = True, page_size: int = 50) -> list:
    """The voices available for synthesis.

    ``own_only`` lists the voices the account cloned; without it the public
    Voice Library is searched instead. Only ``trained`` voices can speak, so
    the rest are filtered out here rather than at synthesis time.
    """
    url = f"{FISH_AUDIO_API_BASE}/model"
    params = {"page_size": page_size}
    if own_only:
        params["self"] = "true"

    def _submit():
        with httpx.Client(timeout=30.0) as client:
            resp = client.get(url, params=params, headers={"Authorization": f"Bearer {api_key}"})
        if resp.status_code in _TRANSIENT_STATUS:
            raise httpx.TransportError(f"HTTP {resp.status_code}: {resp.text[:200]}")
        if resp.status_code != 200:
            raise Exception(f"Fish Audio voices error ({resp.status_code}): {resp.text[:300]}")
        return resp

    try:
        response = _with_retry(_submit, "voice list")
    except Exception as e:
        print(f"[FishAudio] Voice list failed: {e}")
        return []

    try:
        data = response.json()
    except ValueError:
        return []

    voices = []
    for item in (data.get("items") or []):
        if not isinstance(item, dict):
            continue
        if str(item.get("state") or "").lower() != "trained":
            continue
        voice_id = item.get("_id") or item.get("id") or ""
        if not voice_id:
            continue
        voices.append({
            "voice_id": voice_id,
            "name": item.get("title") or voice_id,
            "description": item.get("description") or "",
            "language": item.get("language") or "",
            "tags": item.get("tags") or [],
            "visibility": item.get("visibility") or "",
        })
    return voices
