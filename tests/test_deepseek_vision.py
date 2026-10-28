"""DeepSeek's image understanding, used for the frame-based stages.

DeepSeek's Flash model takes pictures through the same OpenAI-compatible
chat API the text stages use — see
https://api-docs.deepseek.com/guides/vision. The pipeline used to assume
that only Gemini could look at the footage, so a user with just a DeepSeek
key could not get through a silent video at all.

These tests pin down the request shape, because the failure mode is silent:
a wrong content-block shape comes back as a 400 that reads like a bad key.

Usage: python -m pytest tests/test_deepseek_vision.py -v
"""
import base64
import json
import os
import sys

import pytest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import llm_backend
import llm_provider


PNG = b"\x89PNG\r\n\x1a\n" + b"fake-pixels"
JPEG = b"\xff\xd8\xff\xe0" + b"fake-jpeg"


# --- the request body -------------------------------------------------------

def test_the_request_carries_the_pictures_as_image_url_blocks():
    body = llm_backend._body_for_images(
        "what is in these?",
        [("image", PNG, "image/png"), ("image", JPEG, "image/jpeg")],
        "deepseek-flash",
        llm_backend.PROVIDER_DEEPSEEK,
        None,
    )
    user = [m for m in body["messages"] if m["role"] == "user"][0]
    assert isinstance(user["content"], list), "the content must be a block list"
    kinds = [b["type"] for b in user["content"]]
    assert kinds == ["text", "image_url", "image_url"], kinds
    for block, mime in zip(user["content"][1:], ("image/png", "image/jpeg")):
        url = block["image_url"]["url"]
        assert url.startswith(f"data:{mime};base64,"), url[:40]
        raw = base64.b64decode(url.split(",", 1)[1])
        assert raw == (PNG if mime == "image/png" else JPEG)


def test_the_pictures_only_ever_go_in_the_user_message():
    # DeepSeek answers 400 when a system or assistant message carries an
    # image, so the system message has to stay plain text.
    body = llm_backend._body_for_images(
        "prompt", [("image", PNG, "image/png")],
        "deepseek-flash", llm_backend.PROVIDER_DEEPSEEK, None)
    for message in body["messages"]:
        if message["role"] != "user":
            assert isinstance(message["content"], str), message["role"]


def test_text_blocks_can_be_interleaved_with_pictures():
    # The screen check labels each frame with the shot it belongs to.
    body = llm_backend._body_for_images(
        "prompt",
        [("text", "Shot 0:"), ("image", JPEG, "image/jpeg"),
         ("text", "Shot 1:"), ("image", JPEG, "image/jpeg")],
        "deepseek-flash", llm_backend.PROVIDER_DEEPSEEK, None)
    user = [m for m in body["messages"] if m["role"] == "user"][0]
    kinds = [b["type"] for b in user["content"]]
    assert kinds == ["text", "text", "image_url", "text", "image_url"], kinds
    assert user["content"][1]["text"] == "Shot 0:"


def test_a_vision_request_uses_the_flash_model():
    # The docs put image understanding on deepseek-flash; the text stages
    # use the V4 name, which is a different model.
    assert llm_backend.DEEPSEEK_VISION_MODEL == "deepseek-flash"
    s = llm_backend.settings(llm_backend.PROVIDER_DEEPSEEK)
    assert s["model"] != llm_backend.DEEPSEEK_VISION_MODEL, (
        "the text model and the vision model should not be the same name")


# --- the provider routing ---------------------------------------------------

def test_a_gemini_key_wins_over_deepseek(monkeypatch):
    monkeypatch.setenv("GEMINI_API_KEY", "g")
    monkeypatch.setenv("DEEPSEEK_API_KEY", "d")
    asked = {}

    def fake_gemini(prompt, blocks, schema, api_key):
        asked["blocks"] = blocks
        asked["api_key"] = api_key
        return {"ok": True}

    monkeypatch.setattr(llm_provider, "_gemini_vision_json", fake_gemini)
    monkeypatch.setattr(
        llm_backend, "generate_json_with_blocks",
        lambda *a, **k: (_ for _ in ()).throw(AssertionError("must not be asked")))
    answer, _ = llm_provider.vision_json("p", [(JPEG, "image/jpeg")])
    assert answer == {"ok": True}
    assert asked["api_key"] == "g"
    assert asked["blocks"] == [("image", JPEG, "image/jpeg")]


