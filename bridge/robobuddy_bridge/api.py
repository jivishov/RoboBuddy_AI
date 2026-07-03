from __future__ import annotations

import argparse
import json
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any
from urllib.parse import urlparse

from .adapters.fake import FakeAdapter
from .adapters.so101_lerobot import SO101LeRobotAdapter
from .models import STATUS_READY
from .safety import ValidationError, validate_commands

ALLOWED_ORIGINS = {
    "http://127.0.0.1",
    "http://localhost",
    "https://jivishov.github.io",
}

ADAPTERS = {
    "so101_follower": SO101LeRobotAdapter("so101_follower"),
    "fake_so101_follower": FakeAdapter("so101_follower"),
}


class BridgeHandler(BaseHTTPRequestHandler):
    server_version = "RoboBuddyBridge/0.1"

    def do_OPTIONS(self) -> None:
        self._send_json({"ok": True})

    def do_GET(self) -> None:
        path = urlparse(self.path).path
        if path == "/health":
            self._send_json({"ok": True, "status": STATUS_READY})
            return
        if path == "/robots":
            self._send_json({"robots": [{"id": "so101_follower"}, {"id": "fake_so101_follower"}]})
            return
        parts = _parts(path)
        if len(parts) == 3 and parts[0] == "robots" and parts[2] == "state":
            adapter = _adapter(parts[1])
            if adapter is None:
                self._send_json({"ok": False, "status": "ERROR", "error": f"unknown robot: {parts[1]}"}, status=404)
                return
            self._send_json(adapter.get_state())
            return
        if len(parts) == 3 and parts[0] == "robots" and parts[2] == "telemetry":
            self._send_json({"ok": False, "status": "ERROR", "error": "Telemetry WebSocket requires a WebSocket-capable bridge runtime."}, status=426)
            return
        self._send_json({"ok": False, "status": "ERROR", "error": "not found"}, status=404)

    def do_POST(self) -> None:
        path = urlparse(self.path).path
        parts = _parts(path)
        if len(parts) != 3 or parts[0] != "robots":
            self._send_json({"ok": False, "status": "ERROR", "error": "not found"}, status=404)
            return
        robot_id, action = parts[1], parts[2]
        adapter = _adapter(robot_id)
        if adapter is None:
            self._send_json({"ok": False, "status": "ERROR", "error": f"unknown robot: {robot_id}"}, status=404)
            return
        body = self._read_body()
        try:
            if action == "connect":
                self._send_json(adapter.connect(body))
                return
            if action == "disconnect":
                self._send_json(adapter.disconnect())
                return
            if action == "home":
                self._send_json(adapter.home())
                return
            if action == "stop":
                self._send_json(adapter.stop())
                return
            if action == "execute":
                commands = validate_commands(body.get("commands", []), "so101_follower")
                self._send_json(adapter.execute(commands))
                return
        except ValidationError as exc:
            self._send_json({"ok": False, "status": "ERROR", "error": str(exc)}, status=400)
            return
        self._send_json({"ok": False, "status": "ERROR", "error": "not found"}, status=404)

    def _read_body(self) -> dict[str, Any]:
        length = int(self.headers.get("Content-Length", "0") or 0)
        if length <= 0:
            return {}
        try:
            return json.loads(self.rfile.read(length).decode("utf-8"))
        except Exception:
            return {}

    def _send_json(self, payload: dict[str, Any], status: int = 200) -> None:
        data = json.dumps(payload).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        origin = self.headers.get("Origin", "")
        if _origin_allowed(origin):
            self.send_header("Access-Control-Allow-Origin", origin)
            self.send_header("Vary", "Origin")
        self.send_header("Access-Control-Allow-Methods", "GET,POST,OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type,Authorization")
        self.end_headers()
        self.wfile.write(data)

    def log_message(self, format: str, *args: Any) -> None:
        return


def _parts(path: str) -> list[str]:
    return [part for part in path.split("/") if part]


def _adapter(robot_id: str):
    return ADAPTERS.get(robot_id)


def _origin_allowed(origin: str) -> bool:
    if not origin:
        return True
    return any(origin.startswith(allowed) for allowed in ALLOWED_ORIGINS)


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=8765)
    args = parser.parse_args()
    server = ThreadingHTTPServer((args.host, args.port), BridgeHandler)
    print(f"RoboBuddy bridge listening on http://{args.host}:{args.port}")
    server.serve_forever()
