#!/usr/bin/env bash

set -euo pipefail

bind_host="127.0.0.1"
base_port=7681
backend=""
dry_run=0
id_prefix=""
session_override=""
ssh_host=""
url_host="127.0.0.1"

host_label="$(hostname -s 2>/dev/null || hostname 2>/dev/null || echo vm)"
state_dir="${XDG_STATE_HOME:-$HOME/.local/state}/agent-watch"

usage() {
  cat <<'EOF'
Usage:
  publish_byobu_sessions.sh [options]

Publishes each current byobu/tmux/screen session through two ttyd endpoints:
  - preview: read-only browser view
  - detail: interactive browser view

Options:
  --backend tmux|screen   Force the backend instead of auto-detecting from ~/.byobu/backend.
  --base-port PORT        First port to use. Each session uses two ports. Default: 7681.
  --bind-host HOST        Interface for ttyd to bind. Default: 127.0.0.1.
  --id-prefix PREFIX      Prefix for dashboard agent IDs. Default: hostname.
  --sessions a,b,c        Comma-separated session names to publish instead of auto-discovery.
  --ssh-host HOST         Print an ssh tunnel command for this host.
  --url-host HOST         Host to place in generated dashboard URLs. Default: 127.0.0.1.
  --dry-run               Print commands without starting ttyd.
  --help                  Show this help.

Examples:
  ./scripts/publish_byobu_sessions.sh --ssh-host user@vm-alpha
  ./scripts/publish_byobu_sessions.sh --backend tmux --sessions agent-a,agent-b --base-port 7801
EOF
}

log() {
  printf '[publish_byobu] %s\n' "$*"
}

fail() {
  printf '[publish_byobu] %s\n' "$*" >&2
  exit 1
}

require_command() {
  command -v "$1" >/dev/null 2>&1 || fail "Missing required command: $1"
}

slugify() {
  printf '%s' "$1" \
    | tr '[:upper:]' '[:lower:]' \
    | sed -E 's/[^a-z0-9]+/-/g; s/^-+//; s/-+$//; s/-+/-/g'
}

detect_backend() {
  if [[ -f "$HOME/.byobu/backend" ]]; then
    local chosen
    chosen="$(tr -d '[:space:]' < "$HOME/.byobu/backend")"
    if [[ "$chosen" == "tmux" || "$chosen" == "screen" ]]; then
      printf '%s\n' "$chosen"
      return
    fi
  fi

  if command -v tmux >/dev/null 2>&1; then
    printf 'tmux\n'
    return
  fi

  if command -v screen >/dev/null 2>&1; then
    printf 'screen\n'
    return
  fi

  fail 'Could not detect a byobu backend. Set --backend tmux or --backend screen.'
}

list_tmux_sessions() {
  tmux list-sessions -F '#{session_name}'
}

list_screen_sessions() {
  screen -ls 2>/dev/null \
    | awk '/\((Detached|Attached)\)/ {gsub(/^[[:space:]]+/, "", $1); print $1}'
}

stop_existing_pid() {
  local pidfile="$1"

  if [[ ! -f "$pidfile" ]]; then
    return
  fi

  local pid
  pid="$(cat "$pidfile" 2>/dev/null || true)"
  if [[ "$pid" =~ ^[0-9]+$ ]] && kill -0 "$pid" 2>/dev/null; then
    kill "$pid" 2>/dev/null || true
    sleep 0.2
  fi

  rm -f "$pidfile"
}

start_ttyd() {
  local mode="$1"
  local port="$2"
  local session_ref="$3"
  local session_label="$4"
  local pidfile="$5"
  local logfile="$6"

  stop_existing_pid "$pidfile"

  local -a cmd
  cmd=(ttyd -i "$bind_host" -p "$port" -t disableLeaveAlert=true)
  if [[ "$mode" == "detail" ]]; then
    cmd+=(-W)
  fi

  if [[ "$backend" == "tmux" ]]; then
    if [[ "$mode" == "preview" ]]; then
      cmd+=(tmux attach-session -r -t "$session_ref")
    else
      cmd+=(tmux attach-session -t "$session_ref")
    fi
  else
    cmd+=(screen -x "$session_ref")
  fi

  if (( dry_run )); then
    printf 'DRY RUN [%s %s]: ' "$session_label" "$mode"
    printf '%q ' "${cmd[@]}"
    printf '\n'
    return
  fi

  nohup "${cmd[@]}" >"$logfile" 2>&1 < /dev/null &
  local pid=$!
  echo "$pid" > "$pidfile"
}