def test_without_a_gemini_key_the_frames_go_to_deepseek(monkeypatch):
    monkeypatch.delenv("GEMINI_API_KEY", raising=False)
    monkeypatch.setenv("DEEPSEEK_API_KEY", "d")
    called = {}

    def fake_blocks(prompt, blocks, schema=None, **kw):
        called["blocks"] = blocks
        called["model"] = kw.get("model")
        return {"ok": True}, None

    monkeypatch.setattr(llm_backend, "generate_json_with_blocks", fake_blocks)
    answer, _ = llm_provider.vision_json("p", [(JPEG, "image/jpeg")])
    assert answer == {"ok": True}
    assert called["blocks"] == [("image", JPEG, "image/jpeg")]
    assert called["model"] is None, "the transport picks the vision model itself"


def test_without_any_key_the_call_raises(monkeypatch):
    monkeypatch.delenv("GEMINI_API_KEY", raising=False)
    monkeypatch.delenv("DEEPSEEK_API_KEY", raising=False)
    monkeypatch.setenv("LLM_BASE_URL", "")
    with pytest.raises(RuntimeError) as exc:
        llm_provider.vision_json("p", [(JPEG, "image/jpeg")])
    assert "GEMINI_API_KEY" in str(exc.value)
    assert "DEEPSEEK_API_KEY" in str(exc.value)


# --- the stages that use it -------------------------------------------------

def test_the_layout_picker_runs_on_a_deepseek_key_alone(monkeypatch):
    import layout_picker

    monkeypatch.delenv("GEMINI_API_KEY", raising=False)
    monkeypatch.setenv("DEEPSEEK_API_KEY", "d")
    monkeypatch.setattr(layout_picker, "ENABLED", True)
    monkeypatch.setattr(layout_picker, "sample_frames", lambda *a, **k: [JPEG])
    asked = {}

    def fake(prompt, images=None, schema=None, **kw):
        asked["images"] = images
        return {"layout": "split"}, None

    monkeypatch.setattr(llm_provider, "vision_json", fake)
    assert layout_picker.pick("v.mp4", 30) == "split"
    assert asked["images"] == [(JPEG, "image/jpeg")]


def test_the_layout_picker_stays_out_of_the_way_without_any_key(monkeypatch):
    import layout_picker

    monkeypatch.delenv("GEMINI_API_KEY", raising=False)
    monkeypatch.delenv("DEEPSEEK_API_KEY", raising=False)
    monkeypatch.setattr(layout_picker, "ENABLED", True)
    monkeypatch.setattr(layout_picker, "sample_frames", lambda *a, **k: [JPEG])
    monkeypatch.setattr(
        llm_provider, "vision_json",
        lambda *a, **k: (_ for _ in ()).throw(AssertionError("must not be called")))
    assert layout_picker.pick("v.mp4", 30) == "none"


def test_the_burned_subtitle_check_runs_on_a_deepseek_key_alone(monkeypatch):
    import burned_subtitles

    monkeypatch.delenv("GEMINI_API_KEY", raising=False)
    monkeypatch.setenv("DEEPSEEK_API_KEY", "d")
    monkeypatch.setattr(burned_subtitles, "ENABLED", True)
    asked = {}

    def fake(prompt, images=None, schema=None, **kw):
        asked["images"] = images
        return {"frames": [{"frame": 0, "subtitle_top": 0.8}]}, None

    monkeypatch.setattr(llm_provider, "vision_json", fake)
    band = burned_subtitles.detect("v.mp4", frames=[JPEG, JPEG])
    assert band is not None
    assert asked["images"] == [(JPEG, "image/jpeg"), (JPEG, "image/jpeg")]


# --- what actually reaches the server ---------------------------------------

