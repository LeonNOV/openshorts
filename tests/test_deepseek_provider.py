"""DeepSeek as the pipeline's text LLM (llm_backend.py / llm_provider.py).

DeepSeek speaks the OpenAI chat-completions protocol, so it reuses the
transport llm_backend already had for a local server. What is new: the
provider is a first-class choice, the request can carry its own key, and
the answer is validated the same way Gemini's is.
"""
import json

import httpx
import pytest

import gemini_worker
import llm_backend
import llm_provider


@pytest.fixture
def deepseek(monkeypatch):
    monkeypatch.setenv("LLM_PROVIDER", "deepseek")
    monkeypatch.setenv("DEEPSEEK_API_KEY", "sk-test")
    monkeypatch.setenv("DEEPSEEK_MODEL", "deepseek-v4-flash")
    monkeypatch.delenv("LLM_BASE_URL", raising=False)
    monkeypatch.delenv("LLM_API_KEY", raising=False)
    monkeypatch.delenv("LLM_MODEL", raising=False)


def _serve(handler, monkeypatch):
    transport = httpx.MockTransport(handler)
    monkeypatch.setattr(llm_backend, "_client",
                        lambda **kw: httpx.Client(transport=transport, **kw))


def _completion(payload, usage=None, content=None):
    body = {"windows": [{"id": "w0", "start": 0, "end": 90, "score": 88, "reason": "hook"}]}
    return httpx.Response(200, json={
        "choices": [{"message": {"role": "assistant",
                                 "content": content if content is not None else json.dumps(payload)}}],
        "usage": usage or {"prompt_tokens": 120, "completion_tokens": 40},
    })


# --- provider selection ---------------------------------------------------

def test_deepseek_is_the_provider_when_its_key_is_set(deepseek):
    assert llm_backend.provider() == "deepseek"
    assert llm_backend.active() is True
    assert llm_backend.base_url() == "https://api.deepseek.com"
    assert llm_backend.model_name() == "deepseek-v4-flash"


def test_the_key_activates_it_without_an_explicit_provider(monkeypatch):
    monkeypatch.delenv("LLM_PROVIDER", raising=False)
    monkeypatch.delenv("LLM_BASE_URL", raising=False)
    monkeypatch.setenv("DEEPSEEK_API_KEY", "sk-test")
    assert llm_backend.provider() == "deepseek"
    assert llm_backend.active() is True


def test_a_local_server_still_wins_over_the_deepseek_key(monkeypatch):
    """LLM_BASE_URL is an explicit self-host choice; it must not be
    shadowed by a DeepSeek key that happens to be in the environment."""
    monkeypatch.delenv("LLM_PROVIDER", raising=False)
    monkeypatch.setenv("LLM_BASE_URL", "http://llm.test/v1")
    monkeypatch.setenv("DEEPSEEK_API_KEY", "sk-test")
    assert llm_backend.provider() == "openai"


def test_gemini_is_the_default_without_any_configuration(monkeypatch):
    for name in ("LLM_PROVIDER", "LLM_BASE_URL", "DEEPSEEK_API_KEY"):
        monkeypatch.delenv(name, raising=False)
    assert llm_backend.provider() == "gemini"
    assert llm_backend.active() is False
    assert llm_backend.describe() is None


def test_describe_reports_the_deepseek_provider(deepseek):
    assert llm_backend.describe() == {
        "provider": "deepseek",
        "model": "deepseek-v4-flash",
        "baseUrl": "https://api.deepseek.com",
    }


# --- the request itself ----------------------------------------------------

def test_the_request_carries_the_model_in_the_body_and_the_key_in_the_header(deepseek, monkeypatch):
    seen = {}

    def handler(request):
        seen["url"] = str(request.url)
        seen["body"] = json.loads(request.content)
        seen["auth"] = request.headers.get("authorization")
        return _completion({"windows": [{"id": "w0", "start": 0, "end": 90, "score": 88, "reason": "hook"}]})

    _serve(handler, monkeypatch)
    parsed, cost = llm_backend.generate_json("prompt", gemini_worker.ScoreResponse)

    assert seen["url"] == "https://api.deepseek.com/chat/completions"
    assert seen["body"]["model"] == "deepseek-v4-flash"
    assert seen["auth"] == "Bearer sk-test"
    assert parsed["windows"][0]["score"] == 88
    assert cost["model"] == "deepseek-v4-flash"


def test_json_mode_is_asked_for_first_and_the_thinking_trace_is_off(deepseek, monkeypatch):
    seen = {}

    def handler(request):
        seen["body"] = json.loads(request.content)
        return _completion({"windows": []})

    _serve(handler, monkeypatch)
    llm_backend.generate_json("prompt", gemini_worker.ScoreResponse)

    assert seen["body"]["response_format"]["type"] == "json_object"
    assert seen["body"]["thinking"] == {"type": "disabled"}


def test_a_prompt_without_the_word_json_is_nudged(deepseek, monkeypatch):
    seen = {}

    def handler(request):
        seen["body"] = json.loads(request.content)
        return _completion({"windows": []})

    _serve(handler, monkeypatch)
    llm_backend.generate_json("pick the clips", gemini_worker.ScoreResponse)

    assert "json" in seen["body"]["messages"][-1]["content"].lower()


