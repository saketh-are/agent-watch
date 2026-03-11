#!/usr/bin/env python3

import argparse
import json
import os
import socket
import subprocess
import threading
from collections import deque
from copy import deepcopy
from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlparse


def utc_now():
    return datetime.now(timezone.utc).isoformat()


def safe_int(value, default):
    try:
        return int(value)
    except (TypeError, ValueError):
        return default


def read_json_file(path, default):
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return deepcopy(default)


def write_json_file(path, payload):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(payload, indent=2) + "\n", encoding="utf-8")


def parse_args():
    parser = argparse.ArgumentParser(
        description="Serve normalized Claude Code transcript state for Agent Watch."
    )
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=7811)
    parser.add_argument("--host-id", default=socket.gethostname())
    parser.add_argument("--tool", default="claude")
    parser.add_argument("--source-root", default=os.path.expanduser("~/.claude/projects"))
    parser.add_argument(
        "--state-root",
        default=os.path.join(
            os.environ.get("XDG_STATE_HOME", os.path.expanduser("~/.local/state")),
            "agent-watch",
            "worker",
        ),
    )
    parser.add_argument("--max-turns", type=int, default=50)
    parser.add_argument("--max-event-cache", type=int, default=500)
    parser.add_argument("--tmux-target", default="")
    return parser.parse_args()


