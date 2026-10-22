"""Tests for model_store: download, resume, atomic replace, progress.

The model host is unreachable in some environments (and blocked in some
regions), so the tests serve the model files from a local HTTP server. That
exercises the same code path end to end, including the Range handling the
resume depends on.
"""

import http.server
import os
import socketserver
import threading

import pytest

import model_store

# Stand-ins for the real files, keyed the way the URLs address them.
FIXTURES = {
    "Systran/faster-whisper-small/config.json": b'{"model_type": "whisper"}',
    "Systran/faster-whisper-small/tokenizer.json": b'{"tokenizer": true}',
    "Systran/faster-whisper-small/vocabulary.txt": b"a b c\n",
    "Systran/faster-whisper-small/model.bin": os.urandom(3 * 1024 * 1024),
    "yolov8n.pt": os.urandom(512 * 1024),
}


class _Handler(http.server.BaseHTTPRequestHandler):
    """Serves FIXTURES and honours Range, so the resume path can be tested."""

    def log_message(self, *_args):
        pass

    def _resolve(self):
        path = self.path.lstrip("/")
        # Hugging Face serves files as <repo>/resolve/main/<file>.
        if "/resolve/main/" in path:
            path = path.replace("/resolve/main/", "/")
        for key, body in FIXTURES.items():
            if path == key or path == key.split("/")[-1]:
                return body
        return None

    def do_GET(self):
        body = self._resolve()
        if body is None:
            self.send_error(404)
            return
        rng = self.headers.get("Range")
        if rng and rng.startswith("bytes="):
            start = int(rng.split("=")[1].split("-")[0])
            chunk = body[start:]
            self.send_response(206)
            self.send_header("Content-Range", f"bytes {start}-{len(body)-1}/{len(body)}")
        else:
            chunk = body
            self.send_response(200)
        self.send_header("Content-Length", str(len(chunk)))
        self.end_headers()
        self.wfile.write(chunk)


@pytest.fixture()
def server():
    httpd = socketserver.TCPServer(("127.0.0.1", 0), _Handler)
    port = httpd.server_address[1]
    threading.Thread(target=httpd.serve_forever, daemon=True).start()
    yield f"http://127.0.0.1:{port}"
    httpd.shutdown()


@pytest.fixture()
def data_dir(tmp_path, monkeypatch):
    monkeypatch.setenv("DW_SHORTS_DATA_DIR", str(tmp_path))
    monkeypatch.delenv("DW_SHORTS_BUNDLE", raising=False)
    return str(tmp_path)


def test_yolo_downloads_into_the_data_dir(server, data_dir):
    monkey = server
    os.environ["DW_MODEL_BASE_URL"] = monkey
    try:
        seen = []
        path = model_store.download_yolo(lambda d, t, l: seen.append((d, t, l)))
        assert path == model_store.yolo_path()
        assert open(path, "rb").read() == FIXTURES["yolov8n.pt"]
        assert model_store.yolo_ready()
        assert seen, "progress was never reported"
        assert not os.path.exists(path + ".part")
    finally:
        os.environ.pop("DW_MODEL_BASE_URL", None)


def test_whisper_downloads_every_file(server, data_dir):
    os.environ["DW_MODEL_BASE_URL"] = server
    try:
        wdir = model_store.download_whisper("small")
        for name, body in FIXTURES.items():
            if not name.startswith("Systran/faster-whisper-small/"):
                continue
            fname = name.split("/")[-1]
            assert open(os.path.join(wdir, fname), "rb").read() == body
        assert model_store.whisper_ready("small")
        assert model_store.ready_sizes() == ["small"]
    finally:
        os.environ.pop("DW_MODEL_BASE_URL", None)


def test_download_resumes_from_a_partial_file(server, data_dir):
    os.environ["DW_MODEL_BASE_URL"] = server
    try:
        target = os.path.join(model_store.models_root(), "resume.bin")
        part = target + ".part"
        os.makedirs(os.path.dirname(target), exist_ok=True)
        with open(part, "wb") as fh:
            fh.write(FIXTURES["yolov8n.pt"][:100000])
        model_store._download(f"{server}/yolov8n.pt", target)
        assert open(target, "rb").read() == FIXTURES["yolov8n.pt"]
        assert not os.path.exists(part)
    finally:
        os.environ.pop("DW_MODEL_BASE_URL", None)


def test_a_missing_file_is_retried_then_reported(server, data_dir, monkeypatch):
    monkeypatch.setattr(model_store, "_RETRIES", 2)
    monkeypatch.setattr(model_store.time, "sleep", lambda _s: None)
    with pytest.raises(Exception):
        model_store._download(f"{server}/does-not-exist", os.path.join(data_dir, "nope.bin"))


def test_status_reports_what_is_on_disk(server, data_dir):
    os.environ["DW_MODEL_BASE_URL"] = server
    try:
        st = model_store.status()
        assert st["base_url"] == server
        assert st["whisper"]["ready"] is False
        assert st["yolo"]["ready"] is False
        assert "small" in st["whisper"]["available"]
        model_store.download_yolo()
        model_store.download_whisper("small")
        st = model_store.status()
        assert st["whisper"]["ready"] is True
        assert st["yolo"]["ready"] is True
        assert st["whisper"]["sizes"] == ["small"]
    finally:
        os.environ.pop("DW_MODEL_BASE_URL", None)


def test_an_unknown_size_is_rejected(data_dir):
    with pytest.raises(ValueError):
        model_store.download_whisper("enormous")
