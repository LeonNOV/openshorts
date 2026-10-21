"""Voice provider abstraction: ElevenLabs or Fish Audio.

One place decides which service synthesizes a voice, so the dashboard's
either/or (ElevenLabs | Fish Audio) and the Fish Audio model choice travel
the same path as the key. Both providers speak the same two shapes the app
needs — "list the voices I can use" and "turn this text into an audio file"
— so everything above this module stays provider-agnostic.

ElevenLabs: the dubbing product (``translate.py``) and the text-to-speech
product. Fish Audio: text-to-speech with a model per call
(``fish_audio.py``) and a voice library of the account's own clones.
"""
from __future__ import annotations

import os
from typing import Optional

import fish_audio

PROVIDER_ELEVENLABS = "elevenlabs"
PROVIDER_FISH_AUDIO = "fish_audio"

PROVIDERS = (PROVIDER_ELEVENLABS, PROVIDER_FISH_AUDIO)

# The models each provider can synthesize with. ElevenLabs' list is here so
# the dashboard can render one dropdown for both; the default is the model
# the pipeline has always used, so nothing changes until a user picks.
ELEVENLABS_MODELS = [
    {
        "id": "eleven_multilingual_v2",
        "label": "Multilingual v2",
        "hint": "default — 29 languages, most stable",
    },
    {
        "id": "eleven_flash_v2_5",
        "label": "Flash v2.5",
        "hint": "faster and cheaper, slightly less expressive",
    },
    {
        "id": "eleven_turbo_v2_5",
        "label": "Turbo v2.5",
        "hint": "fastest, best for short lines",
    },
    {
        "id": "eleven_v3",
        "label": "v3",
        "hint": "newest, most expressive",
    },
]

DEFAULT_ELEVENLABS_MODEL = "eleven_multilingual_v2"


def default_provider() -> str:
    """The provider used when a request does not name one."""
    chosen = (os.environ.get("TTS_PROVIDER") or "").strip().lower()
    if chosen in PROVIDERS:
        return chosen
    return PROVIDER_ELEVENLABS


def is_valid_provider(provider: Optional[str]) -> bool:
    return not provider or provider.strip() in PROVIDERS


def models(provider: Optional[str] = None) -> list:
    """The models a provider can synthesize with."""
    if (provider or default_provider()) == PROVIDER_FISH_AUDIO:
        return list(fish_audio.FISH_AUDIO_MODELS)
    return list(ELEVENLABS_MODELS)


def default_model(provider: Optional[str] = None) -> str:
    if (provider or default_provider()) == PROVIDER_FISH_AUDIO:
        return fish_audio.default_model()
    return (os.environ.get("ELEVENLABS_MODEL") or DEFAULT_ELEVENLABS_MODEL).strip()


def voices(provider: Optional[str] = None, api_key: Optional[str] = None) -> list:
    """The voices available for synthesis, in the shape the dashboard renders.

    Both providers are normalized to the same keys: ``voice_id``, ``name``,
    ``category`` and ``labels`` (the dict the voice list filters on).
    """
    if (provider or default_provider()) == PROVIDER_FISH_AUDIO:
        return _fish_voices(api_key)
    return _elevenlabs_voices(api_key)


def _elevenlabs_voices(api_key: Optional[str]) -> list:
    """ElevenLabs' own voice list, unchanged in shape."""
    from saasshorts import get_elevenlabs_voices
    if not api_key:
        return []
    try:
        return get_elevenlabs_voices(api_key)
    except Exception as e:
        print(f"[TTS] ElevenLabs voice list failed: {e}")
        return []


def _fish_voices(api_key: Optional[str]) -> list:
    """Fish Audio's voice library, mapped onto the shared shape.

    Fish Audio has no gender/accent fields the way ElevenLabs does, so the
    voice's own tags carry them: a clone tagged "male" reads as a male voice
    in the dashboard's filters.
    """
    if not api_key:
        return []
    try:
        raw = fish_audio.list_voices(api_key)
    except Exception as e:
        print(f"[TTS] Fish Audio voice list failed: {e}")
        return []

    voices_out = []
    for v in raw:
        tags = v.get("tags") or []
        if isinstance(tags, str):
            tags = [t.strip() for t in tags.split(",") if t.strip()]
        tags = [str(t).lower() for t in tags]
        labels = {"language": v.get("language") or ""}
        for t in tags:
            if t in ("male", "female", "man", "woman"):
                labels["gender"] = "male" if t in ("male", "man") else "female"
                break
        voices_out.append({
            "voice_id": v["voice_id"],
            "name": v.get("name") or v["voice_id"],
            "category": "fish_audio",
            "labels": labels,
            "description": v.get("description") or "",
            "preview_url": "",
        })
    return voices_out


def synthesize(text: str, output_path: str, provider: Optional[str] = None,
               api_key: Optional[str] = None, voice_id: Optional[str] = None,
               model: Optional[str] = None) -> str:
    """Turn ``text`` into an audio file at ``output_path``.

    ``voice_id`` is the provider's own id (an ElevenLabs voice_id, a Fish
    Audio reference_id). ``model`` is the provider's model id.
    """
    chosen = (provider or default_provider()).strip()
    if chosen == PROVIDER_FISH_AUDIO:
        if not api_key:
            raise Exception("Fish Audio needs an API key (X-Fish-Audio-Key).")
        return fish_audio.generate_speech(
            text, api_key, output_path,
            model=model or fish_audio.default_model(),
            reference_id=voice_id or None,
        )
    if not api_key:
        raise Exception("ElevenLabs needs an API key (X-ElevenLabs-Key).")
    from saasshorts import generate_voiceover as _elevenlabs_voiceover
    return _elevenlabs_voiceover(text, api_key, output_path,
                                 voice_id=voice_id or "21m00Tcm4TlvDq8ikWAM",
                                 model_id=model or DEFAULT_ELEVENLABS_MODEL)