class ClaudeWorkerStore:
    def __init__(self, args):
        self.host_id = args.host_id
        self.tool = args.tool
        self.source_root = Path(args.source_root).expanduser()
        self.tool_root = Path(args.state_root).expanduser() / self.host_id / self.tool
        self.max_turns = max(1, args.max_turns)
        self.max_event_cache = max(50, args.max_event_cache)
        self.tmux_target = args.tmux_target.strip()
        self.cursor_path = self.tool_root / "cursor.json"
        self.state_path = self.tool_root / "state.json"
        self.events_path = self.tool_root / "events.ndjson"
        self.lock = threading.Lock()

        self.cursor = read_json_file(self.cursor_path, {"files": {}})
        self.state = read_json_file(
            self.state_path,
            {
                "hostId": self.host_id,
                "tool": self.tool,
                "hostname": socket.gethostname(),
                "sourceRoot": str(self.source_root),
                "currentSessionId": None,
                "currentSessionPath": None,
                "updatedAt": None,
                "nextEventSeq": 1,
                "sessions": {},
            },
        )
        self.state["hostId"] = self.host_id
        self.state["tool"] = self.tool
        self.state["hostname"] = socket.gethostname()
        self.state["sourceRoot"] = str(self.source_root)
        self.event_cache = deque(maxlen=self.max_event_cache)
        self._load_event_cache()

    def _load_event_cache(self):
        if not self.events_path.exists():
            return
        try:
            for line in self.events_path.read_text(encoding="utf-8").splitlines()[-self.max_event_cache :]:
                if not line.strip():
                    continue
                self.event_cache.append(json.loads(line))
        except (OSError, json.JSONDecodeError):
            self.event_cache.clear()

    def sync(self):
        with self.lock:
            session_files = self.discover_session_files()
            current_path = session_files[0] if session_files else None
            if current_path:
                self._process_file(current_path)
                self._select_current_session(current_path)
            self._prune_missing_sessions(session_files)
            self.state["updatedAt"] = utc_now()
            self._persist()

    def discover_session_files(self):
        if not self.source_root.exists():
            return []
        files = []
        for path in self.source_root.rglob("*.jsonl"):
            if "subagents" in path.parts:
                continue
            try:
                stat = path.stat()
            except OSError:
                continue
            files.append((stat.st_mtime, path))
        files.sort(key=lambda item: item[0], reverse=True)
        return [path for _, path in files]

    def _select_current_session(self, path):
        path_key = str(path)
        session = self._ensure_session(path_key)
        if self.state.get("currentSessionId") == session["sessionId"]:
            return
        self.state["currentSessionId"] = session["sessionId"]
        self.state["currentSessionPath"] = path_key
        self._append_event(
            "session_selected",
            session["sessionId"],
            {
                "path": path_key,
                "cwd": session.get("cwd"),
                "gitBranch": session.get("gitBranch"),
            },
        )

    def _ensure_session(self, path_key):
        sessions = self.state.setdefault("sessions", {})
        session = sessions.get(path_key)
        if session:
            return session

        inferred_session_id = Path(path_key).stem
        session = {
            "sessionId": inferred_session_id,
            "path": path_key,
            "cwd": None,
            "gitBranch": None,
            "startedAt": None,
            "updatedAt": None,
            "lastRawTimestamp": None,
            "status": "running",
            "activeTurnId": None,
            "turnCounter": 0,
            "turns": [],
            "error": None,
        }
        sessions[path_key] = session
        return session

    def _process_file(self, path):
        path_key = str(path)
        session = self._ensure_session(path_key)
        try:
            size = path.stat().st_size
        except OSError:
            return

        file_cursor = self.cursor.setdefault("files", {}).setdefault(
            path_key,
            {"offset": 0, "carryHex": ""},
        )
        if size < file_cursor.get("offset", 0):
            self._rebuild_session(path)
            return

        carry = bytes.fromhex(file_cursor.get("carryHex", "")) if file_cursor.get("carryHex") else b""
        with path.open("rb") as handle:
            handle.seek(file_cursor.get("offset", 0))
            chunk = handle.read()
        if not chunk and not carry:
            return

        raw = carry + chunk
        last_newline = raw.rfind(b"\n")
        if last_newline < 0:
            file_cursor["carryHex"] = raw.hex()
            return

        complete = raw[: last_newline + 1]
        remainder = raw[last_newline + 1 :]
        lines = complete.decode("utf-8", errors="replace").splitlines()
        file_cursor["offset"] = file_cursor.get("offset", 0) + len(chunk) - len(remainder)
        file_cursor["carryHex"] = remainder.hex()

        for line in lines:
            if not line.strip():
                continue
            try:
                payload = json.loads(line)
            except json.JSONDecodeError:
                continue
            self._apply_payload(session, payload)

    def _rebuild_session(self, path):
        path_key = str(path)
        sessions = self.state.setdefault("sessions", {})
        sessions.pop(path_key, None)
        self.cursor.setdefault("files", {}).pop(path_key, None)
        self._ensure_session(path_key)
        self._process_file(path)

    def _apply_payload(self, session, payload):
        session["updatedAt"] = payload.get("timestamp") or session.get("updatedAt") or utc_now()
        session["lastRawTimestamp"] = payload.get("timestamp") or session.get("lastRawTimestamp")
        if payload.get("cwd"):
            session["cwd"] = payload.get("cwd")
        if payload.get("gitBranch"):
            session["gitBranch"] = payload.get("gitBranch")
        if payload.get("sessionId"):
            session["sessionId"] = payload["sessionId"]
        if not session.get("startedAt") and payload.get("timestamp"):
            session["startedAt"] = payload["timestamp"]

        normalized = self._normalize_payload(payload)
        if normalized is None:
            return
        self._apply_event_to_session(session, normalized)
        self._append_event(normalized["kind"], session["sessionId"], normalized["data"], normalized.get("turnId"))

    def _normalize_payload(self, payload):
        entry_type = payload.get("type")
        if entry_type == "assistant":
            return self._normalize_assistant_payload(payload)
        if entry_type == "user":
            return self._normalize_user_payload(payload)
        if entry_type == "queue-operation":
            return {
                "kind": "background_task",
                "data": {
                    "operation": payload.get("operation"),
                    "content": payload.get("content"),
                    "timestamp": payload.get("timestamp"),
                },
            }
        if entry_type == "last-prompt":
            return {
                "kind": "last_prompt",
                "data": {"text": payload.get("lastPrompt", "")},
            }
        return None

    def _normalize_user_payload(self, payload):
        message = payload.get("message", {})
        content = message.get("content")

        if payload.get("isMeta"):
            return None

        if isinstance(content, list):
            tool_results = []
            for item in content:
                if item.get("type") != "tool_result":
                    continue
                tool_results.append(
                    {
                        "toolUseId": item.get("tool_use_id"),
                        "text": item.get("content", ""),
                        "isError": bool(item.get("is_error")),
                        "stdout": payload.get("toolUseResult", {}).get("stdout"),
                        "stderr": payload.get("toolUseResult", {}).get("stderr"),
                        "interrupted": bool(payload.get("toolUseResult", {}).get("interrupted")),
                    }
                )
            if tool_results:
                return {
                    "kind": "tool_result",
                    "data": {
                        "results": tool_results,
                        "timestamp": payload.get("timestamp"),
                    },
                }
            return None

        if not isinstance(content, str):
            return None

        if content.startswith("<command-name>") or "<local-command-stdout>" in content:
            return {
                "kind": "local_command",
                "data": {
                    "content": content,
                    "timestamp": payload.get("timestamp"),
                },
            }

        if content.startswith("<local-command-caveat>"):
            return None

        return {
            "kind": "user_prompt",
            "data": {
                "text": content,
                "cwd": payload.get("cwd"),
                "gitBranch": payload.get("gitBranch"),
                "permissionMode": payload.get("permissionMode"),
                "timestamp": payload.get("timestamp"),
            },
        }

    def _normalize_assistant_payload(self, payload):
        message = payload.get("message", {})
        content = message.get("content", [])
        text_parts = []
        thinking_parts = []
        tool_uses = []

        if isinstance(content, list):
            for item in content:
                item_type = item.get("type")
                if item_type == "text":
                    text_parts.append(item.get("text", ""))
                elif item_type == "thinking":
                    thinking_parts.append(item.get("thinking", ""))
                elif item_type == "tool_use":
                    tool_uses.append(
                        {
                            "id": item.get("id"),
                            "name": item.get("name"),
                            "input": item.get("input", {}),
                        }
                    )

        return {
            "kind": "assistant_message",
            "data": {
                "text": "\n".join(part for part in text_parts if part).strip(),
                "thinking": "\n".join(part for part in thinking_parts if part).strip(),
                "toolUses": tool_uses,
                "stopReason": message.get("stop_reason"),
                "requestId": payload.get("requestId"),
                "error": payload.get("error"),
                "isApiErrorMessage": bool(payload.get("isApiErrorMessage")),
                "timestamp": payload.get("timestamp"),
            },
        }

    def _apply_event_to_session(self, session, event):
        kind = event["kind"]
        data = event["data"]

        if kind == "user_prompt":
            session["turnCounter"] += 1
            turn_id = f"turn-{session['turnCounter']}"
            turn = {
                "turnId": turn_id,
                "userText": data.get("text", ""),
                "assistantText": "",
                "thinking": "",
                "toolUses": [],
                "toolResults": [],
                "startedAt": data.get("timestamp"),
                "updatedAt": data.get("timestamp"),
                "status": "running",
                "error": None,
            }
            session["turns"].append(turn)
            session["turns"] = session["turns"][-self.max_turns :]
            session["activeTurnId"] = turn_id
            session["status"] = "running"
            session["error"] = None
            event["turnId"] = turn_id
            return

        active_turn = self._get_active_turn(session)

        if kind == "assistant_message":
            if active_turn is None:
                return
            text = data.get("text") or ""
            if text:
                active_turn["assistantText"] = "\n".join(
                    part for part in [active_turn.get("assistantText", "").strip(), text.strip()] if part
                ).strip()
            thinking = data.get("thinking") or ""
            if thinking:
                active_turn["thinking"] = "\n".join(
                    part for part in [active_turn.get("thinking", "").strip(), thinking.strip()] if part
                ).strip()
            if data.get("toolUses"):
                active_turn["toolUses"].extend(data["toolUses"])
            if data.get("error"):
                active_turn["error"] = data["error"]
                active_turn["status"] = "error"
                session["error"] = data["error"]
                session["status"] = "error"
            else:
                stop_reason = data.get("stopReason")
                active_turn["status"] = "completed" if stop_reason == "end_turn" else "running"
                session["status"] = "waiting" if stop_reason == "end_turn" else "running"
            active_turn["updatedAt"] = data.get("timestamp")
            event["turnId"] = active_turn["turnId"]
            return

        if kind == "tool_result":
            if active_turn is None:
                return
            active_turn["toolResults"].extend(data.get("results", []))
            active_turn["updatedAt"] = data.get("timestamp")
            event["turnId"] = active_turn["turnId"]
            return

        if kind == "local_command":
            return

    def _get_active_turn(self, session):
        active_turn_id = session.get("activeTurnId")
        if not active_turn_id:
            return None
        for turn in reversed(session.get("turns", [])):
            if turn["turnId"] == active_turn_id:
                return turn
        return None

    def _append_event(self, kind, session_id, data, turn_id=None):
        seq = self.state.get("nextEventSeq", 1)
        self.state["nextEventSeq"] = seq + 1
        event = {
            "seq": seq,
            "ts": utc_now(),
            "hostId": self.host_id,
            "tool": self.tool,
            "sessionId": session_id,
            "kind": kind,
            "data": data,
        }
        if turn_id:
            event["turnId"] = turn_id
        self.event_cache.append(event)
        self.events_path.parent.mkdir(parents=True, exist_ok=True)
        with self.events_path.open("a", encoding="utf-8") as handle:
            handle.write(json.dumps(event) + "\n")

    def _prune_missing_sessions(self, session_files):
        existing = {str(path) for path in session_files}
        sessions = self.state.setdefault("sessions", {})
        stale_paths = [path for path in sessions if path not in existing]
        for path in stale_paths:
            sessions.pop(path, None)
            self.cursor.setdefault("files", {}).pop(path, None)

    def _persist(self):
        write_json_file(self.cursor_path, self.cursor)
        write_json_file(self.state_path, self.state)

    def build_health(self):
        self.sync()
        current = self.current_session_summary()
        return {
            "ok": True,
            "hostId": self.host_id,
            "tool": self.tool,
            "updatedAt": self.state.get("updatedAt"),
            "currentSessionId": current.get("sessionId") if current else None,
        }

    def build_state(self):
        self.sync()
        return {
            "hostId": self.host_id,
            "tool": self.tool,
            "updatedAt": self.state.get("updatedAt"),
            "current": self.current_session_summary(),
            "sessions": self.session_summaries(),
        }

    def build_current(self):
        self.sync()
        return {
            "hostId": self.host_id,
            "tool": self.tool,
            "session": self.current_session_summary(),
        }

    def current_session_summary(self):
        current_path = self.state.get("currentSessionPath")
        if not current_path:
            return None
        session = self.state.get("sessions", {}).get(current_path)
        if not session:
            return None
        return self._serialize_session(session)

    def session_summaries(self):
        sessions = [self._serialize_session(session) for session in self.state.get("sessions", {}).values()]
        sessions.sort(key=lambda item: item.get("updatedAt") or "", reverse=True)
        return sessions

    def events_since(self, since_seq):
        self.sync()
        return [event for event in self.event_cache if event["seq"] > since_seq]

    def _serialize_session(self, session):
        return {
            "sessionId": session.get("sessionId"),
            "path": session.get("path"),
            "cwd": session.get("cwd"),
            "gitBranch": session.get("gitBranch"),
            "startedAt": session.get("startedAt"),
            "updatedAt": session.get("updatedAt"),
            "status": session.get("status"),
            "error": session.get("error"),
            "turns": deepcopy(session.get("turns", [])),
        }

    def submit_prompt(self, text):
        message = str(text or '').rstrip()
        if not message:
            raise ValueError("Prompt text is required")
        if not self.tmux_target:
            raise RuntimeError("tmux target is not configured")

        completed = subprocess.run(
            ["tmux", "load-buffer", "-"],
            input=message,
            text=True,
            capture_output=True,
            check=False,
        )
        if completed.returncode != 0:
            raise RuntimeError(completed.stderr.strip() or "tmux load-buffer failed")

        for command in (
            ["tmux", "paste-buffer", "-d", "-t", self.tmux_target],
            ["tmux", "send-keys", "-t", self.tmux_target, "Enter"],
        ):
            completed = subprocess.run(command, capture_output=True, text=True, check=False)
            if completed.returncode != 0:
                raise RuntimeError(completed.stderr.strip() or "tmux send failed")

        return {
            "ok": True,
            "hostId": self.host_id,
            "tool": self.tool,
            "tmuxTarget": self.tmux_target,
            "submittedAt": utc_now(),
        }


