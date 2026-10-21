"""Text-only LLM backends for the pipeline: Gemini, DeepSeek, or any
OpenAI-compatible server.

Three providers answer the pipeline's text prompts:

* ``gemini`` (default) — Google's models.
* ``deepseek`` — DeepSeek's OpenAI-compatible chat API. Cheap, fast, and
  text-only, so it takes over the text stages when it is configured.
* ``openai`` — any other OpenAI-compatible server (Ollama, LM Studio, vLLM,
  llama.cpp's server, LocalAI, OpenRouter).

``LLM_PROVIDER`` picks one explicitly. Without it the module picks
``openai`` when ``LLM_BASE_URL`` is set and ``deepseek`` when
``DEEPSEEK_API_KEY`` is, and falls back to ``gemini``.

What stays on Gemini, because it needs a model that can look at frames or
a video file: the layout picker (``layout_picker.py``), the on-screen content
detector (``screencast_layout.py``) and the silent-video path
(``main.get_visual_clips``). Without a Gemini key those degrade the way they
already did: the first two return "none", the third fails the job with a
clear message. Nothing in this module is imported by them.

Structured output: the prompts already spell out the exact JSON shape, so a
plain ``json_object`` mode is enough for most models. The request first asks
for ``json_schema`` (Ollama, vLLM, llama.cpp and LM Studio enforce it); a
server that rejects that field gets the same request again with
``json_object``, then with no ``response_format`` at all. Whatever comes back
is validated with the same pydantic model Gemini's ``response_schema`` uses,
so ``main.py`` sees one shape regardless of provider.
"""
from __future__ import annotations

import json
import os
from typing import Optional, Tuple, Type

import httpx
from pydantic import BaseModel

from clip_selection import DEEPSEEK_MODEL_PRICES

PROVIDER_GEMINI = "gemini"
PROVIDER_DEEPSEEK = "deepseek"
PROVIDER_OPENAI = "openai"

DEFAULT_MODEL = "llama3.1:8b"
DEFAULT_TIMEOUT = 600.0  # local models on CPU are slow; a scoring batch can take minutes

# DeepSeek's OpenAI-compatible endpoint. The "/v1" suffix also works but has no
# relation to the model version, so the plain host is what the docs use.
DEEPSEEK_BASE_URL = "https://api.deepseek.com"
# "deepseek-chat" and "deepseek-reasoner" were retired on 2026-07-24; the V4
# pair is what the API serves now.
DEEPSEEK_DEFAULT_MODEL = "deepseek-v4-flash"
# The detail pass writes one JSON object per clip; the ceiling has to leave
# room for the answer itself.
DEEPSEEK_MAX_TOKENS = 16384


def _raw_base_url() -> str:
    """``LLM_BASE_URL`` exactly as configured (an OpenAI-compatible server)."""
    return (os.environ.get("LLM_BASE_URL") or "").strip().rstrip("/")


def deepseek_api_key() -> str:
    return (os.environ.get("DEEPSEEK_API_KEY") or "").strip()


def provider() -> str:
    """``"deepseek"``, ``"openai"`` (a local/compatible server) or ``"gemini"``."""
    explicit = (os.environ.get("LLM_PROVIDER") or "").strip().lower()
    if explicit in ("openai", "ollama", "local", "openai-compatible"):
        return PROVIDER_OPENAI
    if explicit == "deepseek":
        return PROVIDER_DEEPSEEK
    if explicit == "gemini":
        return PROVIDER_GEMINI
    if _raw_base_url():
        return PROVIDER_OPENAI
    if deepseek_api_key():
        return PROVIDER_DEEPSEEK
    return PROVIDER_GEMINI


