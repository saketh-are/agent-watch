import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import express from 'express';
import httpProxy from 'http-proxy';
import selfsigned from 'selfsigned';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, '..');
const publicDir = path.join(rootDir, 'public');
const localDir = path.join(rootDir, '.local');
const certDir = path.join(localDir, 'certs');
const configPath = process.env.AGENT_WATCH_CONFIG || path.join(rootDir, 'config', 'agents.json');
const port = Number.parseInt(process.env.PORT || '3443', 10);
const host = process.env.HOST || '0.0.0.0';
const httpOnly = process.env.HTTP_ONLY === '1';
const auth = getAuthConfig();
const terminalRootCacheTtlMs = 1000 * 60 * 10;
const snapshotPreviewMaxLines = 28;
let configCache = null;
let configRawCache = null;
let configWatcher = null;
let agentMonitorTimer = null;
let agentMonitorRunning = false;
const terminalRootCache = new Map();
const agentMonitorState = new Map();
const warpSolarizedDarkThemeLiteral = [
  'theme:{',
  'foreground:"#f8f8f2",',
  'background:"#002b36",',
  'cursor:"#f8f8f2",',
  'selectionBackground:"rgba(147, 161, 161, 0.28)",',
  'black:"#073642",',
  'red:"#dc322f",',
  'green:"#859900",',
  'yellow:"#b58900",',
  'blue:"#268bd2",',
  'magenta:"#d33682",',
  'cyan:"#2aa198",',
  'white:"#eee8d5",',
  'brightBlack:"#002b36",',
  'brightRed:"#cb4b16",',
  'brightGreen:"#586e75",',
  'brightYellow:"#657b83",',
  'brightBlue:"#839496",',
  'brightMagenta:"#6c71c4",',
  'brightCyan:"#93a1a1",',
  'brightWhite:"#fdf6e3"',
  '}'
].join('');
const terminalUnloadPatch = [
  '<script data-agent-watch="disable-unload-warning">',
  '(() => {',
  '  try {',
  '    const originalAdd = window.addEventListener.bind(window);',
  '    const originalRemove = window.removeEventListener.bind(window);',
  '    originalAdd("beforeunload", (event) => {',
  '      event.stopImmediatePropagation();',
  '      try { delete event.returnValue; } catch {}',
  '    }, true);',
  '    window.addEventListener = function(type, listener, options) {',
  '      if (type === "beforeunload") return;',
  '      return originalAdd(type, listener, options);',
  '    };',
  '    window.removeEventListener = function(type, listener, options) {',
  '      if (type === "beforeunload") return;',
  '      return originalRemove(type, listener, options);',
  '    };',
  '    Object.defineProperty(window, "onbeforeunload", {',
  '      configurable: true,',
  '      get() { return null; },',
  '      set() {}',
  '    });',
  '    window.onbeforeunload = null;',
  '  } catch {}',
  '  try {',
  '    const terminalTheme = {',
  '      foreground: "#f8f8f2",',
  '      background: "#002b36",',
  '      cursor: "#f8f8f2",',
  '      selectionBackground: "rgba(147, 161, 161, 0.28)",',
  '      black: "#073642",',
  '      red: "#dc322f",',
  '      green: "#859900",',
  '      yellow: "#b58900",',
  '      blue: "#268bd2",',
  '      magenta: "#d33682",',
  '      cyan: "#2aa198",',
  '      white: "#eee8d5",',
  '      brightBlack: "#002b36",',
  '      brightRed: "#cb4b16",',
  '      brightGreen: "#586e75",',
  '      brightYellow: "#657b83",',
  '      brightBlue: "#839496",',
  '      brightMagenta: "#6c71c4",',
  '      brightCyan: "#93a1a1",',
  '      brightWhite: "#fdf6e3"',
  '    };',
  '    const applyTerminalTheme = () => {',
  '      const term = window.term;',
  '      if (!term || typeof term.setOption !== "function") return false;',
  '      term.setOption("theme", terminalTheme);',
  '      if (term.element) {',
  '        term.element.style.backgroundColor = terminalTheme.background;',
  '        term.element.style.color = terminalTheme.foreground;',
  '      }',
  '      document.documentElement.style.backgroundColor = terminalTheme.background;',
  '      document.body.style.backgroundColor = terminalTheme.background;',
  '      document.body.style.color = terminalTheme.foreground;',
  '      return true;',
  '    };',
  '    if (!applyTerminalTheme()) {',
  '      let attempts = 0;',
  '      const timer = window.setInterval(() => {',
  '        attempts += 1;',
  '        if (applyTerminalTheme() || attempts > 80) {',
  '          window.clearInterval(timer);',
  '        }',
  '      }, 100);',
  '    }',
  '  } catch {}',
  '  try {',
  '    const installTrackpadScroll = () => {',
  '      const doc = window.document;',
  '      const root = doc.querySelector(".xterm");',
  '      const viewport = doc.querySelector(".xterm-viewport");',
  '      if (!root || !viewport) return false;',
  '      if (root.dataset.agentWatchTrackpadScroll === "1") return true;',
  '      root.dataset.agentWatchTrackpadScroll = "1";',
  '      doc.addEventListener("wheel", (event) => {',
  '        if (!(event.target instanceof Element) || !event.target.closest(".xterm")) return;',
  '        viewport.scrollTop += event.deltaY;',
  '        try {',
  '          const term = window.term;',
  '          if (term && typeof term.focus === "function") term.focus();',
  '        } catch {}',
  '        event.preventDefault();',
  '      }, { passive: false, capture: true });',
  '      return true;',
  '    };',
  '    if (!installTrackpadScroll()) {',
  '      let attempts = 0;',
  '      const timer = window.setInterval(() => {',
  '        attempts += 1;',
  '        if (installTrackpadScroll() || attempts > 80) {',
  '          window.clearInterval(timer);',
  '        }',
  '      }, 100);',
  '    }',
  '  } catch {}',
  '})();',
  '</script>'
].join('');

