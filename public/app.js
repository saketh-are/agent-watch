const app = document.querySelector('#app');
const nav = document.querySelector('#site-nav');
const siteTitle = document.querySelector('#site-title');
const siteSubtitle = document.querySelector('#site-subtitle');
const configButton = document.querySelector('#config-button');
const configModal = document.querySelector('#config-modal');
const configPath = document.querySelector('#config-path');
const configEditor = document.querySelector('#config-editor');
const configStatus = document.querySelector('#config-status');
const configReloadButton = document.querySelector('#config-reload');
const configSaveButton = document.querySelector('#config-save');
const agentOrderStorageKey = 'agent-watch.agent-order';

let route = getRoute(window.location.pathname);

const state = {
  config: null,
  activeHomeAgentId: null,
  configModalOpen: false,
  drag: {
    agentId: null,
    targetId: null,
    position: null
  },
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
nav.addEventListener('dragstart', handleNavDragStart);
nav.addEventListener('dragover', handleNavDragOver);
nav.addEventListener('drop', handleNavDrop);
nav.addEventListener('dragend', handleNavDragEnd);
configButton?.addEventListener('click', () => {
  openConfigModal().catch((error) => {
    setConfigStatus(error.message, true);
  });
});
configModal?.addEventListener('click', handleConfigModalClick);
document.addEventListener('keydown', handleDocumentKeydown);
configReloadButton?.addEventListener('click', () => {
  loadConfigEditor().catch((error) => {
    setConfigStatus(error.message, true);
  });
});
configSaveButton?.addEventListener('click', () => {
  saveConfigEditor().catch((error) => {
    setConfigStatus(error.message, true);
  });
});

async function boot() {
  const response = await fetch('/api/config', { cache: 'no-store' });
  if (!response.ok) {
    throw new Error(`Request failed with ${response.status}`);
  }

  state.config = applyStoredAgentOrder(await response.json());
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
      accent: agent.accent,
      agentId: agent.id,
      draggable: true
    }))
  ];

  nav.innerHTML = links
    .map(
      (link) => `
        <a
          class="nav-link ${link.active ? 'is-active' : ''} ${link.draggable ? 'is-draggable' : ''}"
          href="${link.href}"
          ${link.draggable ? `draggable="true" data-nav-agent-id="${escapeAttr(link.agentId)}"` : ''}
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

  if (state.configModalOpen) {
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

async function openConfigModal() {
  state.configModalOpen = true;
  document.body.classList.add('is-modal-open');
  configModal?.removeAttribute('hidden');
  await loadConfigEditor();
  configEditor?.focus({ preventScroll: true });
}

function closeConfigModal() {
  state.configModalOpen = false;
  document.body.classList.remove('is-modal-open');
  configModal?.setAttribute('hidden', '');
  clearConfigStatus();
}

function handleConfigModalClick(event) {
  if (!(event.target instanceof Element)) {
    return;
  }

  if (event.target.closest('[data-config-close]')) {
    closeConfigModal();
  }
}

function handleDocumentKeydown(event) {
  if (event.key === 'Escape' && state.configModalOpen) {
    event.preventDefault();
    closeConfigModal();
  }
}

async function loadConfigEditor() {
  setConfigStatus('Loading...');
  setConfigEditorBusy(true);

  try {
    const response = await fetch('/api/config-file', { cache: 'no-store' });
    const payload = await response.json();
    if (!response.ok) {
      throw new Error(payload.detail || payload.error || `Request failed with ${response.status}`);
    }

    if (configPath) {
      configPath.textContent = payload.path || '';
    }

    if (configEditor) {
      configEditor.value = payload.raw || '';
    }

    clearConfigStatus();
  } finally {
    setConfigEditorBusy(false);
  }
}

async function saveConfigEditor() {
  const raw = configEditor?.value || '';
  const currentActiveHomeAgentId = state.activeHomeAgentId;

  setConfigStatus('Saving...');
  setConfigEditorBusy(true);

  try {
    const response = await fetch('/api/config-file', {
      method: 'PUT',
      headers: {
        'content-type': 'application/json'
      },
      body: JSON.stringify({ raw })
    });
    const payload = await response.json();
    if (!response.ok) {
      throw new Error(payload.detail || payload.error || `Request failed with ${response.status}`);
    }

    if (configEditor) {
      configEditor.value = payload.raw || raw;
    }

    state.config = applyStoredAgentOrder(payload.config);
    const nextActiveHomeAgentId = state.config.agents.some((agent) => agent.id === currentActiveHomeAgentId)
      ? currentActiveHomeAgentId
      : null;

    initializeViews(state.config);
    state.activeHomeAgentId = nextActiveHomeAgentId;
    renderCurrentRoute();
    setConfigStatus('Saved.');
  } finally {
    setConfigEditorBusy(false);
  }
}

function setConfigEditorBusy(isBusy) {
  configEditor?.toggleAttribute('readonly', isBusy);
  if (configReloadButton instanceof HTMLButtonElement) {
    configReloadButton.disabled = isBusy;
  }
  if (configSaveButton instanceof HTMLButtonElement) {
    configSaveButton.disabled = isBusy;
  }
}

function setConfigStatus(message, isError = false) {
  if (!configStatus) {
    return;
  }

  configStatus.textContent = message;
  configStatus.classList.toggle('is-error', isError);
}

function clearConfigStatus() {
  if (!configStatus) {
    return;
  }

  configStatus.textContent = '';
  configStatus.classList.remove('is-error');
}

function handleNavDragStart(event) {
  if (!(event.target instanceof Element)) {
    return;
  }

  const link = event.target.closest('[data-nav-agent-id]');
  if (!(link instanceof HTMLAnchorElement)) {
    return;
  }

  const { navAgentId: agentId } = link.dataset;
  if (!agentId) {
    return;
  }

  state.drag.agentId = agentId;
  link.classList.add('is-dragging');

  if (event.dataTransfer) {
    event.dataTransfer.effectAllowed = 'move';
    event.dataTransfer.setData('text/plain', agentId);
  }
}

function handleNavDragOver(event) {
  if (!state.drag.agentId || !(event.target instanceof Element)) {
    return;
  }

  const link = event.target.closest('[data-nav-agent-id]');
  if (!(link instanceof HTMLAnchorElement)) {
    clearNavDropIndicator();
    return;
  }

  const { navAgentId: targetId } = link.dataset;
  if (!targetId || targetId === state.drag.agentId) {
    clearNavDropIndicator();
    return;
  }

  event.preventDefault();

  if (event.dataTransfer) {
    event.dataTransfer.dropEffect = 'move';
  }

  setNavDropIndicator(targetId, getNavDropPosition(link, event.clientX));
}

function handleNavDrop(event) {
  if (!state.drag.agentId || !(event.target instanceof Element)) {
    return;
  }

  const link = event.target.closest('[data-nav-agent-id]');
  if (!(link instanceof HTMLAnchorElement)) {
    clearNavDragState();
    return;
  }

  const { navAgentId: targetId } = link.dataset;
  if (!targetId || targetId === state.drag.agentId || !state.drag.position) {
    clearNavDragState();
    return;
  }

  event.preventDefault();
  reorderAgents(state.drag.agentId, targetId, state.drag.position);
  clearNavDragState();
}

function handleNavDragEnd() {
  clearNavDragState();
}

function getNavDropPosition(link, clientX) {
  const bounds = link.getBoundingClientRect();
  return clientX < bounds.left + bounds.width / 2 ? 'before' : 'after';
}

function setNavDropIndicator(targetId, position) {
  clearNavDropIndicator();

  state.drag.targetId = targetId;
  state.drag.position = position;

  const target = nav.querySelector(`[data-nav-agent-id="${CSS.escape(targetId)}"]`);
  if (!(target instanceof HTMLElement)) {
    return;
  }

  target.classList.add(position === 'before' ? 'is-drop-before' : 'is-drop-after');
}

function clearNavDropIndicator() {
  if (state.drag.targetId) {
    const previousTarget = nav.querySelector(`[data-nav-agent-id="${CSS.escape(state.drag.targetId)}"]`);
    previousTarget?.classList.remove('is-drop-before', 'is-drop-after');
  }

  state.drag.targetId = null;
  state.drag.position = null;
}

function clearNavDragState() {
  if (state.drag.agentId) {
    const source = nav.querySelector(`[data-nav-agent-id="${CSS.escape(state.drag.agentId)}"]`);
    source?.classList.remove('is-dragging');
  }

  clearNavDropIndicator();
  state.drag.agentId = null;
}

function reorderAgents(sourceId, targetId, position) {
  const sourceIndex = state.config?.agents.findIndex((agent) => agent.id === sourceId) ?? -1;
  const targetIndex = state.config?.agents.findIndex((agent) => agent.id === targetId) ?? -1;

  if (sourceIndex < 0 || targetIndex < 0 || sourceIndex === targetIndex) {
    return;
  }

  const nextAgents = [...state.config.agents];
  const [movedAgent] = nextAgents.splice(sourceIndex, 1);
  let insertIndex = nextAgents.findIndex((agent) => agent.id === targetId);

  if (insertIndex < 0) {
    return;
  }

  if (position === 'after') {
    insertIndex += 1;
  }

  nextAgents.splice(insertIndex, 0, movedAgent);
  state.config.agents = nextAgents;
  saveStoredAgentOrder(nextAgents);
  syncAgentOrder();
}

function syncAgentOrder() {
  const routeAgent = route.kind === 'agent'
    ? state.config.agents.find((agent) => agent.id === route.agentId) || null
    : null;

  renderShell(state.config, routeAgent);
  syncHomeCardOrder();
  focusRouteTerminal();
}

function syncHomeCardOrder() {
  const homeView = state.views.home;
  if (!homeView) {
    return;
  }

  for (const agent of state.config.agents) {
    const card = homeView.querySelector(`[data-agent-card="${CSS.escape(agent.id)}"]`);
    if (card) {
      homeView.append(card);
    }
  }
}

function applyStoredAgentOrder(config) {
  const storedOrder = loadStoredAgentOrder();
  if (!storedOrder.length || !Array.isArray(config.agents)) {
    return config;
  }

  const agentsById = new Map(config.agents.map((agent) => [agent.id, agent]));
  const orderedAgents = [];

  for (const agentId of storedOrder) {
    const agent = agentsById.get(agentId);
    if (!agent) {
      continue;
    }

    orderedAgents.push(agent);
    agentsById.delete(agentId);
  }

  for (const agent of config.agents) {
    if (agentsById.has(agent.id)) {
      orderedAgents.push(agent);
    }
  }

  return {
    ...config,
    agents: orderedAgents
  };
}

function loadStoredAgentOrder() {
  try {
    const raw = window.localStorage.getItem(agentOrderStorageKey);
    if (!raw) {
      return [];
    }

    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((value) => typeof value === 'string') : [];
  } catch {
    return [];
  }
}

function saveStoredAgentOrder(agents) {
  try {
    window.localStorage.setItem(
      agentOrderStorageKey,
      JSON.stringify(agents.map((agent) => agent.id))
    );
  } catch {}
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
  if (state.configModalOpen || route.kind !== 'home' || !(target instanceof Element)) {
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