def settings(provider_name: Optional[str] = None) -> dict:
    """``base_url`` / ``model`` / ``api_key`` for one provider.

    ``api_key`` is empty for a local OpenAI-compatible server: Ollama ignores
    it and the OpenAI client convention (and vLLM with --api-key) only wants
    the header present.
    """
    p = (provider_name or provider()).lower()
    if p == PROVIDER_DEEPSEEK:
        return {
            "provider": PROVIDER_DEEPSEEK,
            "base_url": (os.environ.get("DEEPSEEK_BASE_URL") or DEEPSEEK_BASE_URL).strip().rstrip("/"),
            "model": (os.environ.get("DEEPSEEK_MODEL") or DEEPSEEK_DEFAULT_MODEL).strip(),
            "api_key": deepseek_api_key(),
        }
    if p == PROVIDER_OPENAI:
        return {
            "provider": PROVIDER_OPENAI,
            "base_url": _raw_base_url(),
            "model": (os.environ.get("LLM_MODEL") or "").strip() or DEFAULT_MODEL,
            "api_key": (os.environ.get("LLM_API_KEY") or "").strip(),
        }
    return {
        "provider": PROVIDER_GEMINI,
        "base_url": "",
        "model": (os.environ.get("GEMINI_MODEL") or "").strip() or "gemini-3.1-flash-lite",
        "api_key": (os.environ.get("GEMINI_API_KEY") or "").strip(),
    }


def base_url() -> str:
    """The OpenAI-compatible base URL the active provider talks to."""
    return settings()["base_url"]


def api_key() -> str:
    """The key the active provider authenticates with (empty for local servers)."""
    return settings()["api_key"]


def model_name() -> str:
    return settings()["model"]


def active() -> bool:
    """True when the moment picker should call the OpenAI-compatible server."""
    p = provider()
    if p == PROVIDER_GEMINI:
        return False
    if p == PROVIDER_DEEPSEEK:
        return bool(api_key())
    return bool(base_url())


def describe() -> Optional[dict]:
    """What ``/api/config`` tells the dashboard, or ``None`` when inactive."""
    if not active():
        return None
    s = settings()
    return {"provider": s["provider"], "model": s["model"], "baseUrl": s["base_url"]}


def _timeout() -> float:
    try:
        return float(os.environ.get("LLM_TIMEOUT") or DEFAULT_TIMEOUT)
    except ValueError:
        return DEFAULT_TIMEOUT


def _headers(key: Optional[str] = None) -> dict:
    # Ollama ignores the key but the OpenAI client convention (and vLLM with
    # --api-key) wants the header present; "ollama" is the documented placeholder.
    resolved = (key if key is not None else api_key()) or "ollama"
    return {"Authorization": f"Bearer {resolved}", "Content-Type": "application/json"}


def _client(**kwargs) -> httpx.Client:
    """Factory so tests can swap in ``httpx.MockTransport``."""
    return httpx.Client(timeout=_timeout(), **kwargs)


def _response_formats(schema: Optional[Type[BaseModel]], provider_name: str):
    """The ``response_format`` flavours to try, best first.

    A provider that only documents JSON mode (DeepSeek) is asked for
    ``json_object`` right away; the others are asked for the stricter
    ``json_schema`` first because it is enforced server-side.
    """
    if schema is None:
        yield {"type": "json_object"}
        yield None
        return
    name = getattr(schema, "__name__", "response").lower()
    json_schema = {"type": "json_schema",
                   "json_schema": {"name": name, "schema": schema.model_json_schema()}}
    if provider_name == PROVIDER_DEEPSEEK:
        yield {"type": "json_object"}
        yield json_schema
    else:
        yield json_schema
        yield {"type": "json_object"}
    yield None


def _is_format_rejection(resp: httpx.Response) -> bool:
    if resp.status_code not in (400, 422):
        return False
    body = resp.text.lower()
    return "response_format" in body or "json_schema" in body or "json_object" in body \
        or "format" in body


def _json_nudge(prompt: str) -> str:
    """DeepSeek's JSON mode refuses a prompt that never says "json"."""
    if "json" in prompt.lower():
        return prompt
    return prompt + "\n\nAnswer with a single valid JSON object and nothing else."


