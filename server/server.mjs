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
  const parsedUrl = new URL(req.url || '/', 'http://127.0.0.1');
  const match = parsedUrl.pathname.match(/^\/terminal\/([^/]+)\/([^/]+)(\/.*)?$/);

  if (!match) {
    socket.destroy();
    return;
  }

  const [, id, mode] = match;
  if (!isSupportedMode(mode)) {
    socket.destroy();
    return;
  }

  let config;
  try {
    config = loadConfig();
  } catch {
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
});

try {
  loadConfig();
} catch (error) {
  console.error(`[agent-watch] ${error.message}`);
  process.exit(1);
}

server.listen(port, host, () => {
  const protocol = httpOnly ? 'http' : 'https';
  console.log(`[agent-watch] listening on ${protocol}://${displayHost(host)}:${port}`);
  console.log(`[agent-watch] config: ${configPath}`);
  if (!httpOnly) {
    console.log(`[agent-watch] using local TLS certificate from ${certDir}`);
  }
});

function loadConfig() {
  if (!fs.existsSync(configPath)) {
    return {
      site: {
        title: 'Agent Watch',
        subtitle: 'Private ttyd dashboard for live agent sessions'
      },
      agents: []
    };
  }

  const raw = fs.readFileSync(configPath, 'utf8');
  const parsed = JSON.parse(raw);
  const agents = Array.isArray(parsed.agents) ? parsed.agents : [];
  validateAgents(agents);

  return {
    site: {
      title: parsed.site?.title || 'Agent Watch',
      subtitle: parsed.site?.subtitle || 'Private ttyd dashboard for live agent sessions'
    },
    agents
  };
}

function buildPublicConfig(config) {
  return {
    site: config.site,
    agents: config.agents.map((agent) => {
      const detailUpstream = getUpstream(agent, 'detail');
      return {
        id: agent.id,
        name: agent.name,
        description: agent.description || '',
        badge: agent.badge || '',
        accent: agent.accent || '#d06d32',
        source: detailUpstream.host,
        previewPath: `/terminal/${encodeURIComponent(agent.id)}/preview/`,
        detailPath: `/terminal/${encodeURIComponent(agent.id)}/detail/`
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
  }
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

        const patchedBody = injectTerminalUnloadPatch(rawBody.toString('utf8'));
        responseHeaders['content-length'] = String(Buffer.byteLength(patchedBody));
        responseHeaders['content-type'] = contentType || 'text/html; charset=utf-8';
        res.writeHead(upstreamRes.statusCode || 200, responseHeaders);
        res.end(patchedBody);
      });
    }
  );

  upstreamReq.on('error', (error) => {
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

function injectTerminalUnloadPatch(html) {
  if (html.includes('data-agent-watch="disable-unload-warning"')) {
    return html;
  }

  if (html.includes('</head>')) {
    return html.replace('</head>', `${terminalUnloadPatch}</head>`);
  }

  return `${terminalUnloadPatch}${html}`;
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