def test_the_request_that_reaches_the_server_matches_the_documentation(monkeypatch):
    """The whole path, over real HTTP, against a stand-in for the API.

    A wrong content-block shape comes back as a 400 that reads like a bad
    key, so the shape is worth checking end to end rather than in pieces.
    """
    import http.server
    import json
    import threading

    received = {}

    class Handler(http.server.BaseHTTPRequestHandler):
        def do_POST(self):
            n = int(self.headers.get("Content-Length", 0))
            received["path"] = self.path
            received["body"] = json.loads(self.rfile.read(n).decode())
            received["auth"] = self.headers.get("Authorization")
            out = json.dumps({
                "choices": [{"message": {"content": json.dumps(
                    {"layout": "split", "confidence": 0.9, "why": "w"})}}],
                "usage": {"total_tokens": 100},
            }).encode()
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(out)))
            self.end_headers()
            self.wfile.write(out)

        def log_message(self, *a):
            pass

    server = http.server.HTTPServer(("127.0.0.1", 0), Handler)
    port = server.server_address[1]
    threading.Thread(target=server.serve_forever, daemon=True).start()

    try:
        import layout_picker

        monkeypatch.setenv("GEMINI_API_KEY", "")
        monkeypatch.setenv("DEEPSEEK_API_KEY", "dk-test")
        monkeypatch.setenv("DEEPSEEK_BASE_URL", f"http://127.0.0.1:{port}")
        # ENABLED is read from the environment at import time, so it has to be
        # set on the module rather than through the environment here.
        monkeypatch.setattr(layout_picker, "ENABLED", True)
        monkeypatch.setattr(layout_picker, "sample_frames", lambda *a, **k: [JPEG])
        assert layout_picker.pick("v.mp4", 30) == "split"
    finally:
        server.shutdown()

    body = received["body"]
    assert received["path"] == "/chat/completions"
    assert received["auth"] == "Bearer dk-test"
    # The docs put image understanding on deepseek-flash.
    assert body["model"] == "deepseek-flash", body["model"]
    # DeepSeek only documents json_object.
    assert body["response_format"] == {"type": "json_object"}, body["response_format"]

    system = [m for m in body["messages"] if m["role"] == "system"][0]
    assert isinstance(system["content"], str), "the system message must stay text-only"
    user = [m for m in body["messages"] if m["role"] == "user"][0]
    assert isinstance(user["content"], list)
    assert user["content"][0]["type"] == "text"
    image_blocks = [b for b in user["content"] if b["type"] == "image_url"]
    assert len(image_blocks) == 1, user["content"]
    url = image_blocks[0]["image_url"]["url"]
    assert url.startswith("data:image/jpeg;base64,"), url[:40]
    assert base64.b64decode(url.split(",", 1)[1]) == JPEG


def test_a_deepseek_key_outranks_a_local_server_for_the_pictures(monkeypatch):
    """A local OpenAI-compatible server is usually a text model.

    With LLM_BASE_URL set, the text stages answer from it — but sending it
    pictures would fail on the request, not on the answer. A DeepSeek key
    means the Flash model, whatever else is configured.
    """
    monkeypatch.delenv("GEMINI_API_KEY", raising=False)
    monkeypatch.setenv("DEEPSEEK_API_KEY", "d")
    monkeypatch.setenv("LLM_BASE_URL", "http://127.0.0.1:9/v1")
    seen = {}

    def fake_blocks(prompt, blocks, schema=None, **kw):
        seen["provider"] = kw.get("provider_name")
        return {"ok": True}, None

    monkeypatch.setattr(llm_backend, "generate_json_with_blocks", fake_blocks)
    llm_provider.vision_json("p", [(JPEG, "image/jpeg")])
    assert seen["provider"] == llm_backend.PROVIDER_DEEPSEEK, seen


if __name__ == "__main__":
    failures = 0
    for name, fn in sorted(globals().items()):
        if name.startswith("test_") and callable(fn):
            try:
                fn()
                print(f"PASS  {name}")
            except Exception as e:  # noqa: BLE001
                print(f"FAIL  {name}\n      {e}")
                failures += 1
    print(f"\n{'FAILED' if failures else 'PASSED'}: {failures} failed")
    sys.exit(1 if failures else 0)
