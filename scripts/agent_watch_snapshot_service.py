#!/usr/bin/env python3

import argparse
import json
import subprocess
from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer


def parse_args():
    parser = argparse.ArgumentParser(
        description="Serve tmux capture-pane snapshots for Agent Watch."
    )
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=7810)
    parser.add_argument("--target", default="1")
    parser.add_argument("--capture-lines", type=int, default=160)
    parser.add_argument("--max-capture-lines", type=int, default=50000)
    return parser.parse_args()


def capture_snapshot(target, capture_lines):
    command = [
        "tmux",
        "capture-pane",
        "-pJ",
        "-S",
        f"-{capture_lines}",
        "-t",
        target,
    ]
    completed = subprocess.run(
        command,
        check=False,
        capture_output=True,
        text=True,
    )

    if completed.returncode != 0:
        return None, completed.stderr.strip() or "tmux capture-pane failed"

    return completed.stdout.rstrip("\n"), None


class SnapshotHandler(BaseHTTPRequestHandler):
    target = "1"
    capture_lines = 160
    max_capture_lines = 50000

    def do_GET(self):
        from urllib.parse import parse_qs, urlparse

        parsed = urlparse(self.path)
        params = parse_qs(parsed.query)

        if parsed.path == "/health":
            self.respond_json(200, {"ok": True})
            return

        if parsed.path not in {"/snapshot", "/history"}:
            self.respond_json(404, {"error": "Not found"})
            return

        requested_lines = self.capture_lines
        if "lines" in params:
            try:
                requested_lines = int(params.get("lines", [str(self.capture_lines)])[0])
            except (TypeError, ValueError):
                self.respond_json(400, {"error": "lines must be an integer"})
                return

        if requested_lines < 1:
            self.respond_json(400, {"error": "lines must be at least 1"})
            return

        requested_lines = min(requested_lines, self.max_capture_lines)
        text, error = capture_snapshot(self.target, requested_lines)
        if error:
            self.respond_json(503, {"error": error})
            return

        self.respond_json(
            200,
            {
                "target": self.target,
                "capturedAt": datetime.now(timezone.utc).isoformat(),
                "lines": requested_lines,
                "text": text,
            },
        )

    def log_message(self, format, *args):
        return

    def respond_json(self, status, payload):
        body = json.dumps(payload).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Cache-Control", "no-store")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)


def main():
    args = parse_args()
    handler = type(
        "ConfiguredSnapshotHandler",
        (SnapshotHandler,),
        {
            "target": args.target,
            "capture_lines": args.capture_lines,
            "max_capture_lines": args.max_capture_lines,
        },
    )
    server = ThreadingHTTPServer((args.host, args.port), handler)
    server.serve_forever()


if __name__ == "__main__":
    main()
