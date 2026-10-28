"""Text-only LLM calls, routed to the provider the user picked.

Two providers answer the pipeline's text stages: Google's **Gemini** and
**DeepSeek**'s OpenAI-compatible chat API. Both take a prompt that ends in
"answer with one JSON object", so this module is the single place that
decides which one a text stage talks to.

What does *not* come here: the frame-based stages (layout picker, screen
detector, hook grounding, burned-in subtitles) and the video stages (AI
editor, silent-video clipping). They need a model that can look at the
footage, so they go through :func:`vision_json` instead — which prefers
Gemini, and falls back to DeepSeek's Flash model, whose image
understanding is documented at https://api-docs.deepseek.com/guides/vision.
The stages that upload the whole video still need Gemini, because DeepSeek
takes pictures, not video files.

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


def vision_json(prompt: str, images=None, schema=None, provider_name: Optional[str] = None,
                blocks=None):
    """One JSON answer to ``prompt`` from a model that can see the pictures.

    ``images`` is a list of ``(data, mime_type)`` pairs — JPEG frames.
    ``blocks`` is the more general form: a list of ``("image", data, mime)``
    and ``("text", str)`` tuples, for a stage that labels its frames. Give
    one or the other.

    Gemini is preferred: it reads the frames natively. Without a Gemini key
    the call goes to DeepSeek's Flash model instead, which takes pictures
    through the same OpenAI-compatible chat API. Returns ``(parsed, cost)``,
    the same shape as :func:`generate_json`, so a caller does not branch on
    which model looked at the footage.

    Raises when neither provider can look at the pictures.
    """
    chosen = (provider_name or provider()).lower()
    if blocks is None:
        blocks = [("image", data, mime_type) for data, mime_type in (images or [])]
    key = gemini_key()
    if key:
        return _gemini_vision_json(prompt, blocks, schema, key), None
    # A DeepSeek key means the Flash model, whichever provider would otherwise
    # answer: a local OpenAI-compatible server on LLM_BASE_URL is usually a
    # text model, and sending it pictures would fail on the request rather
    # than on the answer.
    if deepseek_key():
        return llm_backend.generate_json_with_blocks(
            prompt, blocks, schema, key=deepseek_key(),
            provider_name=PROVIDER_DEEPSEEK)
    if chosen in (PROVIDER_DEEPSEEK, PROVIDER_OPENAI):
        return llm_backend.generate_json_with_blocks(
            prompt, blocks, schema, key=deepseek_key() or None,
            provider_name=chosen)
    raise RuntimeError(
        "No key for a model that can look at the footage: set GEMINI_API_KEY, "
        "or DEEPSEEK_API_KEY for the Flash model (which takes pictures).")


def _gemini_vision_json(prompt: str, blocks, schema, api_key: str):
    """The Gemini branch: the frames go in as native parts."""
    import gemini_worker
    from google import genai
    from google.genai import types as genai_types

    client = genai.Client(api_key=api_key)
    parts = []
    for block in blocks:
        if block[0] == "text":
            parts.append(block[1])
            continue
        _, data, mime_type = block
        parts.append(genai_types.Part.from_bytes(data=data, mime_type=mime_type))
    config_kwargs = {"response_mime_type": "application/json"}
    if schema is not None:
        config_kwargs["response_schema"] = schema
    response = client.models.generate_content(
        model=os.environ.get("GEMINI_MODEL") or "gemini-3.1-flash-lite",
        contents=parts + [prompt],
        config=genai_types.GenerateContentConfig(**config_kwargs),
    )
    gemini_worker.raise_if_blocked(response)
    parsed = getattr(response, "parsed", None)
    if parsed is not None:
        return parsed.model_dump() if hasattr(parsed, "model_dump") else parsed
    return llm_backend.parse_json_value(gemini_worker._get_response_text(response))


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