def test_a_request_scoped_key_overrides_the_environment(deepseek, monkeypatch):
    """The dashboard hands the user's own DeepSeek key in a header, so the
    transport has to use it rather than the server's key."""
    seen = {}

    def handler(request):
        seen["auth"] = request.headers.get("authorization")
        return _completion({"windows": []})

    _serve(handler, monkeypatch)
    llm_backend.generate_json("prompt", None, key="sk-user")

    assert seen["auth"] == "Bearer sk-user"


def test_a_request_can_name_the_provider_outright(deepseek, monkeypatch):
    """A request that names DeepSeek talks to DeepSeek even when the
    server has no DeepSeek key configured at all."""
    monkeypatch.delenv("DEEPSEEK_API_KEY", raising=False)
    seen = {}

    def handler(request):
        seen["url"] = str(request.url)
        return _completion({"windows": []})

    _serve(handler, monkeypatch)
    llm_backend.generate_json("prompt", None, key="sk-user",
                              provider_name=llm_backend.PROVIDER_DEEPSEEK)

    assert seen["url"] == "https://api.deepseek.com/chat/completions"


def test_the_answer_is_validated_against_the_schema(deepseek, monkeypatch):
    """A missing field must fail here, not deep inside the pipeline."""
    _serve(lambda r: _completion({"windows": [{"id": "w0"}]}), monkeypatch)
    with pytest.raises(Exception) as exc:
        llm_backend.generate_json("prompt", gemini_worker.ScoreResponse)
    assert "validation error" in str(exc.value)


def test_a_truncated_answer_is_refused(deepseek, monkeypatch):
    """finish_reason=length means the JSON may be cut mid-object, so it
    must not be accepted silently."""
    def handler(request):
        resp = _completion({"windows": []})
        data = json.loads(resp.text)
        data["choices"][0]["finish_reason"] = "length"
        return httpx.Response(200, json=data)

    _serve(handler, monkeypatch)
    with pytest.raises(Exception) as exc:
        llm_backend.generate_json("prompt", gemini_worker.ScoreResponse)
    assert "ran out of output tokens" in str(exc.value)


def test_the_reasoning_trace_is_used_when_the_answer_is_empty(deepseek, monkeypatch):
    """DeepSeek reasons before it answers; a tight budget can leave
    content empty while the trace still holds the JSON."""
    def handler(request):
        return httpx.Response(200, json={
            "choices": [{"message": {"content": "",
                                     "reasoning_content": json.dumps({"windows": []})}}],
            "usage": {},
        })

    _serve(handler, monkeypatch)
    parsed, _cost = llm_backend.generate_json("prompt", gemini_worker.ScoreResponse)
    assert parsed == {"windows": []}


def test_the_cost_is_priced_per_token_not_free(deepseek, monkeypatch):
    """A hosted provider bills; a local server does not."""
    _serve(lambda r: _completion({"windows": []},
                                 usage={"prompt_tokens": 1_000_000, "completion_tokens": 1_000_000}),
           monkeypatch)
    _parsed, cost = llm_backend.generate_json("prompt", gemini_worker.ScoreResponse)

    assert cost["local"] is False
    assert cost["input_cost"] == pytest.approx(0.14)
    assert cost["output_cost"] == pytest.approx(0.28)
    assert cost["total_cost"] == pytest.approx(0.42)


def test_a_local_server_is_still_reported_as_free(monkeypatch):
    monkeypatch.setenv("LLM_PROVIDER", "openai")
    monkeypatch.setenv("LLM_BASE_URL", "http://llm.test/v1")
    monkeypatch.setenv("LLM_API_KEY", "ollama")
    _serve(lambda r: _completion({"windows": []}), monkeypatch)
    _parsed, cost = llm_backend.generate_json("prompt", gemini_worker.ScoreResponse)
    assert cost["local"] is True
    assert cost["total_cost"] == 0.0


# --- the provider facade ---------------------------------------------------

def test_the_facade_routes_to_deepseek(deepseek, monkeypatch):
    seen = {}

    def handler(request):
        seen["url"] = str(request.url)
        return _completion({"ok": True})

    _serve(handler, monkeypatch)
    parsed, _cost = llm_provider.generate_json("prompt", api_key="sk-user")
    assert seen["url"] == "https://api.deepseek.com/chat/completions"
    assert parsed == {"ok": True}


def test_the_facade_parses_an_array_answer(deepseek, monkeypatch):
    """The script generator asks for an array of scripts, not an object."""
    _serve(lambda r: _completion([{"title": "one"}, {"title": "two"}]), monkeypatch)
    parsed, _cost = llm_provider.generate_json("prompt")
    assert parsed == [{"title": "one"}, {"title": "two"}]


def test_the_facade_keeps_gemini_as_the_default(monkeypatch):
    for name in ("LLM_PROVIDER", "LLM_BASE_URL", "DEEPSEEK_API_KEY"):
        monkeypatch.delenv(name, raising=False)
    assert llm_provider.provider() == "gemini"
