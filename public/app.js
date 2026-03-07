const app = document.querySelector('#app');
const nav = document.querySelector('#site-nav');
const siteTitle = document.querySelector('#site-title');
const siteSubtitle = document.querySelector('#site-subtitle');

const route = getRoute(window.location.pathname);

boot().catch((error) => {
  console.error(error);
  app.innerHTML = `
    <section class="empty-state">
      <p class="eyebrow">Load Error</p>
      <h2>Dashboard config could not be loaded.</h2>
      <p>${escapeHtml(error.message)}</p>
    </section>
  `;
});

window.addEventListener('popstate', () => window.location.reload());

async function boot() {
  const response = await fetch('/api/config', { cache: 'no-store' });
  if (!response.ok) {
    throw new Error(`Request failed with ${response.status}`);
  }

  const config = await response.json();
  renderShell(config);
  renderPage(config);
}

function renderShell(config) {
  siteTitle.textContent = config.site.title;
  siteSubtitle.textContent = config.site.subtitle;
  document.title = route.agent
    ? `${route.agent.name || route.agentId} · ${config.site.title}`
    : config.site.title;

  const links = [
    { href: '/', label: 'Home', active: route.kind === 'home' },
    ...config.agents.map((agent) => ({
      href: `/agents/${agent.id}`,
      label: agent.name,
      active: route.kind === 'agent' && route.agentId === agent.id,
      accent: agent.accent
    }))
  ];

  nav.innerHTML = links
    .map(
      (link) => `
        <a
          class="nav-link ${link.active ? 'is-active' : ''}"
          href="${link.href}"
          ${link.accent ? `style="--agent-accent:${escapeAttr(link.accent)}"` : ''}
        >
          ${escapeHtml(link.label)}
        </a>
      `
    )
    .join('');
}

function renderPage(config) {
  const routeAgent = config.agents.find((agent) => agent.id === route.agentId);
  const isAgentRoute = route.kind === 'agent' && Boolean(routeAgent);

  document.body.classList.toggle('route-agent', isAgentRoute);

  if (!config.agents.length) {
    app.innerHTML = renderEmptySetup();
    return;
  }

  if (route.kind === 'agent' && !routeAgent) {
    app.innerHTML = `
      <section class="empty-state">
        <p class="eyebrow">Unknown Agent</p>
        <h2>No configured agent matches <code>${escapeHtml(route.agentId)}</code>.</h2>
        <p>Check <code>config/agents.json</code> and restart the server.</p>
      </section>
    `;
    return;
  }

  if (route.kind === 'agent') {
    route.agent = routeAgent;
    document.title = `${routeAgent.name} · ${config.site.title}`;
    app.innerHTML = renderAgentDetail(routeAgent);
    return;
  }

  app.innerHTML = `
    <section class="stack">
      ${config.agents.map(renderPreviewCard).join('')}
    </section>
  `;
}

function renderPreviewCard(agent) {
  const badge = agent.badge
    ? `<span class="agent-badge">${escapeHtml(agent.badge)}</span>`
    : '';

  return `
    <article class="agent-card" style="--agent-accent:${escapeAttr(agent.accent || '#d06d32')}">
      <div class="agent-card__header">
        <div>
          <div class="agent-card__title-row">
            <h3>${escapeHtml(agent.name)}</h3>
            ${badge}
          </div>
          <p class="agent-card__meta">${escapeHtml(agent.description || 'No description set')}</p>
        </div>
        <div class="agent-card__actions">
          <span class="agent-source">${escapeHtml(agent.source)}</span>
          <a class="agent-button" href="/agents/${agent.id}">Focus</a>
        </div>
      </div>
      <div class="agent-card__terminal-wrap">
        <iframe
          class="terminal-frame terminal-frame--preview"
          src="${agent.previewPath}"
          title="Preview of ${escapeAttr(agent.name)}"
          loading="lazy"
          referrerpolicy="no-referrer"
        ></iframe>
        <a class="terminal-overlay" href="/agents/${agent.id}" aria-label="Open ${escapeAttr(agent.name)}"></a>
      </div>
    </article>
  `;
}

function renderAgentDetail(agent) {
  const badge = agent.badge
    ? `<span class="agent-badge">${escapeHtml(agent.badge)}</span>`
    : '';

  return `
    <section class="detail-page">
      <section class="detail-header" style="--agent-accent:${escapeAttr(agent.accent || '#d06d32')}">
        <div class="detail-header__summary">
          <div class="detail-header__title-row">
            <h2>${escapeHtml(agent.name)}</h2>
            ${badge}
          </div>
        </div>
        <div class="detail-header__actions">
          <span class="agent-source">${escapeHtml(agent.source)}</span>
          <a class="agent-button agent-button--secondary" href="${agent.detailPath}" target="_blank" rel="noreferrer">
            Open terminal only
          </a>
        </div>
      </section>
      <section class="detail-terminal">
        <iframe
          class="terminal-frame terminal-frame--detail"
          src="${agent.detailPath}"
          title="Interactive terminal for ${escapeAttr(agent.name)}"
          referrerpolicy="no-referrer"
        ></iframe>
      </section>
    </section>
  `;
}

function renderEmptySetup() {
  return `
    <section class="empty-state">
      <p class="eyebrow">No Agents Yet</p>
      <h2>Add your ttyd endpoints and restart the server.</h2>
      <ol class="setup-list">
        <li>Copy <code>config/agents.example.json</code> to <code>config/agents.json</code>.</li>
        <li>Set each agent <code>target</code> to the ttyd URL you want proxied.</li>
        <li>Run <code>npm start</code> and open <code>https://localhost:3443</code>.</li>
      </ol>
    </section>
  `;
}

function getRoute(pathname) {
  const agentMatch = pathname.match(/^\/agents\/([^/]+)\/?$/);
  if (agentMatch) {
    return { kind: 'agent', agentId: decodeURIComponent(agentMatch[1]) };
  }

  return { kind: 'home' };
}

function escapeHtml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function escapeAttr(value) {
  return escapeHtml(value);
}
