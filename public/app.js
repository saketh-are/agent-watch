const app = document.querySelector('#app');
const nav = document.querySelector('#site-nav');
const siteTitle = document.querySelector('#site-title');
const siteSubtitle = document.querySelector('#site-subtitle');
const currentTerminalLink = document.querySelector('#current-terminal-link');
const configButton = document.querySelector('#config-button');
const configModal = document.querySelector('#config-modal');
const configPath = document.querySelector('#config-path');
const configEditor = document.querySelector('#config-editor');
const configStatus = document.querySelector('#config-status');
const configReloadButton = document.querySelector('#config-reload');
const configSaveButton = document.querySelector('#config-save');
const agentOrderStorageKey = 'agent-watch.agent-order';
const inactiveAlertCooldownMs = 1200;
const hiddenStatePollMs = 5000;
const defaultMonitorConfig = Object.freeze({
  pollMs: 1000,
  activeWindowMs: 5000,
  syncWindowMs: 5000,
  settleWindowMs: 1000,
  ignoredBottomRows: 1
});

let route = getRoute(window.location.pathname);

const state = {
  config: null,
  activeHomeAgentId: null,
  configModalOpen: false,
  activity: {
    pollTimeoutId: null,
    livePollTimeoutId: null,
    requestInFlight: false,
    byAgent: new Map(),
    serverStatusByAgent: new Map(),
    liveStatusByAgent: new Map(),
    liveSampleByAgent: new Map(),
    statusByAgent: new Map(),
    snapshotByAgent: new Map()
  },
  audio: {
    context: null,
    armed: false,
    lastPlayedAt: 0
  },
  drag: {
    agentId: null,
    targetId: null,
    position: null
  },
  nav: {
    orderKey: '',
    homeLink: null,
    agentLinks: new Map()
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
document.addEventListener('visibilitychange', handleDocumentVisibilityChange);
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
  const [configResponse, stateResponse] = await Promise.all([
    fetch('/api/config', { cache: 'no-store' }),
    fetch('/api/state', { cache: 'no-store' })
  ]);

  if (!configResponse.ok) {
    throw new Error(`Request failed with ${configResponse.status}`);
  }

  state.config = applyStoredAgentOrder(await configResponse.json());
  initializeViews(state.config);
  if (stateResponse.ok) {
    applyDashboardState(await stateResponse.json());
  }
  renderCurrentRoute();
  startDashboardStatePolling();
  startLiveActivityPolling();
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
    syncHomeTerminals(routeAgent.id);
    connectDetailTerminal(routeAgent);
    showOnly(ensureDetailView(routeAgent));
    focusRouteTerminal();
    return;
  }

  disconnectDetailTerminals();
  syncHomeTerminals();
  showOnly(state.views.home);
  focusRouteTerminal();
}

function renderShell(config, routeAgent) {
  siteTitle.textContent = config.site.title;
  siteSubtitle.textContent = config.site.subtitle;
  document.title = routeAgent ? `${routeAgent.name} · ${config.site.title}` : config.site.title;

  if (currentTerminalLink instanceof HTMLAnchorElement) {
    if (routeAgent) {
      currentTerminalLink.hidden = false;
      currentTerminalLink.href = routeAgent.detailPath;
      currentTerminalLink.textContent = routeAgent.source;
      currentTerminalLink.setAttribute('aria-label', `Open ${routeAgent.name} terminal only`);
      currentTerminalLink.title = 'Open terminal only';
    } else {
      currentTerminalLink.hidden = true;
      currentTerminalLink.removeAttribute('href');
      currentTerminalLink.textContent = '';
      currentTerminalLink.removeAttribute('aria-label');
      currentTerminalLink.removeAttribute('title');
    }
  }
  ensureNavLinks(config);
  updateNavSelection();
  syncNavActivityStatuses();
}

