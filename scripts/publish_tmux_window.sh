#!/usr/bin/env bash

set -euo pipefail

if [[ $# -ne 5 ]]; then
  echo "Usage: publish_tmux_window.sh <source_session> <window_index> <group_session> <preview_port> <detail_port>" >&2
  exit 1
fi

source_session="$1"
window_index="$2"
group_session="$3"
preview_port="$4"
detail_port="$5"

command -v tmux >/dev/null 2>&1 || {
  echo "tmux is required" >&2
  exit 1
}

command -v ttyd >/dev/null 2>&1 || {
  echo "ttyd is required" >&2
  exit 1
}

mkdir -p "${XDG_STATE_HOME:-$HOME/.local/state}/agent-watch"
state_dir="${XDG_STATE_HOME:-$HOME/.local/state}/agent-watch"

tmux has-session -t "$source_session"

if ! tmux has-session -t "$group_session" 2>/dev/null; then
  tmux new-session -d -t "$source_session" -s "$group_session"
fi

tmux select-window -t "${group_session}:${window_index}"

pkill -f "ttyd -i 127.0.0.1 -p ${preview_port} " || true
pkill -f "ttyd -i 127.0.0.1 -p ${detail_port} " || true
sleep 0.5

nohup ttyd -i 127.0.0.1 -p "$preview_port" -R -t disableLeaveAlert=true \
  tmux attach-session -f read-only -t "$group_session" \
  > "${state_dir}/${group_session}-preview.log" 2>&1 < /dev/null &

nohup ttyd -i 127.0.0.1 -p "$detail_port" -t disableLeaveAlert=true \
  tmux attach-session -t "$group_session" \
  > "${state_dir}/${group_session}-detail.log" 2>&1 < /dev/null &

sleep 0.5

printf 'published %s window %s on %s/%s\n' "$group_session" "$window_index" "$preview_port" "$detail_port"