const app = express();
const proxy = httpProxy.createProxyServer({
  changeOrigin: true,
  ws: true,
  xfwd: true
});

proxy.on('proxyRes', (proxyRes) => {
  delete proxyRes.headers['content-security-policy'];
  delete proxyRes.headers['x-frame-options'];
});

proxy.on('error', (error, req, resOrSocket) => {
  const message = JSON.stringify({
    error: 'Proxy request failed',
    detail: error.message
  });

  if ('writeHead' in resOrSocket) {
    resOrSocket.writeHead(502, {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store'
    });
    resOrSocket.end(message);
    return;
  }

  resOrSocket.end('HTTP/1.1 502 Bad Gateway\r\n\r\n');
});

app.disable('x-powered-by');
app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: false }));

app.get('/login', (req, res) => {
  if (!auth.enabled) {
    res.redirect('/');
    return;
  }

  if (isAuthenticated(req)) {
    res.redirect(normalizeNextPath(req.query.next));
    return;
  }

  res
    .status(200)
    .type('html')
    .setHeader('cache-control', 'no-store')
    .send(renderLoginPage({
      next: normalizeNextPath(req.query.next)
    }));
});

app.post('/login', (req, res) => {
  if (!auth.enabled) {
    res.redirect('/');
    return;
  }

  const nextPath = normalizeNextPath(req.body?.next);
  const username = String(req.body?.login_user ?? req.body?.username ?? '');
  const password = String(req.body?.login_secret ?? req.body?.password ?? '');

  if (username !== auth.user || password !== auth.password) {
    res
      .status(401)
      .type('html')
      .setHeader('cache-control', 'no-store')
      .send(renderLoginPage({
        next: nextPath,
        error: 'Incorrect username or password.'
      }));
    return;
  }

  setAuthCookie(res, req);
  res.redirect(nextPath);
});

app.post('/logout', (req, res) => {
  clearAuthCookie(res, req);
  res.redirect('/login');
});

app.use((req, res, next) => {
  if (!auth.enabled || req.path === '/login') {
    next();
    return;
  }

  if (isAuthenticated(req)) {
    next();
    return;
  }

  if (req.method === 'GET' && acceptsHtml(req)) {
    res.redirect(`/login?next=${encodeURIComponent(normalizeNextPath(req.originalUrl || req.url || '/'))}`);
    return;
  }

  res.status(401).json({ error: 'Authentication required' });
});

app.get('/api/config', (_req, res) => {
  try {
    const config = loadConfig();
    res.setHeader('cache-control', 'no-store');
    res.json(buildPublicConfig(config));
  } catch (error) {
    res.status(500).json({
      error: 'Invalid dashboard configuration',
      detail: error.message
    });
  }
});

app.get('/api/state', (_req, res) => {
  try {
    const config = loadConfig();
    res.setHeader('cache-control', 'no-store');
    res.json(buildPublicAgentState(config));
  } catch (error) {
    res.status(500).json({
      error: 'Could not load dashboard state',
      detail: error.message
    });
  }
});

app.get('/api/config-file', (_req, res) => {
  try {
    const { raw } = readConfigFile();
    res.setHeader('cache-control', 'no-store');
    res.json({
      path: configPath,
      raw
    });
  } catch (error) {
    res.status(500).json({
      error: 'Invalid dashboard configuration',
      detail: error.message
    });
  }
});

app.put('/api/config-file', (req, res) => {
  try {
    const raw = String(req.body?.raw || '');
    const saved = writeConfigFile(raw);
    const config = loadConfig();
    res.setHeader('cache-control', 'no-store');
    res.json({
      ok: true,
      path: configPath,
      raw: saved,
      config: buildPublicConfig(config)
    });
  } catch (error) {
    res.status(400).json({
      error: 'Could not save dashboard configuration',
      detail: error.message
    });
  }
});