function ensureNavLinks(config) {
  const orderKey = config.agents.map((agent) => agent.id).join('|');
  if (state.nav.orderKey === orderKey && state.nav.homeLink && state.nav.agentLinks.size === config.agents.length) {
    return;
  }

  state.nav.orderKey = orderKey;
  state.nav.agentLinks.clear();
  nav.textContent = '';

  const homeLink = htmlToElement(`
    <a class="nav-link" href="/" aria-label="Home" title="Home">🏠</a>
  `);
  nav.append(homeLink);
  state.nav.homeLink = homeLink;

  for (const agent of config.agents) {
    const link = htmlToElement(`
      <a
        class="nav-link is-draggable is-status-syncing"
        href="/agents/${escapeAttr(agent.id)}"
        draggable="true"
        data-nav-agent-id="${escapeAttr(agent.id)}"
        data-agent-status="syncing"
        style="--agent-accent:${escapeAttr(agent.accent || '#d06d32')}"
      >
        ${escapeHtml(agent.name)}
      </a>
    `);
    nav.append(link);
    state.nav.agentLinks.set(agent.id, link);
  }
}

function updateNavSelection() {
  state.nav.homeLink?.classList.toggle('is-active', route.kind === 'home');

  for (const [agentId, link] of state.nav.agentLinks.entries()) {
    link.classList.toggle('is-active', route.kind === 'agent' && route.agentId === agentId);
  }
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
      class="agent-card is-status-syncing"
      style="--agent-accent:${escapeAttr(agent.accent || '#d06d32')}"
      data-agent-card="${escapeAttr(agent.id)}"
    >
      <div class="agent-card__header">
        <div class="agent-card__summary">
          <div class="agent-card__title-row">
            <h3>${escapeHtml(agent.name)}</h3>
            ${badge}
            <span class="agent-status is-syncing" data-agent-status>Syncing</span>
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
        data-preview-path="${escapeAttr(agent.previewPath)}"
        data-detail-path="${escapeAttr(agent.detailPath)}"
      >
        <pre
          class="terminal-snapshot"
          data-home-snapshot
          data-snapshot-text
          aria-label="Snapshot for ${escapeAttr(agent.name)}"
        ></pre>
        <iframe
          class="terminal-frame terminal-frame--home"
          title="Interactive terminal for ${escapeAttr(agent.name)}"
          data-home-terminal-frame
          referrerpolicy="no-referrer"
          hidden
        ></iframe>
      </div>
    </article>
  `;
}

function renderAgentDetail(agent) {
  return `
    <section class="detail-page route-view route-view--agent is-inactive" data-route-view="agent" aria-hidden="true">
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

  armInactiveAlertAudio();

  if (state.configModalOpen) {
    return;
  }

  if (route.kind === 'home') {
    const homeTerminal = event.target.closest('[data-home-terminal]');
    if (homeTerminal instanceof HTMLElement && !event.target.closest('a, button')) {
      const { agentId } = homeTerminal.dataset;
      if (agentId) {
        activateHomeTerminal(agentId);
        return;
      }
    }
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
  armInactiveAlertAudio();

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
    refreshDashboardState().catch((error) => {
      console.error(error);
    });
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

function syncHomeTerminals(excludedAgentId = null) {
  const homeView = state.views.home;
  if (!homeView) {
    return;
  }

  for (const terminal of homeView.querySelectorAll('[data-home-terminal]')) {
    const frame = terminal.querySelector('[data-home-terminal-frame]');
    const snapshot = terminal.querySelector('[data-home-snapshot]');
    const previewPath = terminal.dataset.previewPath;
    const detailPath = terminal.dataset.detailPath;
    const { agentId } = terminal.dataset;
    const card = terminal.closest('[data-agent-card]');
    if (!(frame instanceof HTMLIFrameElement) || !detailPath || !card || !agentId) {
      continue;
    }

    const shouldConnect = route.kind === 'home'
      && agentId === state.activeHomeAgentId
      && agentId !== excludedAgentId
      && !hasConnectedDetailTerminal(agentId);

    const desiredSrc = route.kind === 'home' && agentId !== excludedAgentId
      ? (shouldConnect ? detailPath : (previewPath || detailPath))
      : '';

    if (desiredSrc) {
      if (frame.getAttribute('src') !== desiredSrc) {
        terminal.dataset.frameReady = 'false';
        frame.src = desiredSrc;
      }
      frame.hidden = false;
      if (terminal.dataset.frameReady === 'true') {
        snapshot?.setAttribute('hidden', '');
      } else {
        snapshot?.removeAttribute('hidden');
      }
    } else {
      terminal.dataset.frameReady = 'false';
      if (frame.getAttribute('src')) {
        frame.removeAttribute('src');
      }
      frame.hidden = true;
      snapshot?.removeAttribute('hidden');
    }

    card.classList.toggle('is-live', shouldConnect);
  }
}

function hasConnectedDetailTerminal(agentId) {
  const detailView = state.views.detailById.get(agentId);
  const detailFrame = detailView?.querySelector('.terminal-frame--detail');
  return detailFrame instanceof HTMLIFrameElement && Boolean(detailFrame.getAttribute('src'));
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

function activateHomeTerminal(agentId) {
  if (!agentId) {
    return;
  }

  state.activeHomeAgentId = agentId;
  syncHomeTerminals(route.kind === 'agent' ? route.agentId : null);
  focusRouteTerminal();
}

function bindHomeTerminals(homeView) {
  for (const terminal of homeView.querySelectorAll('[data-home-terminal]')) {
    const frame = terminal.querySelector('[data-home-terminal-frame]');
    const snapshot = terminal.querySelector('[data-home-snapshot]');
    const card = terminal.closest('[data-agent-card]');
    if (!(frame instanceof HTMLIFrameElement) || !card) {
      continue;
    }

    frame.addEventListener('focus', () => {
      const { agentId } = terminal.dataset;
      if (!agentId) {
        return;
      }

      activateHomeTerminal(agentId);
    });

    frame.addEventListener('load', () => {
      terminal.dataset.frameReady = 'true';
      snapshot?.setAttribute('hidden', '');
      if (route.kind === 'home' && terminal.dataset.agentId === state.activeHomeAgentId) {
        focusTerminalFrame(frame);
      }
    });
  }
}

function startDashboardStatePolling() {
  stopDashboardStatePolling();
  scheduleDashboardStatePoll(0);
}

function startLiveActivityPolling() {
  stopLiveActivityPolling();
  scheduleLiveActivityPoll(0);
}

function stopDashboardStatePolling() {
  if (state.activity.pollTimeoutId !== null) {
    window.clearTimeout(state.activity.pollTimeoutId);
    state.activity.pollTimeoutId = null;
  }
  state.activity.requestInFlight = false;
}

function stopLiveActivityPolling() {
  if (state.activity.livePollTimeoutId !== null) {
    window.clearTimeout(state.activity.livePollTimeoutId);
    state.activity.livePollTimeoutId = null;
  }
}

function handleDocumentVisibilityChange() {
  if (!state.config) {
    return;
  }

  scheduleDashboardStatePoll(document.hidden ? getDashboardStatePollDelay() : 0);
  scheduleLiveActivityPoll(document.hidden ? getDashboardStatePollDelay() : 0);
}

function scheduleDashboardStatePoll(delayMs = getDashboardStatePollDelay()) {
  if (state.activity.pollTimeoutId !== null) {
    window.clearTimeout(state.activity.pollTimeoutId);
  }

  state.activity.pollTimeoutId = window.setTimeout(() => {
    refreshDashboardState().catch((error) => {
      console.error(error);
      scheduleDashboardStatePoll();
    });
  }, Math.max(0, delayMs));
}

function scheduleLiveActivityPoll(delayMs = getDashboardStatePollDelay()) {
  if (state.activity.livePollTimeoutId !== null) {
    window.clearTimeout(state.activity.livePollTimeoutId);
  }

  state.activity.livePollTimeoutId = window.setTimeout(() => {
    try {
      refreshLiveActivityState();
    } catch (error) {
      console.error(error);
    } finally {
      scheduleLiveActivityPoll();
    }
  }, Math.max(0, delayMs));
}

function getDashboardStatePollDelay() {
  return document.hidden
    ? Math.max(hiddenStatePollMs, getMonitorConfig().pollMs * 5)
    : getMonitorConfig().pollMs;
}

async function refreshDashboardState() {
  if (state.activity.requestInFlight) {
    return;
  }

  state.activity.requestInFlight = true;

  try {
    const response = await fetch('/api/state', { cache: 'no-store' });
    if (!response.ok) {
      throw new Error(`State request failed with ${response.status}`);
    }

    applyDashboardState(await response.json());
  } finally {
    state.activity.requestInFlight = false;
    scheduleDashboardStatePoll();
  }
}

function applyDashboardState(payload) {
  const seenIds = new Set();
  let shouldPlayInactiveAlert = false;

  for (const agentState of payload?.agents || []) {
    const agentId = agentState.id;
    if (!agentId) {
      continue;
    }

    seenIds.add(agentId);
    state.activity.byAgent.set(agentId, agentState);
    const snapshotText = agentState.snapshot || agentState.error || '';
    state.activity.snapshotByAgent.set(agentId, snapshotText);
    const previousStatus = getDisplayedAgentStatus(agentId);
    const nextStatus = agentState.status || 'syncing';
    state.activity.serverStatusByAgent.set(agentId, nextStatus);
    setAgentSnapshotText(agentId, snapshotText);
    syncDisplayedAgentStatus(agentId);
    shouldPlayInactiveAlert ||= previousStatus === 'active' && getDisplayedAgentStatus(agentId) === 'waiting';
  }

  for (const agent of state.config?.agents || []) {
    if (seenIds.has(agent.id)) {
      continue;
    }

    state.activity.serverStatusByAgent.set(agent.id, 'syncing');
    setAgentSnapshotText(agent.id, '');
    syncDisplayedAgentStatus(agent.id);
  }

  if (shouldPlayInactiveAlert) {
    playInactiveAlertSound();
  }
}

function getMonitorConfig() {
  return state.config?.monitor || defaultMonitorConfig;
}

function setAgentSnapshotText(agentId, snapshot) {
  const element = state.views.home?.querySelector(
    `[data-home-terminal][data-agent-id="${CSS.escape(agentId)}"] [data-snapshot-text]`
  );
  if (!(element instanceof HTMLElement)) {
    return;
  }

  element.textContent = snapshot || '';
  requestAnimationFrame(() => {
    element.scrollTop = element.scrollHeight;
  });
}

function refreshLiveActivityState() {
  const now = Date.now();
  const activeAgentIds = new Set();

  for (const agent of state.config?.agents || []) {
    const source = getLiveAgentSource(agent.id);
    if (!source) {
      continue;
    }

    activeAgentIds.add(agent.id);
    const signature = readVisibleTerminalSignature(source.frame);
    if (signature === null) {
      continue;
    }

    const previous = state.activity.liveSampleByAgent.get(agent.id);
    const nextSample = previous && previous.sourceKey === source.sourceKey
      ? { ...previous }
      : { sourceKey: source.sourceKey, signature: null, lastChangedAt: null };

    if (nextSample.signature !== signature) {
      nextSample.signature = signature;
      nextSample.lastChangedAt = now;
    }

    state.activity.liveSampleByAgent.set(agent.id, nextSample);
    state.activity.liveStatusByAgent.set(
      agent.id,
      nextSample.lastChangedAt && now - nextSample.lastChangedAt <= getMonitorConfig().activeWindowMs
        ? 'active'
        : 'waiting'
    );
    syncDisplayedAgentStatus(agent.id);
  }

  for (const agent of state.config?.agents || []) {
    if (activeAgentIds.has(agent.id)) {
      continue;
    }

    if (state.activity.liveStatusByAgent.delete(agent.id) || state.activity.liveSampleByAgent.delete(agent.id)) {
      syncDisplayedAgentStatus(agent.id);
    }
  }
}

function getLiveAgentSource(agentId) {
  const detailView = state.views.detailById.get(agentId);
  const detailFrame = detailView?.querySelector('.terminal-frame--detail');
  if (detailFrame instanceof HTMLIFrameElement && detailFrame.getAttribute('src')) {
    return { frame: detailFrame, sourceKey: `detail:${agentId}` };
  }

  const homeFrame = state.views.home?.querySelector(
    `[data-home-terminal][data-agent-id="${CSS.escape(agentId)}"] [data-home-terminal-frame]`
  );
  if (homeFrame instanceof HTMLIFrameElement && homeFrame.getAttribute('src')) {
    return { frame: homeFrame, sourceKey: `home:${agentId}` };
  }

  return null;
}

function readVisibleTerminalSignature(frame) {
  try {
    const term = frame.contentWindow?.term;
    const activeBuffer = term?.buffer?.active;
    const rows = Number(term?.rows || 0);
    if (!activeBuffer || rows < 1 || typeof activeBuffer.getLine !== 'function') {
      return null;
    }

    const { ignoredBottomRows } = getMonitorConfig();
    const startRow = Number(activeBuffer.viewportY ?? activeBuffer.baseY ?? 0);
    const visibleRowCount = Math.max(rows - ignoredBottomRows, 1);
    const lines = [];

    for (let row = 0; row < visibleRowCount; row += 1) {
      const line = activeBuffer.getLine(startRow + row);
      if (!line || typeof line.translateToString !== 'function') {
        lines.push('');
        continue;
      }

      lines.push(line.translateToString(true));
    }

    return lines.join('\n');
  } catch {
    return null;
  }
}

function getDisplayedAgentStatus(agentId) {
  return state.activity.statusByAgent.get(agentId)
    || state.activity.liveStatusByAgent.get(agentId)
    || state.activity.serverStatusByAgent.get(agentId)
    || 'syncing';
}

function syncDisplayedAgentStatus(agentId) {
  const nextStatus = state.activity.liveStatusByAgent.get(agentId)
    || state.activity.serverStatusByAgent.get(agentId)
    || 'syncing';
  setAgentActivityStatus(agentId, nextStatus);
}

function setAgentActivityStatus(agentId, status) {
  const card = agentId
    ? state.views.home?.querySelector(`[data-agent-card="${CSS.escape(agentId)}"]`)
    : null;
  const label = card?.querySelector('[data-agent-status]');
  const nextText = {
    active: 'Active',
    waiting: 'Waiting',
    syncing: 'Syncing'
  }[status] || 'Syncing';

  if (agentId) {
    state.activity.statusByAgent.set(agentId, status);
    setNavAgentActivityStatus(agentId, status);
  }

  if (card instanceof HTMLElement) {
    card.classList.toggle('is-status-active', status === 'active');
    card.classList.toggle('is-status-waiting', status === 'waiting');
    card.classList.toggle('is-status-syncing', status === 'syncing');
  }

  if (!(label instanceof HTMLElement)) {
    return;
  }

  label.textContent = nextText;
  label.classList.toggle('is-active', status === 'active');
  label.classList.toggle('is-waiting', status === 'waiting');
  label.classList.toggle('is-syncing', status === 'syncing');
}

function syncNavActivityStatuses() {
  for (const agent of state.config?.agents || []) {
    const status = state.activity.statusByAgent.get(agent.id) || 'syncing';
    setNavAgentActivityStatus(agent.id, status);
  }
}

function setNavAgentActivityStatus(agentId, status) {
  const link = state.nav.agentLinks.get(agentId);
  if (!(link instanceof HTMLElement)) {
    return;
  }

  link.classList.toggle('is-status-active', status === 'active');
  link.classList.toggle('is-status-waiting', status === 'waiting');
  link.classList.toggle('is-status-syncing', status === 'syncing');

  if (status) {
    link.dataset.agentStatus = status;
  } else {
    delete link.dataset.agentStatus;
  }
}

function armInactiveAlertAudio() {
  const AudioContextClass = window.AudioContext || window.webkitAudioContext;
  if (!AudioContextClass) {
    return;
  }

  if (!state.audio.context) {
    state.audio.context = new AudioContextClass();
  }

  const context = state.audio.context;
  if (!context) {
    return;
  }

  if (context.state === 'running') {
    state.audio.armed = true;
    return;
  }

  context.resume()
    .then(() => {
      state.audio.armed = context.state === 'running';
    })
    .catch(() => {});
}

function playInactiveAlertSound() {
  armInactiveAlertAudio();

  const context = state.audio.context;
  if (!context || context.state !== 'running' || !state.audio.armed) {
    return;
  }

  const nowMs = Date.now();
  if (nowMs - state.audio.lastPlayedAt < inactiveAlertCooldownMs) {
    return;
  }

  state.audio.lastPlayedAt = nowMs;

  const oscillator = context.createOscillator();
  const gain = context.createGain();
  const startAt = context.currentTime;
  const endAt = startAt + 0.18;

  oscillator.type = 'triangle';
  oscillator.frequency.setValueAtTime(880, startAt);
  oscillator.frequency.exponentialRampToValueAtTime(660, endAt);

  gain.gain.setValueAtTime(0.0001, startAt);
  gain.gain.exponentialRampToValueAtTime(0.026, startAt + 0.02);
  gain.gain.exponentialRampToValueAtTime(0.0001, endAt);

  oscillator.connect(gain);
  gain.connect(context.destination);
  oscillator.start(startAt);
  oscillator.stop(endAt);
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
  if (frame instanceof HTMLIFrameElement && !frame.getAttribute('src')) {
    return;
  }
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
  if (!(frame instanceof HTMLIFrameElement) || !frame.getAttribute('src')) {
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
