const app = document.querySelector('#app');
const nav = document.querySelector('#site-nav');
const siteTitle = document.querySelector('#site-title');
const siteSubtitle = document.querySelector('#site-subtitle');

let route = getRoute(window.location.pathname);

const state = {
  config: null,
  activeHomeAgentId: null,
  views: {
    empty: null,
    home: null,
    notFound: null,
    detailById: new Map()
  }
};

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

window.addEventListener('popstate', () => {
  route = getRoute(window.location.pathname);
  renderCurrentRoute();
});

document.addEventListener('click', handleDocumentClick);

async function boot() {
  const response = await fetch('/api/config', { cache: 'no-store' });
  if (!response.ok) {
    throw new Error(`Request failed with ${response.status}`);
  }

  state.config = await response.json();
  initializeViews(state.config);
  renderCurrentRoute();
}

function initializeViews(config) {
  app.textContent = '';
  state.activeHomeAgentId = null;
  state.views.empty = null;
  state.views.home = null;
  state.views.notFound = null;
  state.views.detailById.clear();

  if (!config.agents.length) {
    state.views.empty = htmlToElement(renderEmptySetup());
    prepareRouteView(state.views.empty, 'empty');
    app.append(state.views.empty);
    return;
  }

  state.views.home = htmlToElement(`
    <section class="stack route-view route-view--home is-active" data-route-view="home" aria-hidden="false">
      ${config.agents.map(renderPreviewCard).join('')}
    </section>
  `);
  bindHomeTerminals(state.views.home);
  app.append(state.views.home);
}

function renderCurrentRoute() {
  const config = state.config;
  if (!config) {
    return;
  }

  const routeAgent = config.agents.find((agent) => agent.id === route.agentId);
  const isKnownAgentRoute = route.kind === 'agent' && Boolean(routeAgent);

  renderShell(config, isKnownAgentRoute ? routeAgent : null);
  document.body.classList.toggle('route-agent', isKnownAgentRoute);

  if (!config.agents.length) {
    showOnly(state.views.empty);
    return;
  }

  if (route.kind === 'agent' && !routeAgent) {
    showOnly(ensureNotFoundView(route.agentId));
    return;
  }

  if (route.kind === 'agent') {
    disconnectHomeTerminals();
    connectDetailTerminal(routeAgent);
    showOnly(ensureDetailView(routeAgent));
    focusRouteTerminal();
    return;
  }

  disconnectDetailTerminals();
  reconnectHomeTerminals();
  showOnly(state.views.home);
  focusRouteTerminal();
}

