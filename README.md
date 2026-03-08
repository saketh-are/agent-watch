# agent-watch

Private HTTPS dashboard for monitoring remote agent terminals, with live `Active` / `Waiting` / `Syncing` status on top of proxied `ttyd` sessions.

## What it does

- Shows every configured agent on the home page as a stacked live terminal card.
- Detects visible terminal activity and marks each agent as `Active`, `Waiting`, or `Syncing`.
- Gives each agent its own focused full-screen route under `/agents/:id`.
- Proxies each upstream `ttyd` endpoint through one local origin so the UI can stay on HTTPS even if your agent hosts only expose plain HTTP.

## Quick start

1. Install dependencies:

   ```bash
   npm install
   ```

2. Create your config:

   ```bash
   cp config/agents.example.json config/agents.json
   ```

3. Edit `config/agents.json` and set each agent `target` to its `ttyd` URL.
   You can also tune the activity monitor in the top-level `monitor` block.

4. Start the dashboard:

   ```bash
   npm start
   ```

5. Open [https://localhost:3443](https://localhost:3443).

The app generates a local self-signed certificate in `.local/certs/` if you do not provide one. Your browser will warn unless you trust that certificate or provide your own.

## Config format

`config/agents.json`:

```json
{
  "site": {
    "title": "Agent Watch",
    "subtitle": "Private ttyd dashboard for live agent sessions"
  },
  "monitor": {
    "pollMs": 1000,
    "activeWindowMs": 5000,
    "syncWindowMs": 5000,
    "settleWindowMs": 1000,
    "ignoredBottomRows": 1
  },
  "agents": [
    {
      "id": "alpha",
      "name": "Agent Alpha",
      "description": "Interactive agent session on vm-alpha",
      "badge": "prod",
      "accent": "#d06d32",
      "target": "http://127.0.0.1:7681/",
      "previewTarget": "http://127.0.0.1:7681/",
      "insecureSkipVerify": false,
      "headers": {
        "x-forwarded-user": "operator"
      }
    }
  ]
}
```

Notes:

- `monitor.pollMs` controls how often the home cards sample terminal activity.
- `monitor.activeWindowMs` is how long a recent visible change keeps a card marked `Active`.
- `monitor.syncWindowMs` keeps a card in `Syncing` after load/reconnect before activity detection starts.
- `monitor.settleWindowMs` is how long terminal content must stay unchanged during sync before bootstrap redraws stop counting as startup noise.
- `monitor.ignoredBottomRows` skips the last N terminal rows when comparing content, which is useful for byobu status bars.
- `target` is the upstream interactive `ttyd` URL for the full agent page.
- `previewTarget` is optional. If omitted, previews use `target`.
- `headers` is optional and gets forwarded to the upstream `ttyd` server.
- `insecureSkipVerify` is useful if the upstream `ttyd` server uses a self-signed cert.

## ttyd examples

One endpoint per agent:

```bash
tmux set -ga terminal-features ',xterm-256color:RGB,xterm-direct:RGB'
ttyd -T xterm-direct -p 7681 byobu attach -t agent-alpha
```

Separate preview and full-session endpoints:

```bash
tmux set -ga terminal-features ',xterm-256color:RGB,xterm-direct:RGB'
ttyd -T xterm-direct -p 7681 byobu attach -t agent-alpha
ttyd -T xterm-direct -W -p 7682 byobu attach -t agent-alpha
```

Then point `previewTarget` to the read-only endpoint and `target` to the interactive one.

## Why this exists

This is aimed at remote coding or automation agents running in terminal multiplexers such as byobu or tmux. The home page is meant to answer:

- Which agents are currently doing work?
- Which ones are idle and waiting for input?
- Which terminal do I need to jump into right now?

## Helper script

There is a VM-side helper at `scripts/publish_byobu_sessions.sh`.

Run it on a VM that already has `ttyd` and your byobu sessions:

```bash
./scripts/publish_byobu_sessions.sh --ssh-host user@your-vm
```

What it does:

- Detects whether byobu is using `tmux` or `screen`
- Finds the current sessions
- Starts a preview `ttyd` endpoint and a detail `ttyd` endpoint for each session
- Configures tmux/ttyd for RGB-capable browser terminals
- Prints dashboard JSON entries and an `ssh -L` command you can run locally

## Custom TLS

To use a trusted cert instead of the generated local cert:

```bash
SSL_CERT_PATH=/path/to/fullchain.pem SSL_KEY_PATH=/path/to/privkey.pem npm start
```

If you do not need HTTPS for a quick local test:

```bash
npm run start:http
```
