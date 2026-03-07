# agent-watch

Small HTTPS dashboard for monitoring multiple `ttyd` sessions from one place.

## What it does

- Shows every configured terminal on the home page as a stacked preview.
- Gives each agent its own full-screen route under `/agents/:id`.
- Proxies each `ttyd` endpoint through one local origin so the UI can stay on HTTPS even if your upstream `ttyd` servers are plain HTTP.

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

- `target` is the upstream `ttyd` URL for the full agent page.
- `previewTarget` is optional. If omitted, previews use `target`.
- `headers` is optional and gets forwarded to the upstream `ttyd` server.
- `insecureSkipVerify` is useful if the upstream `ttyd` server uses a self-signed cert.

## ttyd examples

One endpoint per agent:

```bash
ttyd -p 7681 byobu attach -t agent-alpha
```

Separate preview and full-session endpoints:

```bash
ttyd -p 7681 byobu attach -t agent-alpha
ttyd -W -p 7682 byobu attach -t agent-alpha
```

Then point `previewTarget` to the read-only endpoint and `target` to the interactive one.

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