app.use('/terminal/:id/:mode', (req, res) => {
  let config;
  try {
    config = loadConfig();
  } catch (error) {
    res.status(500).json({
      error: 'Invalid dashboard configuration',
      detail: error.message
    });
    return;
  }

  const agent = config.agents.find((item) => item.id === req.params.id);

  if (!agent) {
    res.status(404).json({ error: `Unknown agent "${req.params.id}"` });
    return;
  }

  if (!isSupportedMode(req.params.mode)) {
    res.status(404).json({ error: `Unsupported mode "${req.params.mode}"` });
    return;
  }

  const upstream = getUpstream(agent, req.params.mode);
  req.url = joinTargetPath(upstream.pathname, req.url || '/');

  if (shouldPatchTerminalRoot(req)) {
    proxyTerminalRoot(req, res, upstream, agent);
    return;
  }

  proxy.web(req, res, {
    target: upstream.origin,
    secure: !agent.insecureSkipVerify,
    headers: agent.headers || {}
  });
});

app.use(express.static(publicDir));

app.get(/^(?!\/api\/|\/terminal\/).*/, (_req, res) => {
  res.sendFile(path.join(publicDir, 'index.html'));
});

const server = httpOnly
  ? http.createServer(app)
  : https.createServer(getHttpsOptions(), app);

server.on('upgrade', (req, socket, head) => {
  if (auth.enabled && !isAuthenticated(req)) {
    socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n');
    socket.destroy();
    return;
  }

  const parsedUrl = new URL(req.url || '/', 'http://127.0.0.1');
  const match = parsedUrl.pathname.match(/^\/terminal\/([^/]+)\/([^/]+)(\/.*)?$/);

  let config;
  try {
    config = loadConfig();
  } catch {
    socket.destroy();
    return;
  }

  if (match) {
    const [, id, mode] = match;
    if (!isSupportedMode(mode)) {
      socket.destroy();
      return;
    }

    const agent = config.agents.find((item) => item.id === id);
    if (!agent) {
      socket.destroy();
      return;
    }

    const upstream = getUpstream(agent, mode);
    req.url = joinTargetPath(upstream.pathname, parsedUrl.pathname.replace(`/terminal/${id}/${mode}`, '') || '/') + parsedUrl.search;

    proxy.ws(req, socket, head, {
      target: upstream.origin,
      secure: !agent.insecureSkipVerify,
      headers: agent.headers || {}
    });
    return;
  }

  socket.destroy();
});

try {
  validateAuthConfig();
  loadConfig();
} catch (error) {
  console.error(`[agent-watch] ${error.message}`);
  process.exit(1);
}

startConfigWatcher();
scheduleAgentMonitor(0);

server.listen(port, host, () => {
  const protocol = httpOnly ? 'http' : 'https';
  console.log(`[agent-watch] listening on ${protocol}://${displayHost(host)}:${port}`);
  console.log(`[agent-watch] config: ${configPath}`);
  if (!httpOnly) {
    console.log(`[agent-watch] using local TLS certificate from ${certDir}`);
  }
});

function loadConfig() {
  if (configCache) {
    return configCache;
  }

  const { raw } = readConfigFile();
  configCache = normalizeConfig(JSON.parse(raw));
  return configCache;
}

function buildPublicConfig(config) {
  return {
    site: config.site,
    monitor: config.monitor,
    agents: config.agents.map((agent) => {
      const detailUpstream = getUpstream(agent, 'detail');
      return {
        id: agent.id,
        name: agent.name,
        description: agent.description || '',
        badge: agent.badge || '',
        accent: agent.accent || '#d06d32',
        source: agent.sourceLabel || detailUpstream.host,
        previewPath: `/terminal/${encodeURIComponent(agent.id)}/preview/`,
        detailPath: `/terminal/${encodeURIComponent(agent.id)}/detail/`
      };
    })
  };
}

function buildPublicAgentState(config) {
  return {
    generatedAt: new Date().toISOString(),
    agents: config.agents.map((agent) => {
      const monitorState = agentMonitorState.get(agent.id);
      return {
        id: agent.id,
        status: monitorState?.status || 'syncing',
        snapshot: monitorState?.previewText || '',
        capturedAt: monitorState?.capturedAt || null,
        error: monitorState?.error || null
      };
    })
  };
}

function validateAgents(agents) {
  const seenIds = new Set();

  for (const agent of agents) {
    if (!agent.id || !agent.name || !agent.target) {
      throw new Error('Each agent requires "id", "name", and "target".');
    }

    if (seenIds.has(agent.id)) {
      throw new Error(`Duplicate agent id "${agent.id}" found in ${configPath}.`);
    }

    seenIds.add(agent.id);
    new URL(agent.target);
    if (agent.previewTarget) {
      new URL(agent.previewTarget);
    }
    if (agent.snapshotTarget) {
      new URL(agent.snapshotTarget);
    }
  }
}

function validateMonitorConfig(monitor) {
  const entries = [
    ['pollMs', monitor.pollMs],
    ['activeWindowMs', monitor.activeWindowMs],
    ['syncWindowMs', monitor.syncWindowMs],
    ['settleWindowMs', monitor.settleWindowMs],
    ['ignoredBottomRows', monitor.ignoredBottomRows]
  ];

  for (const [key, value] of entries) {
    if (!Number.isInteger(value) || value < 0) {
      throw new Error(`monitor.${key} must be a non-negative integer.`);
    }
  }
}

