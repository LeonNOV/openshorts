"""Text-only LLM calls, routed to the provider the user picked.

Two providers answer the pipeline's text stages: Google's **Gemini** and
**DeepSeek**'s OpenAI-compatible chat API. Both take a prompt that ends in
"answer with one JSON object", so this module is the single place that
decides which one a text stage talks to.

What does *not* come here: the frame-based stages (layout picker, screen
detector, hook grounding, burned-in subtitles) and the video stages (AI
editor, silent-video clipping). They need a model that can look at the
footage, which only Gemini does — they keep calling Gemini directly, and
degrade to their documented fallbacks when there is no Gemini key.

Selection, in order of precedence:

1. ``LLM_PROVIDER=deepseek`` (plus ``DEEPSEEK_API_KEY``) — server-wide.
2. A ``X-DeepSeek-Key`` request header — per request, which is how the
   dashboard hands a user's own key to the backend.
3. Otherwise Gemini.

The local/OpenAI-compatible server (``LLM_BASE_URL``) stays where it was:
``llm_backend`` owns that transport, and this module defers to it.
"""
from __future__ import annotations

import os
from typing import Optional, Tuple

import llm_backend

PROVIDER_GEMINI = llm_backend.PROVIDER_GEMINI
PROVIDER_DEEPSEEK = llm_backend.PROVIDER_DEEPSEEK
PROVIDER_OPENAI = llm_backend.PROVIDER_OPENAI


def provider() -> str:
    """The provider that answers text stages right now."""
    return llm_backend.provider()


def deepseek_key() -> str:
    return llm_backend.deepseek_api_key()


def gemini_key() -> Optional[str]:
    return (os.environ.get("GEMINI_API_KEY") or "").strip() or None


def generate_json(prompt: str, api_key: Optional[str] = None,
                  provider_name: Optional[str] = None):
    """One JSON answer to ``prompt``.

    Returns ``(parsed, cost)``. ``parsed`` is whatever the prompt asked for:
    an object or an array. ``cost`` is ``None`` for Gemini, which reports its
    own usage in the caller's own accounting path.
    """
    chosen = (provider_name or provider()).lower()
    if chosen in (PROVIDER_DEEPSEEK, PROVIDER_OPENAI):
        # llm_backend owns the OpenAI-compatible transport (DeepSeek, local
        # server) and already parses and validates the answer.
        return llm_backend.generate_json(prompt, None, key=api_key or None,
                                         provider_name=chosen)
    return _gemini_json(prompt, api_key), None


def _gemini_json(prompt: str, api_key: Optional[str]):
    """The Gemini branch: one JSON value, parsed with the shared repair."""
    import gemini_worker
    from google import genai
    from google.genai import types as genai_types

    client = genai.Client(api_key=api_key or gemini_key())
    response = client.models.generate_content(
        model=os.environ.get("GEMINI_MODEL") or "gemini-3.1-flash-lite",
        contents=[prompt],
        config=genai_types.GenerateContentConfig(response_mime_type="application/json"),
    )
    gemini_worker.raise_if_blocked(response)
    parsed_obj = getattr(response, "parsed", None)
    if parsed_obj is not None:
        return parsed_obj.model_dump() if hasattr(parsed_obj, "model_dump") else parsed_obj
    return llm_backend.parse_json_value(gemini_worker._get_response_text(response))


TRANSLATE_PROMPT = """You translate video narration into {language}.

Translate every line into {language}. Keep the meaning, the register and the
punch: this is spoken video, so the translation has to sound like something a
person says, not a document. Keep numbers, product names and brand names as
they are. Do not add commentary, do not merge lines, do not drop lines.

Return a JSON array of {count} strings — one translation per input line, in
the same order."""


def translate(texts: list, target_language: str, api_key: Optional[str] = None,
              provider_name: Optional[str] = None) -> list:
    """Translate a list of lines into ``target_language``.

    Returns one translated string per input line, in the same order. Used by
    the Fish Audio dubbing path, which has to translate the transcript itself
    because Fish Audio synthesizes speech from text rather than dubbing a
    video.
    """
    if not texts:
        return []
    lines = "\n".join(f"{i}: {t}" for i, t in enumerate(texts))
    prompt = (TRANSLATE_PROMPT
              .replace("{language}", target_language)
              .replace("{count}", str(len(texts)))
              + f"\n\nLINES:\n{lines}")
    parsed, _cost = generate_json(prompt, api_key=api_key, provider_name=provider_name)
    if isinstance(parsed, dict):
        # A model that answered with an object instead of the array asked for.
        for key in ("translations", "lines", "result", "results"):
            if isinstance(parsed.get(key), list):
                parsed = parsed[key]
                break
    if not isinstance(parsed, list):
        raise Exception("The model did not return a JSON array of translations")
    if len(parsed) != len(texts):
        raise Exception(
            f"The model returned {len(parsed)} translations for {len(texts)} lines")
    return [str(t) for t in parsed]
