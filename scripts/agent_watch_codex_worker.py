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
        description="Serve normalized Codex session state for Agent Watch."
    )
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=7812)
    parser.add_argument("--host-id", default=socket.gethostname())
    parser.add_argument("--tool", default="codex")
    parser.add_argument("--source-root", default=os.path.expanduser("~/.codex/sessions"))
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


class CodexWorkerStore:
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
            "cliVersion": None,
            "startedAt": None,
            "updatedAt": None,
            "lastRawTimestamp": None,
            "status": "running",
            "activeTurnId": None,
            "pendingTurnId": None,
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
        if not session.get("startedAt") and payload.get("timestamp"):
            session["startedAt"] = payload["timestamp"]

        normalized = self._normalize_payload(session, payload)
        if normalized is None:
            return
        self._apply_event_to_session(session, normalized)
        self._append_event(normalized["kind"], session["sessionId"], normalized["data"], normalized.get("turnId"))

    def _normalize_payload(self, session, payload):
        entry_type = payload.get("type")

        if entry_type == "session_meta":
            data = payload.get("payload") or {}
            session["sessionId"] = data.get("id") or session["sessionId"]
            session["cwd"] = data.get("cwd") or session.get("cwd")
            session["cliVersion"] = data.get("cli_version") or session.get("cliVersion")
            git = data.get("git") or {}
            if isinstance(git, dict):
                session["gitBranch"] = git.get("branch") or session.get("gitBranch")
            started_at = data.get("timestamp")
            if started_at and not session.get("startedAt"):
                session["startedAt"] = started_at
            return None

        if entry_type == "turn_context":
            data = payload.get("payload") or {}
            session["cwd"] = data.get("cwd") or session.get("cwd")
            return None

        if entry_type == "event_msg":
            return self._normalize_event_msg(payload.get("payload") or {}, payload.get("timestamp"))

        if entry_type == "response_item":
            return self._normalize_response_item(payload.get("payload") or {}, payload.get("timestamp"))

        if entry_type == "compacted":
            return None

        return None

    def _normalize_event_msg(self, payload, timestamp):
        event_type = payload.get("type")
        if event_type == "task_started":
            return {
                "kind": "turn_started",
                "data": {
                    "turnId": payload.get("turn_id"),
                    "timestamp": timestamp,
                },
            }
        if event_type == "user_message":
            return {
                "kind": "user_prompt",
                "data": {
                    "text": payload.get("message", ""),
                    "timestamp": timestamp,
                },
            }
        if event_type == "agent_message":
            return {
                "kind": "assistant_message",
                "data": {
                    "text": payload.get("message", ""),
                    "phase": payload.get("phase"),
                    "timestamp": timestamp,
                },
            }
        if event_type == "task_complete":
            return {
                "kind": "turn_finished",
                "data": {
                    "turnId": payload.get("turn_id"),
                    "assistantText": payload.get("last_agent_message", ""),
                    "timestamp": timestamp,
                },
            }
        return None

    def _normalize_response_item(self, payload, timestamp):
        item_type = payload.get("type")
        if item_type in {"function_call", "custom_tool_call", "web_search_call"}:
            return {
                "kind": "tool_use",
                "data": {
                    "callId": payload.get("call_id"),
                    "name": payload.get("name") or item_type,
                    "input": self._parse_tool_input(payload),
                    "status": payload.get("status"),
                    "timestamp": timestamp,
                },
            }

        if item_type in {"function_call_output", "custom_tool_call_output"}:
            return {
                "kind": "tool_result",
                "data": {
                    "callId": payload.get("call_id"),
                    "text": payload.get("output", ""),
                    "timestamp": timestamp,
                },
            }

        return None

    def _parse_tool_input(self, payload):
        if "input" in payload:
            return payload.get("input")
        arguments = payload.get("arguments")
        if not isinstance(arguments, str):
            return {}
        try:
            return json.loads(arguments)
        except json.JSONDecodeError:
            return {"arguments": arguments}

    def _apply_event_to_session(self, session, event):
        kind = event["kind"]
        data = event["data"]

        if kind == "turn_started":
            pending_turn_id = data.get("turnId")
            if pending_turn_id:
                session["pendingTurnId"] = pending_turn_id
            session["status"] = "running"
            session["error"] = None
            return

        if kind == "user_prompt":
            session["turnCounter"] += 1
            turn_id = session.get("pendingTurnId") or f"turn-{session['turnCounter']}"
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
            session["pendingTurnId"] = None
            session["status"] = "running"
            session["error"] = None
            event["turnId"] = turn_id
            return

        active_turn = self._get_active_turn(session)

        if kind == "assistant_message":
            if active_turn is None:
                return
            text = (data.get("text") or "").strip()
            if text:
                active_turn["assistantText"] = "\n\n".join(
                    part for part in [active_turn.get("assistantText", "").strip(), text] if part
                ).strip()
            active_turn["updatedAt"] = data.get("timestamp")
            event["turnId"] = active_turn["turnId"]
            return

        if kind == "tool_use":
            if active_turn is None:
                return
            active_turn["toolUses"].append(
                {
                    "id": data.get("callId"),
                    "name": data.get("name"),
                    "input": data.get("input"),
                    "status": data.get("status"),
                }
            )
            active_turn["updatedAt"] = data.get("timestamp")
            event["turnId"] = active_turn["turnId"]
            return

        if kind == "tool_result":
            if active_turn is None:
                return
            active_turn["toolResults"].append(
                {
                    "toolUseId": data.get("callId"),
                    "text": data.get("text", ""),
                    "stdout": data.get("text", ""),
                    "isError": False,
                }
            )
            active_turn["updatedAt"] = data.get("timestamp")
            event["turnId"] = active_turn["turnId"]
            return

        if kind == "turn_finished":
            turn = None
            target_turn_id = data.get("turnId")
            if target_turn_id:
                turn = self._find_turn(session, target_turn_id)
            if turn is None:
                turn = active_turn
            if turn is None:
                return
            final_text = (data.get("assistantText") or "").strip()
            if final_text:
                existing = (turn.get("assistantText") or "").strip()
                if existing != final_text:
                    turn["assistantText"] = "\n\n".join(part for part in [existing, final_text] if part).strip()
            turn["status"] = "completed"
            turn["updatedAt"] = data.get("timestamp")
            session["status"] = "waiting"
            session["activeTurnId"] = None
            session["pendingTurnId"] = None
            event["turnId"] = turn["turnId"]
            return

    def _find_turn(self, session, turn_id):
        if not turn_id:
            return None
        for turn in reversed(session.get("turns", [])):
            if turn["turnId"] == turn_id:
                return turn
        return None

    def _get_active_turn(self, session):
        return self._find_turn(session, session.get("activeTurnId"))

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
        message = str(text or "").rstrip()
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


class CodexWorkerHandler(BaseHTTPRequestHandler):
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

        if parsed.path == "/tools/codex/current":
            self.respond_json(200, self.store.build_current())
            return

        if parsed.path == "/tools/codex/events":
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
        if parsed.path != "/tools/codex/prompt":
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
    store = CodexWorkerStore(args)
    handler = type("ConfiguredCodexWorkerHandler", (CodexWorkerHandler,), {"store": store})
    server = ThreadingHTTPServer((args.host, args.port), handler)
    server.serve_forever()


if __name__ == "__main__":
    main()