function readConfigFile() {
  if (configRawCache !== null) {
    return {
      raw: configRawCache
    };
  }

  if (!fs.existsSync(configPath)) {
    configRawCache = `${JSON.stringify(getDefaultConfig(), null, 2)}\n`;
    return {
      raw: configRawCache
    };
  }

  configRawCache = fs.readFileSync(configPath, 'utf8');
  return {
    raw: configRawCache
  };
}

function writeConfigFile(raw) {
  const parsed = JSON.parse(raw);
  const normalized = normalizeConfig(parsed);
  const serialized = `${JSON.stringify(
    {
      site: normalized.site,
      monitor: normalized.monitor,
      agents: normalized.agents
    },
    null,
    2
  )}\n`;

  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  fs.writeFileSync(configPath, serialized, 'utf8');
  configRawCache = serialized;
  configCache = normalized;
  terminalRootCache.clear();
  scheduleAgentMonitor(0);
  return serialized;
}

function normalizeConfig(parsed) {
  const config = parsed && typeof parsed === 'object' ? parsed : {};
  const agents = Array.isArray(config.agents) ? config.agents : [];
  const monitor = normalizeMonitorConfig(config.monitor);
  validateAgents(agents);
  validateMonitorConfig(monitor);

  return {
    site: {
      title: config.site?.title || 'Agent Watch',
      subtitle: config.site?.subtitle || 'Private ttyd dashboard for live agent sessions'
    },
    monitor,
    agents
  };
}

function getDefaultConfig() {
  return {
    site: {
      title: 'Agent Watch',
      subtitle: 'Private ttyd dashboard for live agent sessions'
    },
    monitor: getDefaultMonitorConfig(),
    agents: []
  };
}

function getDefaultMonitorConfig() {
  return {
    pollMs: 1000,
    activeWindowMs: 5000,
    syncWindowMs: 5000,
    settleWindowMs: 1000,
    ignoredBottomRows: 1
  };
}

function normalizeMonitorConfig(parsedMonitor) {
  const defaults = getDefaultMonitorConfig();
  const monitor = parsedMonitor && typeof parsedMonitor === 'object' ? parsedMonitor : {};

  return {
    pollMs: monitor.pollMs ?? defaults.pollMs,
    activeWindowMs: monitor.activeWindowMs ?? defaults.activeWindowMs,
    syncWindowMs: monitor.syncWindowMs ?? defaults.syncWindowMs,
    settleWindowMs: monitor.settleWindowMs ?? defaults.settleWindowMs,
    ignoredBottomRows: monitor.ignoredBottomRows ?? defaults.ignoredBottomRows
  };
}

function getUpstream(agent, mode) {
  const target = mode === 'preview' && agent.previewTarget ? agent.previewTarget : agent.target;
  return new URL(target);
}

function isSupportedMode(mode) {
  return mode === 'preview' || mode === 'detail';
}

function joinTargetPath(basePath, extraUrl) {
  const [pathname, search = ''] = extraUrl.split('?');
  const base = basePath === '/' ? '' : basePath.replace(/\/$/, '');
  const extraPath = pathname && pathname !== '/' ? pathname : '/';
  const joined = `${base}${extraPath}`.replace(/\/{2,}/g, '/');
  return search ? `${joined}?${search}` : joined;
}

function shouldPatchTerminalRoot(req) {
  return req.method === 'GET' && (req.path === '/' || req.path === '');
}

function proxyTerminalRoot(req, res, upstream, agent) {
  const targetUrl = new URL(req.url, upstream.origin);
  const cacheKey = getTerminalRootCacheKey(targetUrl);
  const cached = terminalRootCache.get(cacheKey);
  if (cached && Date.now() - cached.cachedAt < terminalRootCacheTtlMs) {
    res.writeHead(cached.statusCode, { ...cached.headers });
    res.end(cached.body);
    return;
  }

  const transport = upstream.protocol === 'https:' ? https : http;
  const headers = {
    ...filterProxyRequestHeaders(req.headers),
    ...(agent.headers || {}),
    host: upstream.host,
    'accept-encoding': 'identity'
  };

  const upstreamReq = transport.request(
    targetUrl,
    {
      method: 'GET',
      headers,
      rejectUnauthorized: !agent.insecureSkipVerify
    },
    (upstreamRes) => {
      const chunks = [];

      upstreamRes.on('data', (chunk) => {
        chunks.push(chunk);
      });

      upstreamRes.on('end', () => {
        const rawBody = Buffer.concat(chunks);
        const contentType = String(upstreamRes.headers['content-type'] || '');
        const responseHeaders = sanitizeProxyHeaders(upstreamRes.headers);

        if (!contentType.includes('text/html')) {
          res.writeHead(upstreamRes.statusCode || 200, responseHeaders);
          res.end(rawBody);
          return;
        }

        const patchedBody = patchTerminalHtml(rawBody.toString('utf8'));
        responseHeaders['content-length'] = String(Buffer.byteLength(patchedBody));
        responseHeaders['content-type'] = contentType || 'text/html; charset=utf-8';
        responseHeaders['cache-control'] = 'no-store';
        const statusCode = upstreamRes.statusCode || 200;
        terminalRootCache.set(cacheKey, {
          cachedAt: Date.now(),
          statusCode,
          headers: { ...responseHeaders },
          body: patchedBody
        });
        res.writeHead(statusCode, responseHeaders);
        res.end(patchedBody);
      });
    }
  );

  upstreamReq.on('error', (error) => {
    if (cached) {
      res.writeHead(cached.statusCode, { ...cached.headers });
      res.end(cached.body);
      return;
    }

    res.status(502).json({
      error: 'Proxy request failed',
      detail: error.message
    });
  });

  upstreamReq.end();
}