def _message_text(msg: dict) -> str:
    """The assistant's answer, falling back to the reasoning trace.

    DeepSeek's V4 models can reason before answering, so a truncated budget
    can leave ``content`` empty while ``reasoning_content`` still holds the
    JSON.
    """
    text = msg.get("content") or ""
    if isinstance(text, list):  # some servers return content parts
        text = "".join(p.get("text", "") for p in text if isinstance(p, dict))
    if not text:
        text = msg.get("reasoning_content") or ""
    return text


def _body_for(prompt: str, model: str, provider_name: str, fmt: Optional[dict]) -> dict:
    """The request body for one attempt at a completion."""
    messages = [
        {"role": "system", "content": "You answer with a single JSON object and nothing else."},
        {"role": "user", "content": prompt},
    ]
    body = {"model": model, "messages": messages, "temperature": 0.2, "stream": False}
    if provider_name == PROVIDER_DEEPSEEK:
        body["max_tokens"] = DEEPSEEK_MAX_TOKENS
        # DeepSeek reasons before it answers, and the trace is billed as output
        # tokens. For a structured answer the trace is latency for nothing, so
        # it is turned off — but only on the models that accept the toggle.
        if _supports_thinking(model):
            body["thinking"] = {"type": "disabled"}
        if fmt is not None and fmt.get("type") == "json_object":
            body["messages"] = [messages[0],
                                {"role": "user", "content": _json_nudge(prompt)}]
    if fmt is not None:
        body["response_format"] = fmt
    return body


def _supports_thinking(model: str) -> bool:
    """True for the V4 models, which take the ``thinking`` toggle.

    The retired ``deepseek-chat``/``deepseek-reasoner`` names do not know the
    field and answer 400 when it is sent.
    """
    name = (model or "").lower()
    return name.startswith("deepseek-v4") or name.startswith("deepseek-flash") \
        or name.startswith("deepseek-pro")


def _rejects_field(resp: httpx.Response, field: str) -> bool:
    """True when the server refused the request over one unknown field."""
    if resp.status_code not in (400, 422):
        return False
    body = resp.text.lower()
    return field in body and ("unknown" in body or "not supported" in body
                              or "unrecognized" in body or "invalid" in body)


def _cost(model: str, provider_name: str, usage: dict) -> dict:
    """Token counts and their price, in the shape the dashboard expects."""
    input_tokens = int(usage.get("prompt_tokens") or 0)
    output_tokens = int(usage.get("completion_tokens") or 0)
    prices = DEEPSEEK_MODEL_PRICES.get(model.lower()) if provider_name == PROVIDER_DEEPSEEK else None
    price_estimated = provider_name == PROVIDER_DEEPSEEK and prices is None
    if prices is None:
        prices = (0.0, 0.0)
    input_cost = (input_tokens / 1_000_000) * prices[0]
    output_cost = (output_tokens / 1_000_000) * prices[1]
    return {
        "input_tokens": input_tokens,
        "output_tokens": output_tokens,
        "thinking_tokens": 0,
        "input_cost": input_cost,
        "output_cost": output_cost,
        "total_cost": input_cost + output_cost,
        "model": model,
        "price_estimated": price_estimated,
        # Only a self-hosted server is free; DeepSeek bills per token.
        "local": provider_name == PROVIDER_OPENAI,
    }


def _rejects_max_tokens(resp: httpx.Response) -> bool:
    """True when the server refused the request over ``max_tokens`` alone."""
    if resp.status_code not in (400, 422):
        return False
    body = resp.text.lower()
    return "max_tokens" in body and "max_completion_tokens" in body


def _truncated(data: dict) -> bool:
    """True when the model stopped because it ran out of output tokens.

    A truncated answer can still be valid JSON (the object closed before the
    cut) while missing fields, so it must not be accepted silently.
    """
    for choice in (data.get("choices") or []):
        if str(choice.get("finish_reason") or "") == "length":
            return True
    return False


def _strip_code_fences(text: str) -> str:
    """Remove a ```json ... ``` wrapper, if the model added one."""
    text = (text or "").strip()
    if text.startswith("```"):
        lines = text.splitlines()
        if lines:
            lines = lines[1:]
        if lines and lines[-1].strip() == "```":
            lines = lines[:-1]
        text = "\n".join(lines).strip()
    return text