print_json_entries() {
  local host_for_urls="$1"
  shift
  local -a rows=("$@")

  printf '[\n'
  local index=0
  local total="${#rows[@]}"
  for row in "${rows[@]}"; do
    IFS='|' read -r agent_id agent_name session_label preview_port detail_port <<< "$row"
    printf '  {\n'
    printf '    "id": "%s",\n' "$agent_id"
    printf '    "name": "%s",\n' "$agent_name"
    printf '    "description": "%s on %s",\n' "$session_label" "$host_label"
    printf '    "badge": "%s",\n' "$host_label"
    printf '    "accent": "#d06d32",\n'
    printf '    "previewTarget": "http://%s:%s/",\n' "$host_for_urls" "$preview_port"
    printf '    "target": "http://%s:%s/"\n' "$host_for_urls" "$detail_port"
    index=$((index + 1))
    if (( index < total )); then
      printf '  },\n'
    else
      printf '  }\n'
    fi
  done
  printf ']\n'
}

while (($# > 0)); do
  case "$1" in
    --backend)
      backend="${2:-}"
      shift 2
      ;;
    --base-port)
      base_port="${2:-}"
      shift 2
      ;;
    --bind-host)
      bind_host="${2:-}"
      shift 2
      ;;
    --id-prefix)
      id_prefix="${2:-}"
      shift 2
      ;;
    --sessions)
      session_override="${2:-}"
      shift 2
      ;;
    --ssh-host)
      ssh_host="${2:-}"
      shift 2
      ;;
    --url-host)
      url_host="${2:-}"
      shift 2
      ;;
    --dry-run)
      dry_run=1
      shift
      ;;
    --help|-h)
      usage
      exit 0
      ;;
    *)
      fail "Unknown option: $1"
      ;;
  esac
done

[[ "$base_port" =~ ^[0-9]+$ ]] || fail '--base-port must be an integer.'
(( base_port > 0 )) || fail '--base-port must be greater than zero.'

if [[ -z "$id_prefix" ]]; then
  id_prefix="$(slugify "$host_label")"
fi

if [[ -z "$backend" ]]; then
  backend="$(detect_backend)"
fi

[[ "$backend" == "tmux" || "$backend" == "screen" ]] || fail '--backend must be tmux or screen.'

if (( ! dry_run )); then
  require_command ttyd
fi

if [[ -z "$session_override" ]]; then
  if [[ "$backend" == "tmux" ]]; then
    require_command tmux
  else
    require_command screen
  fi
fi

declare -a session_refs=()
declare -a session_labels=()

if [[ -n "$session_override" ]]; then
  IFS=',' read -r -a raw_sessions <<< "$session_override"
  for item in "${raw_sessions[@]}"; do
    trimmed="$(printf '%s' "$item" | sed -E 's/^[[:space:]]+//; s/[[:space:]]+$//')"
    [[ -n "$trimmed" ]] || continue
    session_refs+=("$trimmed")
    session_labels+=("$trimmed")
  done
else
  if [[ "$backend" == "tmux" ]]; then
    while IFS= read -r session_name; do
      [[ -n "$session_name" ]] || continue
      session_refs+=("$session_name")
      session_labels+=("$session_name")
    done < <(list_tmux_sessions)
  else
    while IFS= read -r session_name; do
      [[ -n "$session_name" ]] || continue
      session_refs+=("$session_name")
      session_labels+=("${session_name#*.}")
    done < <(list_screen_sessions)
  fi
fi

(( ${#session_refs[@]} > 0 )) || fail "No ${backend} sessions found."

mkdir -p "$state_dir"

declare -a rows=()
declare -a forward_args=()
port="$base_port"

log "Backend: $backend"
log "State directory: $state_dir"

for i in "${!session_refs[@]}"; do
  session_ref="${session_refs[$i]}"
  session_label="${session_labels[$i]}"
  session_slug="$(slugify "$session_label")"
  agent_id="${id_prefix}-${session_slug}"
  preview_port="$port"
  detail_port=$((port + 1))
  preview_pidfile="$state_dir/${agent_id}-preview.pid"
  detail_pidfile="$state_dir/${agent_id}-detail.pid"
  preview_log="$state_dir/${agent_id}-preview.log"
  detail_log="$state_dir/${agent_id}-detail.log"

  start_ttyd "preview" "$preview_port" "$session_ref" "$session_label" "$preview_pidfile" "$preview_log"
  start_ttyd "detail" "$detail_port" "$session_ref" "$session_label" "$detail_pidfile" "$detail_log"

  rows+=("${agent_id}|${session_label}|${session_label}|${preview_port}|${detail_port}")
  forward_args+=("-L ${preview_port}:127.0.0.1:${preview_port}")
  forward_args+=("-L ${detail_port}:127.0.0.1:${detail_port}")

  log "Published ${session_label}: preview=http://${bind_host}:${preview_port}/ detail=http://${bind_host}:${detail_port}/"
  port=$((port + 2))
done

printf '\nDashboard config entries:\n'
print_json_entries "$url_host" "${rows[@]}"

if [[ -n "$ssh_host" ]]; then
  printf '\nSuggested SSH tunnel:\n'
  printf 'ssh -N \\\n'
  for arg in "${forward_args[@]}"; do
    printf '  %s \\\n' "$arg"
  done
  printf '  %s\n' "$ssh_host"
fi

printf '\nLogs:\n'
printf '  %s\n' "$state_dir"
