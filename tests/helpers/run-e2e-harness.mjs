import { spawn } from 'node:child_process';
import { mkdtemp, writeFile } from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, '..', '..');
const host = process.env.AGENT_WATCH_E2E_HOST || '127.0.0.1';
const appPort = Number.parseInt(process.env.AGENT_WATCH_E2E_APP_PORT || '3478', 10);
const upstreamPort = Number.parseInt(process.env.AGENT_WATCH_E2E_UPSTREAM_PORT || '4781', 10);
const tempDir = await mkdtemp(path.join(os.tmpdir(), 'agent-watch-e2e-'));
const configPath = path.join(tempDir, 'agents.e2e.json');

const agents = [
  { id: 'alpha', name: 'Alpha', accent: '#d06d32' },
  { id: 'beta', name: 'Beta', accent: '#2d7d6a' },
  { id: 'gamma', name: 'Gamma', accent: '#395fa8' }
];

await writeFile(
  configPath,
  `${JSON.stringify({
    site: {
      title: 'Agent Watch',
      subtitle: 'End-to-end terminal tab regression harness'
    },
    monitor: {
      pollMs: 60_000,
      activeWindowMs: 5_000,
      syncWindowMs: 500,
      settleWindowMs: 250,
      ignoredBottomRows: 1
    },
    agents: agents.map((agent) => ({
      id: agent.id,
      name: agent.name,
      accent: agent.accent,
      sourceLabel: `${agent.id}.example.test`,
      target: `http://${host}:${upstreamPort}/${agent.id}/`,
      previewTarget: `http://${host}:${upstreamPort}/${agent.id}/`
    }))
  }, null, 2)}\n`
);

const upstreamServer = http.createServer((req, res) => {
  const url = new URL(req.url || '/', `http://${host}:${upstreamPort}`);
  const [agentId = 'unknown'] = url.pathname.split('/').filter(Boolean);
  const agent = agents.find((item) => item.id === agentId) || { id: agentId, name: agentId };

  res.writeHead(200, {
    'content-type': 'text/html; charset=utf-8',
    'cache-control': 'no-store'
  });
  res.end(renderFakeTerminalPage(agent));
});

await new Promise((resolve, reject) => {
  upstreamServer.once('error', reject);
  upstreamServer.listen(upstreamPort, host, resolve);
});

const appProcess = spawn(process.execPath, [path.join(rootDir, 'server', 'server.mjs')], {
  cwd: rootDir,
  env: {
    ...process.env,
    HTTP_ONLY: '1',
    HOST: host,
    PORT: String(appPort),
    AGENT_WATCH_CONFIG: configPath
  },
  stdio: ['ignore', 'pipe', 'pipe']
});

appProcess.stdout.on('data', (chunk) => {
  process.stdout.write(chunk);
});

appProcess.stderr.on('data', (chunk) => {
  process.stderr.write(chunk);
});

let isShuttingDown = false;

async function shutdown(exitCode = 0) {
  if (isShuttingDown) {
    return;
  }

  isShuttingDown = true;

  await new Promise((resolve) => {
    upstreamServer.close(() => resolve());
  }).catch(() => {});

  if (!appProcess.killed) {
    appProcess.kill('SIGTERM');
  }

  await new Promise((resolve) => {
    appProcess.once('exit', () => resolve());
    setTimeout(resolve, 1_000);
  });

  process.exit(exitCode);
}

process.on('SIGINT', () => {
  shutdown(0).catch(() => process.exit(1));
});

process.on('SIGTERM', () => {
  shutdown(0).catch(() => process.exit(1));
});

appProcess.on('exit', (code) => {
  if (isShuttingDown) {
    return;
  }

  process.exit(code ?? 1);
});

function renderFakeTerminalPage(agent) {
  const label = `${agent.name} selectable output`;
  const lines = [
    `${agent.name} prompt ready`,
    label,
    `${agent.name} keeps this iframe warm`
  ];

  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <title>${escapeHtml(agent.name)} terminal</title>
    <style>
      html, body {
        margin: 0;
        height: 100%;
        background: #11161c;
        color: #d7e0ea;
        font-family: ui-monospace, "SFMono-Regular", Menlo, monospace;
      }

      .xterm {
        height: 100%;
        position: relative;
      }

      .xterm-helper-textarea {
        position: absolute;
        left: -9999px;
        top: 0;
        width: 1px;
        height: 1px;
        opacity: 0;
      }

      .xterm-viewport {
        box-sizing: border-box;
        height: 100%;
        overflow: auto;
        padding: 10px;
      }

      .terminal-output {
        width: 100%;
        min-height: 260px;
        box-sizing: border-box;
        resize: none;
        border: 0;
        outline: none;
        background: #11161c;
        color: #d7e0ea;
        font: inherit;
        line-height: 1.45;
      }
    </style>
  </head>
  <body>
    <div class="xterm">
      <textarea class="xterm-helper-textarea" aria-label="${escapeHtml(agent.name)} input"></textarea>
      <div class="xterm-viewport">
        <textarea class="terminal-output" readonly>${escapeHtml(lines.join('\n'))}</textarea>
      </div>
    </div>
    <script>
      (() => {
        const initialLines = ${JSON.stringify(lines)};
        const helper = document.querySelector('.xterm-helper-textarea');
        const output = document.querySelector('.terminal-output');
        const viewport = document.querySelector('.xterm-viewport');
        const state = {
          agentId: ${JSON.stringify(agent.id)},
          loadId: ${JSON.stringify(agent.id)} + '-' + Math.random().toString(36).slice(2),
          receivedText: '',
          disableStdin: false,
          focusCalls: 0,
          lastSelectedText: ''
        };

        window.__agentWatchTest = state;

        const syncOutput = () => {
          const typedLine = state.receivedText ? '\\ntyped:' + state.receivedText : '';
          output.value = initialLines.join('\\n') + typedLine;
        };

        const activeBuffer = {
          viewportY: 0,
          baseY: 0,
          getLine(index) {
            const text = output.value.split('\\n')[index] || '';
            return {
              translateToString() {
                return text;
              }
            };
          }
        };

        helper.addEventListener('beforeinput', (event) => {
          if (state.disableStdin) {
            event.preventDefault();
          }
        });

        helper.addEventListener('input', () => {
          if (state.disableStdin) {
            helper.value = state.receivedText;
            return;
          }

          state.receivedText = helper.value;
          syncOutput();
        });

        output.addEventListener('select', () => {
          state.lastSelectedText = output.value.slice(output.selectionStart, output.selectionEnd);
        });

        syncOutput();

        window.term = {
          rows: 12,
          buffer: { active: activeBuffer },
          focus() {
            state.focusCalls += 1;
            helper.focus();
          },
          scrollToBottom() {
            viewport.scrollTop = viewport.scrollHeight;
          },
          setOption(key, value) {
            if (key === 'disableStdin') {
              state.disableStdin = Boolean(value);
              helper.readOnly = state.disableStdin;
            }
          }
        };
      })();
    </script>
  </body>
</html>`;
}

function escapeHtml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}