def parse_json_value(text: str):
    """Parse a JSON object OR array out of a model's answer.

    The schema-less path needs both shapes: the SaaS analysis answers with an
    object, the script generator answers with an array. The repair is the same
    one ``gemini_worker`` uses — drop a code fence, then take the outermost
    braces or brackets.
    """
    cleaned = _strip_code_fences(text)
    if not cleaned:
        raise ValueError("LLM returned an empty response body.")
    starts = [i for i in (cleaned.find("{"), cleaned.find("[")) if i != -1]
    ends = [i for i in (cleaned.rfind("}"), cleaned.rfind("]")) if i != -1]
    if starts and ends and max(ends) > min(starts):
        cleaned = cleaned[min(starts):max(ends) + 1]
    try:
        return json.loads(cleaned)
    except json.JSONDecodeError as e:
        raise ValueError(f"Failed to parse LLM JSON response: {e}")


def generate_json(prompt: str, schema: Optional[Type[BaseModel]] = None,
                  model: Optional[str] = None, key: Optional[str] = None,
                  provider_name: Optional[str] = None,
                  ) -> Tuple[dict, Optional[dict]]:
    """One chat completion that must come back as JSON.

    Returns ``(parsed_dict, cost_analysis)`` in the exact shape
    ``main._run_gemini_stage`` returns, so the caller does not branch on the
    provider. Raises on HTTP errors, empty bodies and schema violations; the
    retry policy lives in the caller, same as for Gemini.

    ``schema`` is optional: without one the answer is parsed as plain JSON
    and not validated against a pydantic model. ``provider_name`` overrides
    the environment, which is how a request-scoped key (the dashboard's
    ``X-DeepSeek-Key``) talks to a provider the server itself never configured.
    """
    import gemini_worker  # local import: keeps this module free of the google SDK

    s = settings(provider_name)
    provider_name = s["provider"]
    url = f"{s['base_url']}/chat/completions"
    model = model or s["model"]
    auth = key if key is not None else s["api_key"]
    last_rejection: Optional[str] = None
    with _client() as client:
        for fmt in _response_formats(schema, provider_name):
            body = _body_for(prompt, model, provider_name, fmt)
            resp = client.post(url, json=body, headers=_headers(auth))
            if resp.status_code >= 400 and _rejects_max_tokens(resp):
                # One deployment answers 400 to max_tokens; the field is
                # optional, so the request goes again without it.
                body.pop("max_tokens", None)
                resp = client.post(url, json=body, headers=_headers(auth))
            if resp.status_code >= 400 and _rejects_field(resp, "thinking"):
                # The retired model names do not know the toggle.
                body.pop("thinking", None)
                resp = client.post(url, json=body, headers=_headers(auth))
            if fmt is not None and _is_format_rejection(resp):
                # The server does not know this response_format flavour; the
                # next loop iteration asks for a looser one.
                last_rejection = resp.text[:200]
                continue
            if resp.status_code >= 400:
                raise RuntimeError(
                    f"LLM server {resp.status_code} from {url}: {resp.text[:300]}")
            data = resp.json()
            break
        else:
            raise RuntimeError(
                f"LLM server rejected every response_format variant: {last_rejection}")

    if _truncated(data):
        raise RuntimeError(
            f"LLM server ran out of output tokens on {model}; the answer was cut short.")

    choices = data.get("choices") or []
    text = ""
    if choices:
        msg = choices[0].get("message") or {}
        text = _message_text(msg)
    usage = data.get("usage") or {}
    if schema is None:
        # No schema: the answer may be an object or an array, and the caller
        # knows which it asked for.
        return parse_json_value(text), _cost(model, provider_name, usage)
    parsed = gemini_worker._parse_json_response_text(text)
    # Validate against the same schema Gemini enforces server-side, so a
    # small model that drops a field fails here with a readable error
    # (retried by the caller) instead of deep inside the clip pipeline.
    parsed = schema.model_validate(parsed).model_dump()

    return parsed, _cost(model, provider_name, usage)