function renderShell(config, routeAgent) {
  siteTitle.textContent = config.site.title;
  siteSubtitle.textContent = config.site.subtitle;
  document.title = routeAgent ? `${routeAgent.name} · ${config.site.title}` : config.site.title;

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

function ensureNotFoundView(agentId) {
  if (!state.views.notFound) {
    state.views.notFound = htmlToElement(`
      <section class="empty-state route-view route-view--not-found is-inactive" data-route-view="not-found" aria-hidden="true">
        <p class="eyebrow">Unknown Agent</p>
        <h2></h2>
        <p>Check <code>config/agents.json</code> and restart the server.</p>
      </section>
    `);
    app.append(state.views.notFound);
  }

  const heading = state.views.notFound.querySelector('h2');
  if (heading) {
    heading.innerHTML = `No configured agent matches <code>${escapeHtml(agentId || '')}</code>.`;
  }

  return state.views.notFound;
}

function ensureDetailView(agent) {
  let view = state.views.detailById.get(agent.id);
  if (view) {
    return view;
  }

  view = htmlToElement(renderAgentDetail(agent));
  prepareRouteView(view, 'agent');
  view.dataset.agentId = agent.id;
  const detailFrame = view.querySelector('.terminal-frame--detail');
  if (detailFrame instanceof HTMLIFrameElement) {
    detailFrame.addEventListener('load', () => {
      if (route.kind === 'agent' && route.agentId === agent.id) {
        focusTerminalFrame(detailFrame);
      }
    });
  }
  app.append(view);
  state.views.detailById.set(agent.id, view);
  return view;
}

function showOnly(activeView) {
  const views = [state.views.empty, state.views.home, state.views.notFound, ...state.views.detailById.values()];
  for (const view of views) {
    if (view) {
      const isActive = view === activeView;
      view.classList.toggle('is-active', isActive);
      view.classList.toggle('is-inactive', !isActive);
      view.setAttribute('aria-hidden', String(!isActive));
    }
  }
}

function renderPreviewCard(agent) {
  const badge = agent.badge
    ? `<span class="agent-badge">${escapeHtml(agent.badge)}</span>`
    : '';

  return `
    <article
      class="agent-card"
      style="--agent-accent:${escapeAttr(agent.accent || '#d06d32')}"
      data-agent-card="${escapeAttr(agent.id)}"
    >
      <div class="agent-card__header">
        <div class="agent-card__summary">
          <div class="agent-card__title-row">
            <h3>${escapeHtml(agent.name)}</h3>
            ${badge}
            <p class="agent-card__meta agent-card__meta--inline">${escapeHtml(agent.description || 'No description set')}</p>
          </div>
        </div>
        <div class="agent-card__actions">
          <span class="agent-source">${escapeHtml(agent.source)}</span>
          <a class="agent-button" href="/agents/${agent.id}">Focus</a>
        </div>
      </div>
      <div
        class="agent-card__terminal-wrap"
        data-home-terminal
        data-agent-id="${escapeAttr(agent.id)}"
        data-detail-path="${escapeAttr(agent.detailPath)}"
      >
        <iframe
          class="terminal-frame terminal-frame--preview"
          title="Interactive terminal for ${escapeAttr(agent.name)}"
          data-home-terminal-frame
          referrerpolicy="no-referrer"
        ></iframe>
      </div>
    </article>
  `;
}

function renderAgentDetail(agent) {
  const badge = agent.badge
    ? `<span class="agent-badge">${escapeHtml(agent.badge)}</span>`
    : '';

  return `
    <section class="detail-page route-view route-view--agent is-inactive" data-route-view="agent" aria-hidden="true">
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
          title="Interactive terminal for ${escapeAttr(agent.name)}"
          data-detail-path="${escapeAttr(agent.detailPath)}"
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

function handleDocumentClick(event) {
  if (!(event.target instanceof Element)) {
    return;
  }

  const link = event.target.closest('a[href]');
  if (!link || !shouldHandleNavigation(event, link)) {
    retainHomeTerminalFocus(event.target);
    return;
  }

  const card = link.closest('[data-agent-card]');
  if (card?.dataset.agentCard) {
    state.activeHomeAgentId = card.dataset.agentCard;
  }

  event.preventDefault();
  navigateTo(link.href);
}

function shouldHandleNavigation(event, link) {
  if (event.defaultPrevented || event.button !== 0) {
    return false;
  }

  if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) {
    return false;
  }

  if (link.target && link.target !== '_self') {
    return false;
  }

  if (link.hasAttribute('download')) {
    return false;
  }

  const url = new URL(link.href, window.location.origin);
  if (url.origin !== window.location.origin) {
    return false;
  }

  return url.pathname === '/' || /^\/agents\/[^/]+\/?$/.test(url.pathname);
}

function navigateTo(href) {
  const url = new URL(href, window.location.origin);
  const nextPath = `${url.pathname}${url.search}${url.hash}`;
  const currentPath = `${window.location.pathname}${window.location.search}${window.location.hash}`;

  if (nextPath === currentPath) {
    return;
  }

  history.pushState({}, '', nextPath);
  route = getRoute(url.pathname);
  renderCurrentRoute();
}

function disconnectHomeTerminals() {
  const homeView = state.views.home;
  if (!homeView) {
    return;
  }

  for (const terminal of homeView.querySelectorAll('[data-home-terminal]')) {
    const frame = terminal.querySelector('[data-home-terminal-frame]');
    const card = terminal.closest('[data-agent-card]');
    if (!(frame instanceof HTMLIFrameElement) || !card) {
      continue;
    }

    card.classList.remove('is-live');
    if (frame.getAttribute('src')) {
      frame.removeAttribute('src');
    }
  }
}

function reconnectHomeTerminals() {
  const homeView = state.views.home;
  if (!homeView) {
    return;
  }

  for (const terminal of homeView.querySelectorAll('[data-home-terminal]')) {
    const frame = terminal.querySelector('[data-home-terminal-frame]');
    const detailPath = terminal.dataset.detailPath;
    const card = terminal.closest('[data-agent-card]');
    if (!(frame instanceof HTMLIFrameElement) || !detailPath || !card) {
      continue;
    }

    if (frame.getAttribute('src') !== detailPath) {
      frame.src = detailPath;
    }

    card.classList.toggle('is-live', terminal.dataset.agentId === state.activeHomeAgentId);
  }
}

function disconnectDetailTerminals() {
  for (const view of state.views.detailById.values()) {
    const frame = view.querySelector('.terminal-frame--detail');
    if (!(frame instanceof HTMLIFrameElement)) {
      continue;
    }

    if (frame.getAttribute('src')) {
      frame.removeAttribute('src');
    }
  }
}

function connectDetailTerminal(agent) {
  const view = ensureDetailView(agent);
  const frame = view.querySelector('.terminal-frame--detail');
  if (!(frame instanceof HTMLIFrameElement)) {
    return;
  }

  if (frame.getAttribute('src') !== agent.detailPath) {
    frame.src = agent.detailPath;
  }
}

function bindHomeTerminals(homeView) {
  for (const terminal of homeView.querySelectorAll('[data-home-terminal]')) {
    const frame = terminal.querySelector('[data-home-terminal-frame]');
    const card = terminal.closest('[data-agent-card]');
    if (!(frame instanceof HTMLIFrameElement) || !card) {
      continue;
    }

    frame.addEventListener('focus', () => {
      const { agentId } = terminal.dataset;
      if (!agentId) {
        return;
      }

      state.activeHomeAgentId = agentId;
      for (const siblingCard of homeView.querySelectorAll('[data-agent-card]')) {
        siblingCard.classList.toggle('is-live', siblingCard.dataset.agentCard === agentId);
      }
    });

    frame.addEventListener('load', () => {
      if (route.kind === 'home' && terminal.dataset.agentId === state.activeHomeAgentId) {
        focusTerminalFrame(frame);
      }
    });
  }
}

function prepareRouteView(view, type) {
  view.classList.add('route-view', `route-view--${type}`);
  view.classList.add('is-inactive');
  view.setAttribute('aria-hidden', 'true');
}

function htmlToElement(markup) {
  const template = document.createElement('template');
  template.innerHTML = markup.trim();
  return template.content.firstElementChild;
}

function focusRouteTerminal() {
  if (route.kind === 'agent') {
    const activeView = state.views.detailById.get(route.agentId);
    const frame = activeView?.querySelector('.terminal-frame--detail');
    focusTerminalFrame(frame);
    return;
  }

  const selector = state.activeHomeAgentId
    ? `[data-home-terminal][data-agent-id="${CSS.escape(state.activeHomeAgentId)}"] [data-home-terminal-frame]`
    : null;
  const frame = selector ? state.views.home?.querySelector(selector) : null;
  focusTerminalFrame(frame);
}

function retainHomeTerminalFocus(target) {
  if (route.kind !== 'home' || !(target instanceof Element)) {
    return;
  }

  if (target.closest('[data-home-terminal]')) {
    return;
  }

  const selector = state.activeHomeAgentId
    ? `[data-home-terminal][data-agent-id="${CSS.escape(state.activeHomeAgentId)}"] [data-home-terminal-frame]`
    : null;
  const frame = selector ? state.views.home?.querySelector(selector) : null;
  if (!frame) {
    return;
  }

  requestAnimationFrame(() => focusTerminalFrame(frame));
}

function focusTerminalFrame(frame) {
  if (!(frame instanceof HTMLIFrameElement)) {
    return;
  }

  let attempts = 0;

  const tryFocus = () => {
    if (!frame.isConnected) {
      return;
    }

    let focused = false;

    try {
      frame.focus();
      frame.contentWindow?.focus();

      const term = frame.contentWindow?.term;
      if (term && typeof term.focus === 'function') {
        term.focus();
        if (typeof term.scrollToBottom === 'function') {
          term.scrollToBottom();
        }
        focused = true;
      }

      const doc = frame.contentDocument;
      const viewport = doc?.querySelector('.xterm-viewport');
      if (viewport instanceof HTMLElement) {
        viewport.scrollTop = viewport.scrollHeight;
      }
      const helper = doc?.querySelector('.xterm-helper-textarea');
      if (helper instanceof HTMLElement) {
        helper.focus({ preventScroll: true });
        focused = true;
      } else {
        const xterm = doc?.querySelector('.xterm');
        if (xterm instanceof HTMLElement) {
          xterm.focus({ preventScroll: true });
          focused = true;
        }
      }
    } catch {}

    attempts += 1;
    if (attempts < 12) {
      setTimeout(tryFocus, focused ? 40 : 120);
    }
  };

  requestAnimationFrame(tryFocus);
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