function filterProxyRequestHeaders(headers) {
  const nextHeaders = { ...headers };
  delete nextHeaders.host;
  delete nextHeaders.connection;
  delete nextHeaders['content-length'];
  return nextHeaders;
}

function sanitizeProxyHeaders(headers) {
  const nextHeaders = { ...headers };
  delete nextHeaders['content-security-policy'];
  delete nextHeaders['x-frame-options'];
  delete nextHeaders['content-encoding'];
  delete nextHeaders['transfer-encoding'];
  return nextHeaders;
}

function getTerminalRootCacheKey(targetUrl) {
  return `${targetUrl.origin}${targetUrl.pathname}`;
}

function patchTerminalHtml(html) {
  const themedHtml = applyWarpTerminalTheme(html);

  if (themedHtml.includes('data-agent-watch="disable-unload-warning"')) {
    return themedHtml;
  }

  if (themedHtml.includes('</head>')) {
    return themedHtml.replace('</head>', `${terminalUnloadPatch}</head>`);
  }

  return `${terminalUnloadPatch}${themedHtml}`;
}

function applyWarpTerminalTheme(html) {
  return html
    .replace(/theme:\{\}/g, warpSolarizedDarkThemeLiteral)
    .replace(/theme:\{[^}]*foreground:"#[0-9a-fA-F]{6}"[^}]*\}/g, warpSolarizedDarkThemeLiteral)
    .replace(/rendererType:"webgl"/g, 'rendererType:"canvas"')
    .replace(/\.xterm \.composition-view\{background:#000;color:#fff;/g, '.xterm .composition-view{background:#002b36;color:#f8f8f2;')
    .replace(/overflow-y:scroll;/g, 'overflow-y:scroll;overscroll-behavior:contain;touch-action:pan-y;-webkit-overflow-scrolling:touch;')
    .replace(/\.xterm \.xterm-viewport\{background-color:#000;/g, '.xterm .xterm-viewport{background-color:#002b36;')
    .replace(/body,html\{height:100%;margin:0;min-height:100%;overflow:hidden\}/g, 'body,html{height:100%;margin:0;min-height:100%;overflow:hidden;background:#002b36;color:#f8f8f2}')
    .replace(/#terminal-container\{height:100%;margin:0 auto;padding:0;width:auto\}/g, '#terminal-container{height:100%;margin:0 auto;padding:0;width:auto;background:#002b36}')
    .replace(/#terminal-container \.terminal\{height:calc\(100% - 10px\);padding:5px\}/g, '#terminal-container .terminal{height:calc(100% - 10px);padding:5px;background:#002b36}');
}

function startConfigWatcher() {
  if (configWatcher) {
    return;
  }

  fs.mkdirSync(path.dirname(configPath), { recursive: true });

  try {
    configWatcher = fs.watch(path.dirname(configPath), (_eventType, filename) => {
      if (!filename || String(filename) === path.basename(configPath)) {
        invalidateConfigCache();
      }
    });
    configWatcher.on('error', () => {});
  } catch {}
}

function invalidateConfigCache() {
  configCache = null;
  configRawCache = null;
  terminalRootCache.clear();
  scheduleAgentMonitor(0);
}

function scheduleAgentMonitor(delayMs = null) {
  if (agentMonitorTimer) {
    clearTimeout(agentMonitorTimer);
  }

  const delay = delayMs ?? getAgentMonitorDelay();
  agentMonitorTimer = setTimeout(() => {
    runAgentMonitor().catch((error) => {
      console.error(`[agent-watch] monitor error: ${error.message}`);
    });
  }, Math.max(0, delay));
}

function getAgentMonitorDelay() {
  try {
    return loadConfig().monitor.pollMs;
  } catch {
    return getDefaultMonitorConfig().pollMs;
  }
}

async function runAgentMonitor() {
  if (agentMonitorRunning) {
    scheduleAgentMonitor();
    return;
  }

  agentMonitorRunning = true;

  try {
    const config = loadConfig();
    const now = Date.now();
    const activeIds = new Set(config.agents.map((agent) => agent.id));
    const responses = await Promise.all(config.agents.map((agent) => fetchAgentSnapshot(agent)));

    config.agents.forEach((agent, index) => {
      updateAgentMonitorState(agent, responses[index], config.monitor, now);
    });

    for (const agentId of [...agentMonitorState.keys()]) {
      if (!activeIds.has(agentId)) {
        agentMonitorState.delete(agentId);
      }
    }
  } catch (error) {
    console.error(`[agent-watch] monitor error: ${error.message}`);
  } finally {
    agentMonitorRunning = false;
    scheduleAgentMonitor();
  }
}

async function fetchAgentSnapshot(agent) {
  if (!agent.snapshotTarget) {
    return {
      ok: false,
      error: 'Snapshot target is not configured.'
    };
  }

  try {
    const response = await fetch(agent.snapshotTarget, {
      headers: {
        accept: 'application/json'
      }
    });

    if (!response.ok) {
      return {
        ok: false,
        error: `Snapshot request failed with ${response.status}`
      };
    }

    const payload = await response.json();
    const text = normalizeSnapshotText(payload.text);

    return {
      ok: true,
      text,
      capturedAt: payload.capturedAt || new Date().toISOString()
    };
  } catch (error) {
    return {
      ok: false,
      error: error.message || 'Snapshot request failed'
    };
  }
}

function normalizeSnapshotText(value) {
  return String(value || '')
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n');
}

function updateAgentMonitorState(agent, snapshot, monitor, now) {
  const previous = agentMonitorState.get(agent.id);

  if (!snapshot.ok) {
    agentMonitorState.set(agent.id, {
      ...previous,
      status: previous?.status || 'syncing',
      previewText: previous?.previewText || '',
      signature: previous?.signature || '',
      capturedAt: previous?.capturedAt || null,
      error: snapshot.error || 'Snapshot unavailable'
    });
    return;
  }

  const previewText = buildPreviewSnapshot(snapshot.text, monitor);
  const signature = buildSnapshotSignature(snapshot.text, monitor);
  const nextState = !previous
    ? {
        signature,
        previewText,
        capturedAt: snapshot.capturedAt,
        lastChangedAt: null,
        syncChangedAt: null,
        syncSawChange: false,
        syncStableSince: now,
        syncSettledAt: null,
        syncUntil: now + monitor.syncWindowMs,
        status: 'syncing',
        error: null
      }
    : {
        ...previous,
        previewText,
        capturedAt: snapshot.capturedAt,
        error: null
      };

  if (!previous) {
    agentMonitorState.set(agent.id, nextState);
    return;
  }

  if (nextState.signature !== signature) {
    nextState.signature = signature;
    if (nextState.syncUntil) {
      nextState.syncStableSince = now;
      if (nextState.syncSettledAt) {
        nextState.syncChangedAt = now;
      } else {
        nextState.syncSawChange = true;
      }
    } else {
      nextState.lastChangedAt = now;
    }
  } else if (nextState.syncUntil && !nextState.syncSettledAt && now - nextState.syncStableSince >= monitor.settleWindowMs) {
    nextState.syncSettledAt = now;
  }

  if (nextState.syncUntil && now < nextState.syncUntil) {
    nextState.status = 'syncing';
    agentMonitorState.set(agent.id, nextState);
    return;
  }

  if (nextState.syncUntil) {
    nextState.lastChangedAt = nextState.syncSettledAt
      ? nextState.syncChangedAt
      : (nextState.syncSawChange ? nextState.syncStableSince : null);
    nextState.syncChangedAt = null;
    nextState.syncSawChange = false;
    nextState.syncStableSince = null;
    nextState.syncSettledAt = null;
    nextState.syncUntil = null;
  }

  nextState.status = nextState.lastChangedAt && now - nextState.lastChangedAt <= monitor.activeWindowMs
    ? 'active'
    : 'waiting';

  agentMonitorState.set(agent.id, nextState);
}

function buildPreviewSnapshot(text, monitor) {
  const lines = splitSnapshotLines(text);
  const trimmed = trimIgnoredBottomRows(lines, monitor.ignoredBottomRows);
  return trimmed.slice(-snapshotPreviewMaxLines).join('\n');
}

function buildSnapshotSignature(text, monitor) {
  return trimIgnoredBottomRows(splitSnapshotLines(text), monitor.ignoredBottomRows).join('\n');
}

function splitSnapshotLines(text) {
  return normalizeSnapshotText(text).split('\n');
}

function trimIgnoredBottomRows(lines, ignoredBottomRows) {
  const ignoredCount = Math.max(0, Number(ignoredBottomRows || 0));
  const trimmed = ignoredCount ? lines.slice(0, Math.max(1, lines.length - ignoredCount)) : [...lines];
  while (trimmed.length > 1 && trimmed[trimmed.length - 1] === '') {
    trimmed.pop();
  }
  return trimmed;
}

function getHttpsOptions() {
  const keyPath = process.env.SSL_KEY_PATH;
  const certPath = process.env.SSL_CERT_PATH;

  if (keyPath && certPath) {
    return {
      key: fs.readFileSync(path.resolve(keyPath)),
      cert: fs.readFileSync(path.resolve(certPath))
    };
  }

  fs.mkdirSync(certDir, { recursive: true });

  const generatedKeyPath = path.join(certDir, 'localhost.key');
  const generatedCertPath = path.join(certDir, 'localhost.crt');

  if (!fs.existsSync(generatedKeyPath) || !fs.existsSync(generatedCertPath)) {
    const pems = selfsigned.generate(
      [{ name: 'commonName', value: 'localhost' }],
      {
        algorithm: 'sha256',
        days: 365,
        keySize: 2048,
        extensions: [
          {
            name: 'subjectAltName',
            altNames: [
              { type: 2, value: 'localhost' },
              { type: 7, ip: '127.0.0.1' }
            ]
          }
        ]
      }
    );

    fs.writeFileSync(generatedKeyPath, pems.private);
    fs.writeFileSync(generatedCertPath, pems.cert);
  }

  return {
    key: fs.readFileSync(generatedKeyPath),
    cert: fs.readFileSync(generatedCertPath)
  };
}

function displayHost(value) {
  return value === '0.0.0.0' ? 'localhost' : value;
}

function validateAuthConfig() {
  if (!auth.user && !auth.password) {
    return;
  }

  if (!auth.user || !auth.password) {
    throw new Error('Set both AGENT_WATCH_AUTH_USER and AGENT_WATCH_AUTH_PASSWORD, or neither.');
  }
}

function getAuthConfig() {
  const user = process.env.AGENT_WATCH_AUTH_USER || '';
  const password = process.env.AGENT_WATCH_AUTH_PASSWORD || '';
  const secretSeed = process.env.AGENT_WATCH_SESSION_SECRET || `${user}\n${password}\nagent-watch`;

  return {
    enabled: Boolean(user && password),
    user,
    password,
    cookieName: 'agent_watch_session',
    maxAgeMs: 1000 * 60 * 60 * 24 * 30,
    secret: crypto.createHash('sha256').update(secretSeed).digest('hex')
  };
}

function isAuthenticated(req) {
  if (!auth.enabled) {
    return true;
  }

  const cookies = parseCookies(req.headers.cookie || '');
  return verifySessionToken(cookies[auth.cookieName] || '');
}

function parseCookies(rawCookieHeader) {
  const cookies = {};

  for (const part of String(rawCookieHeader).split(';')) {
    const trimmed = part.trim();
    if (!trimmed) {
      continue;
    }

    const separatorIndex = trimmed.indexOf('=');
    if (separatorIndex <= 0) {
      continue;
    }

    const key = trimmed.slice(0, separatorIndex).trim();
    const value = trimmed.slice(separatorIndex + 1).trim();
    cookies[key] = decodeURIComponent(value);
  }

  return cookies;
}

function setAuthCookie(res, req) {
  const cookieParts = [
    `${auth.cookieName}=${encodeURIComponent(issueSessionToken())}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    `Max-Age=${Math.floor(auth.maxAgeMs / 1000)}`
  ];

  if (shouldUseSecureCookies(req)) {
    cookieParts.push('Secure');
  }

  res.setHeader('set-cookie', cookieParts.join('; '));
}

function clearAuthCookie(res, req) {
  const cookieParts = [
    `${auth.cookieName}=`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    'Max-Age=0',
    'Expires=Thu, 01 Jan 1970 00:00:00 GMT'
  ];

  if (shouldUseSecureCookies(req)) {
    cookieParts.push('Secure');
  }

  res.setHeader('set-cookie', cookieParts.join('; '));
}

function shouldUseSecureCookies(req) {
  if (!httpOnly) {
    return true;
  }

  return String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim() === 'https';
}

function issueSessionToken() {
  const expiresAt = Date.now() + auth.maxAgeMs;
  const payload = Buffer.from(`${auth.user}:${expiresAt}`, 'utf8').toString('base64url');
  const signature = signTokenPayload(payload);
  return `${payload}.${signature}`;
}

function verifySessionToken(token) {
  const [payload, signature] = String(token).split('.');
  if (!payload || !signature) {
    return false;
  }

  const expectedSignature = signTokenPayload(payload);
  if (!safeCompare(signature, expectedSignature)) {
    return false;
  }

  let decoded;
  try {
    decoded = Buffer.from(payload, 'base64url').toString('utf8');
  } catch {
    return false;
  }

  const separatorIndex = decoded.indexOf(':');
  if (separatorIndex <= 0) {
    return false;
  }

  const user = decoded.slice(0, separatorIndex);
  const expiresAt = Number.parseInt(decoded.slice(separatorIndex + 1), 10);

  return user === auth.user && Number.isFinite(expiresAt) && Date.now() < expiresAt;
}

function signTokenPayload(payload) {
  return crypto.createHmac('sha256', auth.secret).update(payload).digest('base64url');
}

function safeCompare(left, right) {
  const leftBuffer = Buffer.from(String(left));
  const rightBuffer = Buffer.from(String(right));

  if (leftBuffer.length !== rightBuffer.length) {
    return false;
  }

  return crypto.timingSafeEqual(leftBuffer, rightBuffer);
}

function acceptsHtml(req) {
  const accept = String(req.headers.accept || '');
  return accept.includes('text/html') || accept.includes('*/*');
}

function normalizeNextPath(input) {
  const candidate = String(input || '').trim();

  if (!candidate || !candidate.startsWith('/') || candidate.startsWith('//')) {
    return '/';
  }

  if (candidate === '/login' || candidate.startsWith('/login?')) {
    return '/';
  }

  return candidate;
}

function renderLoginPage({ next, error = '' }) {
  const errorMarkup = error
    ? `<p class="login-card__error" role="alert">${escapeHtml(error)}</p>`
    : '';

  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>Agent Watch Login</title>
    <style>
      :root {
        color-scheme: dark;
        --bg: #13110d;
        --panel: rgba(243, 237, 224, 0.92);
        --panel-border: rgba(130, 96, 57, 0.22);
        --text: #1f1b16;
        --muted: #6b6254;
        --accent: #b7652f;
        --accent-strong: #8c4a21;
        --error-bg: rgba(185, 64, 34, 0.12);
        --error-text: #8c2c11;
      }

      * { box-sizing: border-box; }

      body {
        margin: 0;
        min-height: 100vh;
        display: grid;
        place-items: center;
        background:
          radial-gradient(circle at top left, rgba(182, 101, 47, 0.24), transparent 34%),
          radial-gradient(circle at bottom right, rgba(72, 120, 104, 0.28), transparent 30%),
          linear-gradient(180deg, #13110d 0%, #211b15 100%);
        color: var(--text);
        font-family: "Iowan Old Style", "Palatino Linotype", "Book Antiqua", serif;
        padding: 24px;
      }

      .login-card {
        width: min(420px, 100%);
        padding: 28px 28px 24px;
        border: 1px solid var(--panel-border);
        background: var(--panel);
        border-radius: 18px;
        box-shadow: 0 24px 64px rgba(0, 0, 0, 0.28);
      }

      .login-card__eyebrow {
        margin: 0 0 8px;
        font-size: 12px;
        letter-spacing: 0.18em;
        text-transform: uppercase;
        color: var(--muted);
        font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
      }

      .login-card h1 {
        margin: 0 0 8px;
        font-size: clamp(28px, 5vw, 40px);
        line-height: 1;
      }

      .login-card__copy {
        margin: 0 0 18px;
        color: var(--muted);
        font-size: 15px;
      }

      .login-card__error {
        margin: 0 0 16px;
        padding: 10px 12px;
        border-radius: 10px;
        background: var(--error-bg);
        color: var(--error-text);
        font: 600 14px/1.4 ui-sans-serif, system-ui, sans-serif;
      }

      .login-form {
        display: grid;
        gap: 14px;
      }

      .login-form label {
        display: grid;
        gap: 6px;
        font: 600 14px/1.4 ui-sans-serif, system-ui, sans-serif;
      }

      .login-form input {
        width: 100%;
        border: 1px solid rgba(111, 95, 72, 0.28);
        border-radius: 12px;
        padding: 12px 14px;
        font: 500 15px/1.4 ui-sans-serif, system-ui, sans-serif;
        color: var(--text);
        background: rgba(255, 255, 255, 0.72);
      }

      .login-form input[data-secret="true"] {
        -webkit-text-security: disc;
      }

      .login-form input:focus {
        outline: 2px solid rgba(183, 101, 47, 0.34);
        border-color: rgba(183, 101, 47, 0.5);
      }

      .login-form input[readonly] {
        cursor: text;
      }

      .login-form button {
        margin-top: 6px;
        border: 0;
        border-radius: 12px;
        padding: 12px 16px;
        background: linear-gradient(180deg, var(--accent) 0%, var(--accent-strong) 100%);
        color: #f8f4ec;
        font: 700 15px/1 ui-sans-serif, system-ui, sans-serif;
        cursor: pointer;
      }
    </style>
  </head>
  <body>
    <main class="login-card">
      <p class="login-card__eyebrow">Agent Watch</p>
      <h1>Sign in</h1>
      <p class="login-card__copy">Sign in to view your agent dashboard.</p>
      ${errorMarkup}
      <form class="login-form" method="post" action="/login" autocomplete="off" autocapitalize="off">
        <input type="hidden" name="next" value="${escapeHtml(next)}">
        <label>
          Username
          <input name="login_user" type="text" autocomplete="off" autocapitalize="off" autocorrect="off" spellcheck="false" data-lpignore="true" readonly required>
        </label>
        <label>
          Password
          <input name="login_secret" type="text" inputmode="text" autocomplete="off" autocapitalize="off" autocorrect="off" spellcheck="false" data-lpignore="true" data-secret="true" readonly required>
        </label>
        <button type="submit">Open Agent Watch</button>
      </form>
    </main>
    <script>
      (() => {
        const unlock = (event) => {
          const input = event.currentTarget;
          if (!input.hasAttribute('readonly')) return;
          input.removeAttribute('readonly');
          requestAnimationFrame(() => input.focus());
        };

        document.querySelectorAll('.login-form input').forEach((input) => {
          input.addEventListener('pointerdown', unlock, { passive: true });
          input.addEventListener('touchstart', unlock, { passive: true });
          input.addEventListener('focus', unlock);
        });
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