class ClaudeWorkerHandler(BaseHTTPRequestHandler):
    store = None

    def do_GET(self):
        parsed = urlparse(self.path)
        params = parse_qs(parsed.query)

        if parsed.path == "/health":
            self.respond_json(200, self.store.build_health())
            return

        if parsed.path == "/state":
            self.respond_json(200, self.store.build_state())
            return

        if parsed.path == "/tools/claude/current":
            self.respond_json(200, self.store.build_current())
            return

        if parsed.path == "/tools/claude/events":
            since = safe_int(params.get("since", ["0"])[0], 0)
            self.respond_json(
                200,
                {
                    "hostId": self.store.host_id,
                    "tool": self.store.tool,
                    "events": self.store.events_since(since),
                },
            )
            return

        if parsed.path == "/tools":
            self.respond_json(
                200,
                {
                    "hostId": self.store.host_id,
                    "tools": [self.store.tool],
                },
            )
            return

        self.respond_json(404, {"error": "Not found"})

    def do_POST(self):
        parsed = urlparse(self.path)
        if parsed.path != "/tools/claude/prompt":
            self.respond_json(404, {"error": "Not found"})
            return

        try:
            length = safe_int(self.headers.get("content-length"), 0)
            raw = self.rfile.read(max(0, length))
            payload = json.loads(raw.decode("utf-8") or "{}")
            result = self.store.submit_prompt(payload.get("text", ""))
        except ValueError as error:
            self.respond_json(400, {"error": str(error)})
            return
        except RuntimeError as error:
            self.respond_json(503, {"error": str(error)})
            return
        except json.JSONDecodeError:
            self.respond_json(400, {"error": "Invalid JSON body"})
            return

        self.respond_json(200, result)

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
    store = ClaudeWorkerStore(args)
    handler = type("ConfiguredClaudeWorkerHandler", (ClaudeWorkerHandler,), {"store": store})
    server = ThreadingHTTPServer((args.host, args.port), handler)
    server.serve_forever()


if __name__ == "__main__":
    main()
