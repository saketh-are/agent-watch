const app = document.querySelector('#app');
const nav = document.querySelector('#site-nav');
const modeSwitcher = document.querySelector('#mode-switcher');
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
const ansiSgrPattern = /\x1b\[([0-9;]*)m/g;
const nonSgrAnsiPattern = /\x1b(?:\][^\u0007]*(?:\u0007|\x1b\\)|\[[0-?]*[ -/]*[@-ln-z~]|[@-Z\\-_])/g;
const ansiDefaultForeground = '#d9e1ea';
const ansiDefaultBackground = '#11161a';
const ansiBasePalette = ['#262b33', '#e06c75', '#98c379', '#e5c07b', '#61afef', '#c678dd', '#56b6c2', '#d7dae0'];
const ansiBrightPalette = ['#4f5666', '#ff7b86', '#b6e38b', '#ffd27a', '#7cc7ff', '#d49cff', '#7adfe4', '#f2f6fa'];
const defaultMonitorConfig = Object.freeze({
  pollMs: 1000,
  activeWindowMs: 5000,
  syncWindowMs: 5000,
  settleWindowMs: 1000,
  ignoredBottomRows: 1
});

let route = getRoute(window.location.pathname, window.location.search);

const state = {
  config: null,
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
  chat: {
    pollTimeoutId: null,
    requestInFlight: false,
    activeAgentId: null,
    byAgent: new Map(),
    filterByAgent: new Map(),
    sendingByAgent: new Set(),
    summaryOpenByAgent: new Map(),
    didInitialScrollByAgent: new Map()
  },
  codex: {
    pollTimeoutId: null,
    requestInFlight: false,
    activeAgentId: null,
    byAgent: new Map(),
    filterByAgent: new Map(),
    sendingByAgent: new Set(),
    summaryOpenByAgent: new Map(),
    didInitialScrollByAgent: new Map()
  },
  history: {
    pollTimeoutId: null,
    requestInFlight: false,
    activeAgentId: null,
    byAgent: new Map(),
    didInitialScrollByAgent: new Map()
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
  },
  routeTerminalFocusToken: 0
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
  route = getRoute(window.location.pathname, window.location.search);
  renderCurrentRoute();
});

document.addEventListener('click', handleDocumentClick);
document.addEventListener('submit', handleDocumentSubmit);
document.addEventListener('keydown', handleComposerKeydown);
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
window.addEventListener('resize', syncAppViewportHeight);
window.visualViewport?.addEventListener('resize', syncAppViewportHeight);
window.visualViewport?.addEventListener('scroll', syncAppViewportHeight);
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
  syncAppViewportHeight();
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

function syncAppViewportHeight() {
  const viewportHeight = Math.round(window.visualViewport?.height || window.innerHeight || 0);
  if (!viewportHeight) {
    return;
  }

  document.documentElement.style.setProperty('--app-viewport-height', `${viewportHeight}px`);
}

function initializeViews(config) {
  app.textContent = '';
  state.chat.didInitialScrollByAgent.clear();
  state.codex.didInitialScrollByAgent.clear();
  state.history.didInitialScrollByAgent.clear();
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
      ${renderHomePlaceholder()}
    </section>
  `);
  app.append(state.views.home);

  for (const agent of config.agents) {
    ensureDetailView(agent);
  }
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
    const detailView = ensureDetailView(routeAgent);
    syncAgentDetailMode(routeAgent, detailView);
    syncDetailTerminalConnections(routeAgent);
    const mode = getAgentViewMode(routeAgent);
    if (mode === 'claude') {
      stopCodexChatPolling();
      stopHistoryPolling();
      startClaudeChatPolling(routeAgent);
    } else if (mode === 'codex') {
      stopClaudeChatPolling();
      stopHistoryPolling();
      startCodexChatPolling(routeAgent);
    } else if (mode === 'history') {
      stopClaudeChatPolling();
      stopCodexChatPolling();
      startHistoryPolling(routeAgent);
    } else {
      stopClaudeChatPolling();
      stopCodexChatPolling();
      stopHistoryPolling();
    }
    showOnly(detailView);
    if (mode === 'byobu') {
      focusRouteTerminal();
    }
    return;
  }

  stopClaudeChatPolling();
  stopCodexChatPolling();
  stopHistoryPolling();
  syncDetailTerminalConnections(null);
  showOnly(state.views.home);
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
  renderModeSwitcher(routeAgent);
  updateNavSelection();
  syncNavActivityStatuses();
}

function renderModeSwitcher(routeAgent) {
  if (!(modeSwitcher instanceof HTMLElement)) {
    return;
  }

  if (!routeAgent) {
    modeSwitcher.hidden = true;
    modeSwitcher.textContent = '';
    return;
  }

  const supportsClaude = Boolean(routeAgent.claudeCurrentPath);
  const supportsCodex = Boolean(routeAgent.codexCurrentPath);
  const supportsHistory = Boolean(routeAgent.historyPath);
  const mode = getAgentViewMode(routeAgent);
  const byobuHref = `/agents/${encodeURIComponent(routeAgent.id)}?view=byobu`;
  const claudeHref = `/agents/${encodeURIComponent(routeAgent.id)}?view=claude`;
  const codexHref = `/agents/${encodeURIComponent(routeAgent.id)}?view=codex`;
  const historyHref = `/agents/${encodeURIComponent(routeAgent.id)}?view=history`;

  modeSwitcher.hidden = false;
  const links = [];
  if (supportsCodex) {
    links.push(`
      <a class="mode-switcher__link ${mode === 'codex' ? 'is-active' : ''}" href="${escapeAttr(codexHref)}" title="Codex" aria-label="Codex">🤖</a>
    `);
  }
  if (supportsClaude) {
    links.push(`
      <a class="mode-switcher__link ${mode === 'claude' ? 'is-active' : ''}" href="${escapeAttr(claudeHref)}" title="Claude" aria-label="Claude">✴️</a>
    `);
  }
  if (supportsHistory) {
    links.push(`
      <a class="mode-switcher__link ${mode === 'history' ? 'is-active' : ''}" href="${escapeAttr(historyHref)}" title="History" aria-label="History">📜</a>
    `);
  }
  links.push(`
    <a class="mode-switcher__link ${mode === 'byobu' ? 'is-active' : ''}" href="${escapeAttr(byobuHref)}" title="Byobu" aria-label="Byobu">🖥️</a>
  `);
  modeSwitcher.innerHTML = links.join('');
}

function getAgentViewMode(agent) {
  if (route.view === 'history' && agent?.historyPath) {
    return 'history';
  }

  if (route.view === 'codex' && agent?.codexCurrentPath) {
    return 'codex';
  }

  if (route.view === 'claude' && agent?.claudeCurrentPath) {
    return 'claude';
  }

  if (!agent?.claudeCurrentPath && !agent?.codexCurrentPath) {
    return 'byobu';
  }

  return 'byobu';
}

function getActiveByobuAgentId() {
  if (route.kind !== 'agent') {
    return null;
  }

  const agent = state.config?.agents.find((item) => item.id === route.agentId);
  if (!agent || getAgentViewMode(agent) !== 'byobu') {
    return null;
  }

  return agent.id;
}

function getWarmDetailPath(detailPath) {
  const separator = detailPath.includes('?') ? '&' : '?';
  return `${detailPath}${separator}agent_watch_focus=0`;
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
    const warmDetailPath = getWarmDetailPath(agent.detailPath);
    if (detailFrame.getAttribute('src') !== warmDetailPath) {
      detailFrame.setAttribute('src', warmDetailPath);
    }
    detailFrame.addEventListener('load', () => {
      syncDetailTerminalConnections(route.kind === 'agent'
        ? state.config?.agents.find((item) => item.id === route.agentId) || null
        : null);
      if (route.kind === 'agent' && route.agentId === agent.id && getAgentViewMode(agent) === 'byobu') {
        focusRouteTerminal();
      }
    });
  }
  syncAgentDetailMode(agent, view, route.kind === 'agent' && route.agentId === agent.id ? null : 'byobu');
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
      view.inert = !isActive;
    }
  }
}

function syncDetailTerminalConnections(activeAgent) {
  const activeAgentId = activeAgent?.id || null;
  const activeByobuAgentId = Boolean(activeAgentId) && getAgentViewMode(activeAgent) === 'byobu'
    ? activeAgentId
    : null;

  for (const agent of state.config?.agents || []) {
    const detailView = state.views.detailById.get(agent.id);
    const frame = detailView?.querySelector('.terminal-frame--detail');
    if (!(frame instanceof HTMLIFrameElement)) {
      continue;
    }

    const warmDetailPath = getWarmDetailPath(agent.detailPath);
    if (frame.getAttribute('src') !== warmDetailPath) {
      frame.setAttribute('src', warmDetailPath);
    }

    const isActive = agent.id === activeByobuAgentId;
    syncTerminalFrameInputState(frame, isActive);
    frame.tabIndex = isActive ? 0 : -1;
    if (!isActive) {
      blurTerminalFrame(frame);
    }
  }
}

function renderHomePlaceholder() {
  return `
    <section class="empty-state">
      <p class="eyebrow">Home</p>
      <h2>No dashboard widgets yet.</h2>
    </section>
  `;
}

function renderAgentDetail(agent) {
  const panels = [];

  if (agent.claudeCurrentPath) {
    panels.push(`
        <section class="detail-panel detail-panel--chat" data-detail-panel="claude">
          <section class="chat-page" data-chat-page data-agent-id="${escapeAttr(agent.id)}">
            <header class="chat-page__header">
              <div>
                <p class="eyebrow">Claude</p>
                <h2>Session Transcript</h2>
              </div>
              <div class="chat-page__actions">
                <button class="chat-toggle" type="button" data-chat-summary-toggle data-agent-id="${escapeAttr(agent.id)}">Show sidebar</button>
                <span class="agent-status is-syncing" data-chat-status>Syncing</span>
              </div>
            </header>
            <section class="chat-session-meta" data-chat-meta>
              <span>Waiting for session metadata…</span>
            </section>
            <section class="chat-page__layout">
              <div class="chat-page__main">
                <div class="chat-filters" data-chat-filters>
                  ${renderChatFilterButton(agent.id, 'all', 'All')}
                  ${renderChatFilterButton(agent.id, 'prompts', 'Prompts')}
                  ${renderChatFilterButton(agent.id, 'tools', 'Tool calls')}
                  ${renderChatFilterButton(agent.id, 'errors', 'Errors')}
                </div>
                <div class="chat-page__body" data-chat-body>
                  <p class="chat-page__empty">Connecting to the Claude worker…</p>
                </div>
                ${agent.claudePromptPath ? `
                  <form class="chat-compose" data-chat-compose data-agent-id="${escapeAttr(agent.id)}">
                    <textarea
                      class="chat-compose__input"
                      data-chat-input
                      rows="3"
                      placeholder="Send a new message to Claude…"
                    ></textarea>
                  </form>
                ` : ''}
              </div>
              <aside class="chat-sidebar" data-chat-summary>
                <p class="chat-page__empty">Waiting for session summary…</p>
              </aside>
            </section>
          </section>
        </section>
    `);
  }

  if (agent.codexCurrentPath) {
    panels.push(`
        <section class="detail-panel detail-panel--chat" data-detail-panel="codex">
          <section class="chat-page" data-codex-page data-agent-id="${escapeAttr(agent.id)}">
            <header class="chat-page__header">
              <div>
                <p class="eyebrow">Codex</p>
                <h2>Session Transcript</h2>
              </div>
              <div class="chat-page__actions">
                <button class="chat-toggle" type="button" data-codex-summary-toggle data-agent-id="${escapeAttr(agent.id)}">Show sidebar</button>
                <span class="agent-status is-syncing" data-codex-status>Syncing</span>
              </div>
            </header>
            <section class="chat-session-meta" data-codex-meta>
              <span>Waiting for session metadata…</span>
            </section>
            <section class="chat-page__layout">
              <div class="chat-page__main">
                <div class="chat-filters" data-codex-filters>
                  ${renderCodexFilterButton(agent.id, 'all', 'All')}
                  ${renderCodexFilterButton(agent.id, 'prompts', 'Prompts')}
                  ${renderCodexFilterButton(agent.id, 'tools', 'Tool calls')}
                  ${renderCodexFilterButton(agent.id, 'errors', 'Errors')}
                </div>
                <div class="chat-page__body" data-codex-body>
                  <p class="chat-page__empty">Connecting to the Codex worker…</p>
                </div>
                ${agent.codexPromptPath ? `
                  <form class="chat-compose" data-codex-compose data-agent-id="${escapeAttr(agent.id)}">
                    <textarea
                      class="chat-compose__input"
                      data-codex-input
                      rows="3"
                      placeholder="Send a new message to Codex…"
                    ></textarea>
                  </form>
                ` : ''}
              </div>
              <aside class="chat-sidebar" data-codex-summary>
                <p class="chat-page__empty">Waiting for session summary…</p>
              </aside>
            </section>
          </section>
        </section>
    `);
  }

  if (agent.historyPath) {
    panels.push(`
        <section class="detail-panel detail-panel--history" data-detail-panel="history">
          <section class="history-page" data-history-page data-agent-id="${escapeAttr(agent.id)}">
            <header class="history-page__header">
              <div>
                <p class="eyebrow">History</p>
                <h2>Byobu Scrollback</h2>
              </div>
              <div class="history-page__actions">
                <span class="agent-status is-syncing" data-history-status>Syncing</span>
              </div>
            </header>
            <section class="history-session-meta" data-history-meta>
              <span>Loading pane history…</span>
            </section>
            <div class="history-page__body" data-history-body>
              <p class="chat-page__empty">Loading terminal history…</p>
            </div>
          </section>
        </section>
    `);
  }

  panels.push(`
        <section class="detail-panel detail-panel--terminal" data-detail-panel="byobu">
          <section class="detail-terminal">
            <iframe
              class="terminal-frame terminal-frame--detail"
              title="Interactive terminal for ${escapeAttr(agent.name)}"
              data-detail-path="${escapeAttr(agent.detailPath)}"
              referrerpolicy="no-referrer"
            ></iframe>
          </section>
        </section>
  `);

  return `
    <section class="detail-page route-view route-view--agent is-inactive" data-route-view="agent" aria-hidden="true">
      ${panels.join('')}
    </section>
  `;
}

function syncAgentDetailMode(agent, view, modeOverride = null) {
  if (!(view instanceof HTMLElement)) {
    return;
  }

  const mode = modeOverride || getAgentViewMode(agent);
  for (const panel of view.querySelectorAll('[data-detail-panel]')) {
    if (!(panel instanceof HTMLElement)) {
      continue;
    }

    const isActive = panel.dataset.detailPanel === mode;
    panel.classList.toggle('is-active', isActive);
    panel.classList.toggle('is-inactive', !isActive);
    panel.setAttribute('aria-hidden', String(!isActive));
    panel.inert = !isActive;
  }
}

function renderChatFilterButton(agentId, value, label) {
  return `
    <button
      class="chat-filter"
      type="button"
      data-chat-filter="${escapeAttr(value)}"
      data-agent-id="${escapeAttr(agentId)}"
    >
      ${escapeHtml(label)}
    </button>
  `;
}

function renderCodexFilterButton(agentId, value, label) {
  return `
    <button
      class="chat-filter"
      type="button"
      data-codex-filter="${escapeAttr(value)}"
      data-agent-id="${escapeAttr(agentId)}"
    >
      ${escapeHtml(label)}
    </button>
  `;
}

function getChatFilter(agentId) {
  return state.chat.filterByAgent.get(agentId) || 'all';
}

function getCodexFilter(agentId) {
  return state.codex.filterByAgent.get(agentId) || 'all';
}

function isChatSummaryOpen(agentId) {
  return state.chat.summaryOpenByAgent.get(agentId) || false;
}

function isCodexSummaryOpen(agentId) {
  return state.codex.summaryOpenByAgent.get(agentId) || false;
}

function applyChatFilter(agentId, turns) {
  const filter = getChatFilter(agentId);
  if (filter === 'tools') {
    return turns.filter((turn) => (turn.toolUses || []).length || (turn.toolResults || []).length);
  }
  if (filter === 'errors') {
    return turns.filter((turn) => turn.error || (turn.toolResults || []).some((item) => item.isError));
  }
  return turns;
}

function applyCodexFilter(agentId, turns) {
  const filter = getCodexFilter(agentId);
  if (filter === 'tools') {
    return turns.filter((turn) => (turn.toolUses || []).length || (turn.toolResults || []).length);
  }
  if (filter === 'errors') {
    return turns.filter((turn) => turn.error || (turn.toolResults || []).some((item) => item.isError));
  }
  return turns;
}

function syncChatFilters(agentId) {
  const view = state.views.detailById.get(agentId);
  const filter = getChatFilter(agentId);
  for (const button of view?.querySelectorAll('[data-chat-filter]') || []) {
    button.classList.toggle('is-active', button.dataset.chatFilter === filter);
  }
}

function syncCodexFilters(agentId) {
  const view = state.views.detailById.get(agentId);
  const filter = getCodexFilter(agentId);
  for (const button of view?.querySelectorAll('[data-codex-filter]') || []) {
    button.classList.toggle('is-active', button.dataset.codexFilter === filter);
  }
}

function syncChatSummaryVisibility(agentId) {
  const view = state.views.detailById.get(agentId);
  const layout = view?.querySelector('[data-chat-page] .chat-page__layout');
  const toggle = view?.querySelector('[data-chat-summary-toggle]');
  const isOpen = isChatSummaryOpen(agentId);
  layout?.classList.toggle('is-summary-open', isOpen);
  if (toggle instanceof HTMLButtonElement) {
    toggle.textContent = isOpen ? 'Hide sidebar' : 'Show sidebar';
  }
}

function syncCodexSummaryVisibility(agentId) {
  const view = state.views.detailById.get(agentId);
  const layout = view?.querySelector('[data-codex-page] .chat-page__layout');
  const toggle = view?.querySelector('[data-codex-summary-toggle]');
  const isOpen = isCodexSummaryOpen(agentId);
  layout?.classList.toggle('is-summary-open', isOpen);
  if (toggle instanceof HTMLButtonElement) {
    toggle.textContent = isOpen ? 'Hide sidebar' : 'Show sidebar';
  }
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

  const filterButton = event.target.closest('[data-chat-filter]');
  if (filterButton instanceof HTMLButtonElement) {
    const { agentId, chatFilter } = filterButton.dataset;
    if (agentId && chatFilter) {
      state.chat.filterByAgent.set(agentId, chatFilter);
      renderClaudeChat(agentId, state.chat.byAgent.get(agentId));
      return;
    }
  }

  const codexFilterButton = event.target.closest('[data-codex-filter]');
  if (codexFilterButton instanceof HTMLButtonElement) {
    const { agentId, codexFilter } = codexFilterButton.dataset;
    if (agentId && codexFilter) {
      state.codex.filterByAgent.set(agentId, codexFilter);
      renderCodexChat(agentId, state.codex.byAgent.get(agentId));
      return;
    }
  }

  const summaryToggle = event.target.closest('[data-chat-summary-toggle]');
  if (summaryToggle instanceof HTMLButtonElement) {
    const { agentId } = summaryToggle.dataset;
    if (agentId) {
      state.chat.summaryOpenByAgent.set(agentId, !isChatSummaryOpen(agentId));
      syncChatSummaryVisibility(agentId);
      return;
    }
  }

  const codexSummaryToggle = event.target.closest('[data-codex-summary-toggle]');
  if (codexSummaryToggle instanceof HTMLButtonElement) {
    const { agentId } = codexSummaryToggle.dataset;
    if (agentId) {
      state.codex.summaryOpenByAgent.set(agentId, !isCodexSummaryOpen(agentId));
      syncCodexSummaryVisibility(agentId);
      return;
    }
  }

  const link = event.target.closest('a[href]');
  if (!link || !shouldHandleNavigation(event, link)) {
    return;
  }

  event.preventDefault();
  navigateTo(link.href);
}

function handleDocumentSubmit(event) {
  if (!(event.target instanceof HTMLFormElement)) {
    return;
  }

  const form = event.target.closest('[data-chat-compose]');
  if (!(form instanceof HTMLFormElement)) {
    const codexForm = event.target.closest('[data-codex-compose]');
    if (!(codexForm instanceof HTMLFormElement)) {
      return;
    }

    event.preventDefault();
    const { agentId } = codexForm.dataset;
    if (!agentId) {
      return;
    }

    submitCodexPrompt(agentId, codexForm).catch((error) => {
      console.error(error);
    });
    return;
  }

  event.preventDefault();
  const { agentId } = form.dataset;
  if (!agentId) {
    return;
  }

  submitClaudePrompt(agentId, form).catch((error) => {
    console.error(error);
  });
}

function handleComposerKeydown(event) {
  if (!(event.target instanceof HTMLTextAreaElement) || !event.target.matches('[data-chat-input]')) {
    if (!(event.target instanceof HTMLTextAreaElement) || !event.target.matches('[data-codex-input]')) {
      return;
    }

    if (event.key !== 'Enter' || event.shiftKey) {
      return;
    }

    const form = event.target.closest('[data-codex-compose]');
    if (!(form instanceof HTMLFormElement)) {
      return;
    }

    event.preventDefault();
    const { agentId } = form.dataset;
    if (!agentId) {
      return;
    }

    submitCodexPrompt(agentId, form).catch((error) => {
      console.error(error);
    });
    return;
  }

  if (event.key !== 'Enter' || event.shiftKey) {
    return;
  }

  const form = event.target.closest('[data-chat-compose]');
  if (!(form instanceof HTMLFormElement)) {
    return;
  }

  event.preventDefault();
  const { agentId } = form.dataset;
  if (!agentId) {
    return;
  }

  submitClaudePrompt(agentId, form).catch((error) => {
    console.error(error);
  });
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
  route = getRoute(url.pathname, url.search);
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
    return;
  }

  if (!event.altKey || event.metaKey || event.ctrlKey || event.shiftKey) {
    return;
  }

  if (isEditableShortcutTarget(event.target)) {
    return;
  }

  const shortcutTarget = getShortcutNavigationTarget(event);
  if (!shortcutTarget) {
    return;
  }

  event.preventDefault();
  navigateTo(shortcutTarget);
}

function isEditableShortcutTarget(target) {
  if (!(target instanceof Element)) {
    return false;
  }

  if (target.closest('[contenteditable="true"]')) {
    return true;
  }

  return target.matches('input, textarea, select, [contenteditable="true"]');
}

function getShortcutNavigationTarget(event) {
  const key = String(event.key || '');
  if (!/^\d$/.test(key)) {
    return null;
  }

  if (key === '0') {
    return '/';
  }

  const agentIndex = Number.parseInt(key, 10) - 1;
  const agent = state.config?.agents?.[agentIndex];
  if (!agent) {
    return null;
  }

  return `/agents/${encodeURIComponent(agent.id)}`;
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
    initializeViews(state.config);
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
}

function applyStoredAgentOrder(config) {
  const storedOrder = loadStoredAgentOrder();
  if (!storedOrder.length || !Array.isArray(config.agents)) {
    return config;
  }

  const agentsById = new Map(config.agents.map((agent) => [agent.id, agent]));
  const storedAgents = [];
  const storedAgentIds = new Set();

  for (const agentId of storedOrder) {
    const agent = agentsById.get(agentId);
    if (!agent) {
      continue;
    }

    storedAgents.push(agent);
    storedAgentIds.add(agentId);
  }

  if (!storedAgents.length) {
    return config;
  }

  const unknownAgentsBySlot = new Map();
  let storedAgentsSeenInConfig = 0;

  for (const agent of config.agents) {
    if (storedAgentIds.has(agent.id)) {
      storedAgentsSeenInConfig += 1;
      continue;
    }

    const slot = storedAgentsSeenInConfig;
    const bucket = unknownAgentsBySlot.get(slot) || [];
    bucket.push(agent);
    unknownAgentsBySlot.set(slot, bucket);
  }

  const orderedAgents = [];

  for (let index = 0; index <= storedAgents.length; index += 1) {
    const unknownAgents = unknownAgentsBySlot.get(index);
    if (unknownAgents) {
      orderedAgents.push(...unknownAgents);
    }

    if (index < storedAgents.length) {
      orderedAgents.push(storedAgents[index]);
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


function startDashboardStatePolling() {
  stopDashboardStatePolling();
  scheduleDashboardStatePoll(0);
}

function startLiveActivityPolling() {
  stopLiveActivityPolling();
  scheduleLiveActivityPoll(0);
}

function startClaudeChatPolling(agent) {
  if (!agent?.claudeCurrentPath) {
    stopClaudeChatPolling();
    return;
  }

  state.chat.activeAgentId = agent.id;
  scheduleClaudeChatPoll(0);
}

function startCodexChatPolling(agent) {
  if (!agent?.codexCurrentPath) {
    stopCodexChatPolling();
    return;
  }

  state.codex.activeAgentId = agent.id;
  scheduleCodexChatPoll(0);
}

function startHistoryPolling(agent) {
  if (!agent?.historyPath) {
    stopHistoryPolling();
    return;
  }

  state.history.activeAgentId = agent.id;
  scheduleHistoryPoll(0);
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

function stopClaudeChatPolling() {
  if (state.chat.pollTimeoutId !== null) {
    window.clearTimeout(state.chat.pollTimeoutId);
    state.chat.pollTimeoutId = null;
  }

  state.chat.requestInFlight = false;
  state.chat.activeAgentId = null;
}

function stopCodexChatPolling() {
  if (state.codex.pollTimeoutId !== null) {
    window.clearTimeout(state.codex.pollTimeoutId);
    state.codex.pollTimeoutId = null;
  }

  state.codex.requestInFlight = false;
  state.codex.activeAgentId = null;
}

function stopHistoryPolling() {
  if (state.history.pollTimeoutId !== null) {
    window.clearTimeout(state.history.pollTimeoutId);
    state.history.pollTimeoutId = null;
  }

  state.history.requestInFlight = false;
  state.history.activeAgentId = null;
}

function handleDocumentVisibilityChange() {
  if (!state.config) {
    return;
  }

  scheduleDashboardStatePoll(document.hidden ? getDashboardStatePollDelay() : 0);
  scheduleLiveActivityPoll(document.hidden ? getDashboardStatePollDelay() : 0);
  scheduleClaudeChatPoll(document.hidden ? getDashboardStatePollDelay() : 0);
  scheduleCodexChatPoll(document.hidden ? getDashboardStatePollDelay() : 0);
  scheduleHistoryPoll(document.hidden ? getDashboardStatePollDelay() : 0);
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

function scheduleClaudeChatPoll(delayMs = getDashboardStatePollDelay()) {
  if (state.chat.activeAgentId === null) {
    return;
  }

  if (state.chat.pollTimeoutId !== null) {
    window.clearTimeout(state.chat.pollTimeoutId);
  }

  state.chat.pollTimeoutId = window.setTimeout(() => {
    refreshClaudeChatState().catch((error) => {
      console.error(error);
      scheduleClaudeChatPoll();
    });
  }, Math.max(0, delayMs));
}

function scheduleCodexChatPoll(delayMs = getDashboardStatePollDelay()) {
  if (state.codex.activeAgentId === null) {
    return;
  }

  if (state.codex.pollTimeoutId !== null) {
    window.clearTimeout(state.codex.pollTimeoutId);
  }

  state.codex.pollTimeoutId = window.setTimeout(() => {
    refreshCodexChatState().catch((error) => {
      console.error(error);
      scheduleCodexChatPoll();
    });
  }, Math.max(0, delayMs));
}

function scheduleHistoryPoll(delayMs = getDashboardStatePollDelay()) {
  if (state.history.activeAgentId === null) {
    return;
  }

  if (state.history.pollTimeoutId !== null) {
    window.clearTimeout(state.history.pollTimeoutId);
  }

  state.history.pollTimeoutId = window.setTimeout(() => {
    refreshHistoryState().catch((error) => {
      console.error(error);
      scheduleHistoryPoll();
    });
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

async function refreshClaudeChatState() {
  const agentId = state.chat.activeAgentId;
  const agent = agentId
    ? state.config?.agents.find((item) => item.id === agentId)
    : null;

  if (!agent?.claudeCurrentPath || state.chat.requestInFlight) {
    return;
  }

  state.chat.requestInFlight = true;

  try {
    const response = await fetch(agent.claudeCurrentPath, { cache: 'no-store' });
    const payload = await response.json();
    if (!response.ok) {
      throw new Error(payload.detail || payload.error || `Claude request failed with ${response.status}`);
    }
    state.chat.byAgent.set(agent.id, payload);
    renderClaudeChat(agent.id, payload);
  } catch (error) {
    renderClaudeChat(agent.id, { error: error.message });
  } finally {
    state.chat.requestInFlight = false;
    scheduleClaudeChatPoll();
  }
}

async function refreshCodexChatState() {
  const agentId = state.codex.activeAgentId;
  const agent = agentId
    ? state.config?.agents.find((item) => item.id === agentId)
    : null;

  if (!agent?.codexCurrentPath || state.codex.requestInFlight) {
    return;
  }

  state.codex.requestInFlight = true;

  try {
    const response = await fetch(agent.codexCurrentPath, { cache: 'no-store' });
    const payload = await response.json();
    if (!response.ok) {
      throw new Error(payload.detail || payload.error || `Codex request failed with ${response.status}`);
    }
    state.codex.byAgent.set(agent.id, payload);
    renderCodexChat(agent.id, payload);
  } catch (error) {
    renderCodexChat(agent.id, { error: error.message });
  } finally {
    state.codex.requestInFlight = false;
    scheduleCodexChatPoll();
  }
}

async function refreshHistoryState() {
  const agentId = state.history.activeAgentId;
  const agent = agentId
    ? state.config?.agents.find((item) => item.id === agentId)
    : null;

  if (!agent?.historyPath || state.history.requestInFlight) {
    return;
  }

  state.history.requestInFlight = true;

  try {
    const response = await fetch(`${agent.historyPath}?lines=10000`, { cache: 'no-store' });
    const payload = await response.json();
    if (!response.ok) {
      throw new Error(payload.detail || payload.error || `History request failed with ${response.status}`);
    }
    state.history.byAgent.set(agent.id, payload);
    renderHistory(agent.id, payload);
  } catch (error) {
    renderHistory(agent.id, { error: error.message });
  } finally {
    state.history.requestInFlight = false;
    scheduleHistoryPoll();
  }
}

async function submitClaudePrompt(agentId, form) {
  const agent = state.config?.agents.find((item) => item.id === agentId);
  const input = form.querySelector('[data-chat-input]');
  if (!agent?.claudePromptPath || !(input instanceof HTMLTextAreaElement)) {
    return;
  }

  const text = input.value.trim();
  if (!text || state.chat.sendingByAgent.has(agentId)) {
    return;
  }

  state.chat.sendingByAgent.add(agentId);
  input.disabled = true;
  input.placeholder = 'Sending…';

  try {
    const response = await fetch(agent.claudePromptPath, {
      method: 'POST',
      headers: {
        'content-type': 'application/json'
      },
      body: JSON.stringify({ text })
    });
    const payload = await response.json();
    if (!response.ok) {
      throw new Error(payload.detail || payload.error || `Prompt request failed with ${response.status}`);
    }

    input.value = '';
    refreshClaudeChatState().catch((error) => {
      console.error(error);
    });
  } catch (error) {
    alert(error.message);
  } finally {
    state.chat.sendingByAgent.delete(agentId);
    input.disabled = false;
    input.placeholder = 'Send a new message to Claude…';
    input.focus();
  }
}

async function submitCodexPrompt(agentId, form) {
  const agent = state.config?.agents.find((item) => item.id === agentId);
  const input = form.querySelector('[data-codex-input]');
  if (!agent?.codexPromptPath || !(input instanceof HTMLTextAreaElement)) {
    return;
  }

  const text = input.value.trim();
  if (!text || state.codex.sendingByAgent.has(agentId)) {
    return;
  }

  state.codex.sendingByAgent.add(agentId);
  input.disabled = true;
  input.placeholder = 'Sending…';

  try {
    const response = await fetch(agent.codexPromptPath, {
      method: 'POST',
      headers: {
        'content-type': 'application/json'
      },
      body: JSON.stringify({ text })
    });
    const payload = await response.json();
    if (!response.ok) {
      throw new Error(payload.detail || payload.error || `Prompt request failed with ${response.status}`);
    }

    input.value = '';
    refreshCodexChatState().catch((error) => {
      console.error(error);
    });
  } catch (error) {
    alert(error.message);
  } finally {
    state.codex.sendingByAgent.delete(agentId);
    input.disabled = false;
    input.placeholder = 'Send a new message to Codex…';
    input.focus();
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
  return;
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
  if (agentId) {
    state.activity.statusByAgent.set(agentId, status);
    setNavAgentActivityStatus(agentId, status);
  }
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

function renderClaudeChat(agentId, payload) {
  const view = state.views.detailById.get(agentId);
  const status = view?.querySelector('[data-chat-status]');
  const body = view?.querySelector('[data-chat-body]');
  const meta = view?.querySelector('[data-chat-meta]');
  const summary = view?.querySelector('[data-chat-summary]');
  if (!(status instanceof HTMLElement) || !(body instanceof HTMLElement) || !(meta instanceof HTMLElement) || !(summary instanceof HTMLElement)) {
    return;
  }

  syncChatFilters(agentId);
  syncChatSummaryVisibility(agentId);

  if (payload?.error) {
    status.textContent = 'Error';
    status.className = 'agent-status is-waiting';
    meta.innerHTML = '<span>Claude worker unavailable</span>';
    summary.innerHTML = `<p class="chat-page__empty">${escapeHtml(payload.error)}</p>`;
    body.innerHTML = `<p class="chat-page__empty">${escapeHtml(payload.error)}</p>`;
    return;
  }

  const session = payload?.session || null;
  if (!session) {
    status.textContent = 'Idle';
    status.className = 'agent-status is-syncing';
    meta.innerHTML = '<span>No active Claude session</span>';
    summary.innerHTML = '<p class="chat-page__empty">No session summary yet.</p>';
    body.innerHTML = '<p class="chat-page__empty">No Claude session transcript is available yet.</p>';
    return;
  }

  const statusText = {
    running: 'Running',
    waiting: 'Waiting',
    error: 'Error'
  }[session.status] || 'Syncing';
  status.textContent = statusText;
  status.className = `agent-status ${session.status === 'running' ? 'is-active' : session.status === 'error' ? 'is-waiting' : 'is-syncing'}`;
  meta.innerHTML = renderChatMeta(session);
  summary.innerHTML = renderChatSummary(session);

  const filter = getChatFilter(agentId);
  const turns = applyChatFilter(agentId, Array.isArray(session.turns) ? session.turns : []);
  body.innerHTML = turns.length
    ? turns.map((turn) => renderTranscriptTurn('Claude', turn, filter)).join('')
    : `<p class="chat-page__empty">No turns match the <code>${escapeHtml(filter)}</code> filter.</p>`;
  if (!state.chat.didInitialScrollByAgent.get(agentId)) {
    requestAnimationFrame(() => {
      body.scrollTop = body.scrollHeight;
      state.chat.didInitialScrollByAgent.set(agentId, true);
    });
  }
}

function renderCodexChat(agentId, payload) {
  const view = state.views.detailById.get(agentId);
  const status = view?.querySelector('[data-codex-status]');
  const body = view?.querySelector('[data-codex-body]');
  const meta = view?.querySelector('[data-codex-meta]');
  const summary = view?.querySelector('[data-codex-summary]');
  if (!(status instanceof HTMLElement) || !(body instanceof HTMLElement) || !(meta instanceof HTMLElement) || !(summary instanceof HTMLElement)) {
    return;
  }

  syncCodexFilters(agentId);
  syncCodexSummaryVisibility(agentId);

  if (payload?.error) {
    status.textContent = 'Error';
    status.className = 'agent-status is-waiting';
    meta.innerHTML = '<span>Codex worker unavailable</span>';
    summary.innerHTML = `<p class="chat-page__empty">${escapeHtml(payload.error)}</p>`;
    body.innerHTML = `<p class="chat-page__empty">${escapeHtml(payload.error)}</p>`;
    return;
  }

  const session = payload?.session || null;
  if (!session) {
    status.textContent = 'Idle';
    status.className = 'agent-status is-syncing';
    meta.innerHTML = '<span>No active Codex session</span>';
    summary.innerHTML = '<p class="chat-page__empty">No session summary yet.</p>';
    body.innerHTML = '<p class="chat-page__empty">No Codex session transcript is available yet.</p>';
    return;
  }

  const statusText = {
    running: 'Running',
    waiting: 'Waiting',
    error: 'Error'
  }[session.status] || 'Syncing';
  status.textContent = statusText;
  status.className = `agent-status ${session.status === 'running' ? 'is-active' : session.status === 'error' ? 'is-waiting' : 'is-syncing'}`;
  meta.innerHTML = renderChatMeta(session);
  summary.innerHTML = renderChatSummary(session);

  const filter = getCodexFilter(agentId);
  const turns = applyCodexFilter(agentId, Array.isArray(session.turns) ? session.turns : []);
  body.innerHTML = turns.length
    ? turns.map((turn) => renderTranscriptTurn('Codex', turn, filter)).join('')
    : `<p class="chat-page__empty">No turns match the <code>${escapeHtml(filter)}</code> filter.</p>`;
  if (!state.codex.didInitialScrollByAgent.get(agentId)) {
    requestAnimationFrame(() => {
      body.scrollTop = body.scrollHeight;
      state.codex.didInitialScrollByAgent.set(agentId, true);
    });
  }
}

function renderHistory(agentId, payload) {
  const view = state.views.detailById.get(agentId);
  const status = view?.querySelector('[data-history-status]');
  const body = view?.querySelector('[data-history-body]');
  const meta = view?.querySelector('[data-history-meta]');
  if (!(status instanceof HTMLElement) || !(body instanceof HTMLElement) || !(meta instanceof HTMLElement)) {
    return;
  }

  if (payload?.error) {
    status.textContent = 'Error';
    status.className = 'agent-status is-waiting';
    meta.innerHTML = '<span>History unavailable</span>';
    body.innerHTML = `<p class="chat-page__empty">${escapeHtml(payload.error)}</p>`;
    return;
  }

  status.textContent = 'Ready';
  status.className = 'agent-status is-active';
  meta.innerHTML = `
    <span>${escapeHtml(payload.target || 'unknown target')}</span>
    <span>${escapeHtml(formatTimestamp(payload.capturedAt))}</span>
    <span>${escapeHtml(String(payload.lines || 0))} lines</span>
  `;
  body.innerHTML = renderHistoryContent(payload);

  if (!state.history.didInitialScrollByAgent.get(agentId)) {
    requestAnimationFrame(() => {
      body.scrollTop = body.scrollHeight;
      state.history.didInitialScrollByAgent.set(agentId, true);
    });
  }
}

function renderTranscriptTurn(label, turn, filter) {
  const showToolSections = filter !== 'prompts';
  const toolResultsList = Array.isArray(turn.toolResults) ? turn.toolResults : [];
  const toolResultText = toolResultsList.map((item) => item.stdout || item.text || '').filter(Boolean).join('\n\n');
  const toolList = Array.isArray(turn.toolUses) && turn.toolUses.length && showToolSections
    ? `
      <details class="chat-turn__section" open>
        <summary>Tool Calls (${turn.toolUses.length})</summary>
        <div class="chat-turn__tools">
          ${turn.toolUses.map(renderToolUse).join('')}
        </div>
      </details>
    `
    : '';
  const toolResults = toolResultsList.length && showToolSections
    ? `
      <details class="chat-turn__section">
        <summary>Tool Results (${toolResultsList.length})</summary>
        ${renderAnsiTextBlock('chat-turn__tool-results', toolResultText)}
      </details>
    `
    : '';
  const assistantText = turn.assistantText || turn.error || '';

  return `
    <article class="chat-turn ${turn.error ? 'chat-turn--error' : ''}">
      <header class="chat-turn__header">
        <span class="chat-turn__label">You</span>
        <time>${escapeHtml(formatTimestamp(turn.startedAt))}</time>
      </header>
      ${renderAnsiTextBlock('chat-turn__prompt', turn.userText || '')}
      ${toolList}
      ${toolResults}
      <header class="chat-turn__header">
        <span class="chat-turn__label">${escapeHtml(label)}</span>
      </header>
      ${renderAnsiTextBlock('chat-turn__response', assistantText || 'No assistant response yet.')}
    </article>
  `;
}

function renderAnsiTextBlock(className, value) {
  const text = String(value || '');
  if (containsAnsi(text)) {
    return `<pre class="${className} ${className}--ansi">${ansiToHtml(text)}</pre>`;
  }
  return `<pre class="${className}">${escapeHtml(text)}</pre>`;
}

function containsAnsi(value) {
  return /\x1b\[[0-9;]*m/.test(String(value || ''));
}

function renderHistoryContent(payload) {
  const ansiText = typeof payload?.ansiText === 'string' ? payload.ansiText : null;
  const historyHtml = ansiText === null
    ? escapeHtml(payload?.text || '')
    : ansiToHtml(ansiText);
  const historyClass = ansiText === null
    ? 'history-page__content'
    : 'history-page__content history-page__content--ansi';
  return `<pre class="${historyClass}">${historyHtml}</pre>`;
}

function ansiToHtml(value) {
  const text = String(value || '');
  let state = createAnsiState();
  let output = '';
  let lastIndex = 0;
  ansiSgrPattern.lastIndex = 0;

  for (let match = ansiSgrPattern.exec(text); match; match = ansiSgrPattern.exec(text)) {
    output += renderAnsiChunk(text.slice(lastIndex, match.index), state);
    state = applyAnsiSgr(state, match[1]);
    lastIndex = ansiSgrPattern.lastIndex;
  }

  output += renderAnsiChunk(text.slice(lastIndex), state);
  return output;
}

function createAnsiState() {
  return {
    fg: null,
    bg: null,
    bold: false,
    dim: false,
    italic: false,
    underline: false,
    inverse: false
  };
}

function renderAnsiChunk(value, state) {
  if (!value) {
    return '';
  }

  const text = escapeHtml(String(value).replace(nonSgrAnsiPattern, ''));
  if (!text) {
    return '';
  }

  const style = getAnsiStyle(state);
  return style ? `<span style="${escapeAttr(style)}">${text}</span>` : text;
}

function getAnsiStyle(state) {
  const effectiveFg = state.inverse ? (state.bg || ansiDefaultBackground) : state.fg;
  const effectiveBg = state.inverse ? (state.fg || ansiDefaultForeground) : state.bg;
  const parts = [];

  if (effectiveFg) {
    parts.push(`color:${effectiveFg}`);
  }
  if (effectiveBg) {
    parts.push(`background:${effectiveBg}`);
  }
  if (state.bold) {
    parts.push('font-weight:700');
  }
  if (state.dim) {
    parts.push('opacity:0.72');
  }
  if (state.italic) {
    parts.push('font-style:italic');
  }
  if (state.underline) {
    parts.push('text-decoration:underline');
  }

  return parts.join(';');
}

function applyAnsiSgr(currentState, paramsText) {
  const nextState = { ...currentState };
  const parts = paramsText === ''
    ? [0]
    : paramsText.split(';').map((part) => Number.parseInt(part || '0', 10)).filter(Number.isFinite);
  const codes = parts.length ? parts : [0];

  for (let index = 0; index < codes.length; index += 1) {
    const code = codes[index];

    if (code === 0) {
      Object.assign(nextState, createAnsiState());
      continue;
    }
    if (code === 1) {
      nextState.bold = true;
      nextState.dim = false;
      continue;
    }
    if (code === 2) {
      nextState.dim = true;
      continue;
    }
    if (code === 3) {
      nextState.italic = true;
      continue;
    }
    if (code === 4) {
      nextState.underline = true;
      continue;
    }
    if (code === 7) {
      nextState.inverse = true;
      continue;
    }
    if (code === 22) {
      nextState.bold = false;
      nextState.dim = false;
      continue;
    }
    if (code === 23) {
      nextState.italic = false;
      continue;
    }
    if (code === 24) {
      nextState.underline = false;
      continue;
    }
    if (code === 27) {
      nextState.inverse = false;
      continue;
    }
    if (code === 39) {
      nextState.fg = null;
      continue;
    }
    if (code === 49) {
      nextState.bg = null;
      continue;
    }
    if (code >= 30 && code <= 37) {
      nextState.fg = ansiBasePalette[code - 30];
      continue;
    }
    if (code >= 90 && code <= 97) {
      nextState.fg = ansiBrightPalette[code - 90];
      continue;
    }
    if (code >= 40 && code <= 47) {
      nextState.bg = ansiBasePalette[code - 40];
      continue;
    }
    if (code >= 100 && code <= 107) {
      nextState.bg = ansiBrightPalette[code - 100];
      continue;
    }
    if (code === 38 || code === 48) {
      const mode = codes[index + 1];
      const isBackground = code === 48;
      if (mode === 5) {
        const colorIndex = codes[index + 2];
        if (Number.isInteger(colorIndex)) {
          if (isBackground) {
            nextState.bg = ansiIndexedColor(colorIndex);
          } else {
            nextState.fg = ansiIndexedColor(colorIndex);
          }
        }
        index += 2;
        continue;
      }
      if (mode === 2) {
        const red = codes[index + 2];
        const green = codes[index + 3];
        const blue = codes[index + 4];
        if ([red, green, blue].every((value) => Number.isInteger(value) && value >= 0 && value <= 255)) {
          const color = `rgb(${red}, ${green}, ${blue})`;
          if (isBackground) {
            nextState.bg = color;
          } else {
            nextState.fg = color;
          }
        }
        index += 4;
      }
    }
  }

  return nextState;
}

function ansiIndexedColor(index) {
  if (index >= 0 && index < ansiBasePalette.length) {
    return ansiBasePalette[index];
  }
  if (index >= 8 && index < 16) {
    return ansiBrightPalette[index - 8];
  }
  if (index >= 16 && index <= 231) {
    const cube = index - 16;
    const steps = [0, 95, 135, 175, 215, 255];
    const red = steps[Math.floor(cube / 36) % 6];
    const green = steps[Math.floor(cube / 6) % 6];
    const blue = steps[cube % 6];
    return `rgb(${red}, ${green}, ${blue})`;
  }
  if (index >= 232 && index <= 255) {
    const level = 8 + (index - 232) * 10;
    return `rgb(${level}, ${level}, ${level})`;
  }
  return null;
}

function renderToolUse(tool) {
  const input = tool.input?.command || tool.input?.description || JSON.stringify(tool.input || {});
  return `
    <article class="chat-tool-card">
      <div class="chat-tool-card__name">${escapeHtml(tool.name || 'Tool')}</div>
      <pre class="chat-tool-card__input">${escapeHtml(input)}</pre>
    </article>
  `;
}

function renderChatMeta(session) {
  return `
    <span>${escapeHtml(session.cwd || 'unknown cwd')}</span>
    <span>${escapeHtml(session.gitBranch || 'no git branch')}</span>
    <span>${escapeHtml(session.sessionId || 'unknown session')}</span>
    <span>${escapeHtml(formatTimestamp(session.updatedAt))}</span>
  `;
}

function renderChatSummary(session) {
  const summary = buildChatSummary(session);
  return `
    <section class="chat-summary-card">
      <p class="eyebrow">Latest Prompt</p>
      <p class="chat-summary-card__copy">${escapeHtml(summary.latestPrompt)}</p>
    </section>
    <section class="chat-summary-card">
      <p class="eyebrow">Latest Tools</p>
      ${summary.tools.length
        ? `<div class="chat-summary-card__chips">${summary.tools.map((tool) => `<code>${escapeHtml(tool)}</code>`).join('')}</div>`
        : '<p class="chat-page__empty">No tool calls recorded yet.</p>'}
    </section>
    <section class="chat-summary-card">
      <p class="eyebrow">Latest Files</p>
      ${summary.files.length
        ? `<div class="chat-summary-card__list">${summary.files.map((filePath) => `<code>${escapeHtml(filePath)}</code>`).join('')}</div>`
        : '<p class="chat-page__empty">No file paths inferred yet.</p>'}
    </section>
    <section class="chat-summary-card">
      <p class="eyebrow">Errors</p>
      <p class="chat-summary-card__copy">${summary.errorCount ? `${summary.errorCount} recent error turn${summary.errorCount === 1 ? '' : 's'}` : 'No recent errors'}</p>
    </section>
  `;
}

function buildChatSummary(session) {
  const turns = Array.isArray(session.turns) ? session.turns : [];
  const latestTurn = turns[turns.length - 1] || null;
  const tools = [];
  const files = [];
  const seenTools = new Set();
  const seenFiles = new Set();

  for (const turn of turns.slice().reverse()) {
    for (const tool of turn.toolUses || []) {
      const name = tool.name || 'Tool';
      if (!seenTools.has(name)) {
        seenTools.add(name);
        tools.push(name);
      }
      for (const filePath of extractFileCandidates(tool.input?.command || '')) {
        if (!seenFiles.has(filePath)) {
          seenFiles.add(filePath);
          files.push(filePath);
        }
      }
    }
  }

  return {
    latestPrompt: latestTurn?.userText || 'No prompt yet',
    tools: tools.slice(0, 6),
    files: files.slice(0, 6),
    errorCount: turns.filter((turn) => turn.error || (turn.toolResults || []).some((item) => item.isError)).length
  };
}

function extractFileCandidates(command) {
  const matches = String(command || '').match(/(?:^|\s)(~?\/[\w./-]+|\.?\.?\/[\w./-]+)/g) || [];
  return matches.map((value) => value.trim());
}

function formatTimestamp(value) {
  if (!value) {
    return 'now';
  }

  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return value;
  }

  return new Intl.DateTimeFormat([], {
    hour: 'numeric',
    minute: '2-digit',
    month: 'short',
    day: 'numeric'
  }).format(date);
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
  view.inert = true;
}

function htmlToElement(markup) {
  const template = document.createElement('template');
  template.innerHTML = markup.trim();
  return template.content.firstElementChild;
}

function focusRouteTerminal() {
  if (route.kind !== 'agent') {
    return;
  }

  const agent = state.config?.agents.find((item) => item.id === route.agentId);
  if (!agent || getAgentViewMode(agent) !== 'byobu') {
    return;
  }

  const activeView = state.views.detailById.get(route.agentId);
  const frame = activeView?.querySelector('.terminal-frame--detail');
  focusTerminalFrame(frame);
}

function focusTerminalFrame(frame) {
  if (!(frame instanceof HTMLIFrameElement)) {
    return;
  }

  const focusToken = (state.routeTerminalFocusToken || 0) + 1;
  state.routeTerminalFocusToken = focusToken;

  let attempts = 0;

  const tryFocus = () => {
    if (state.routeTerminalFocusToken !== focusToken || !frame.isConnected || frame.inert) {
      return;
    }

    let focused = false;

    try {
      frame.focus({ preventScroll: true });
      frame.contentWindow?.focus?.();
      frame.contentWindow?.__agentWatchSetFocusEnabled?.(true);

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

function blurTerminalFrame(frame) {
  if (!(frame instanceof HTMLIFrameElement)) {
    return;
  }

  try {
    const doc = frame.contentDocument;
    const helper = doc?.querySelector('.xterm-helper-textarea');
    if (helper instanceof HTMLElement) {
      helper.blur();
    }
    if (doc?.activeElement instanceof HTMLElement) {
      doc.activeElement.blur();
    }
    frame.contentWindow?.blur?.();
    frame.blur();
  } catch {}
}

function syncTerminalFrameInputState(frame, isActive) {
  if (!(frame instanceof HTMLIFrameElement)) {
    return;
  }

  const desiredValue = String(!isActive);
  if (frame.dataset.stdinDisabled === desiredValue) {
    return;
  }

  try {
    frame.contentWindow?.__agentWatchSetFocusEnabled?.(isActive);
    const term = frame.contentWindow?.term;
    const doc = frame.contentDocument;
    const helper = doc?.querySelector('.xterm-helper-textarea');
    if (helper instanceof HTMLElement) {
      helper.tabIndex = isActive ? 0 : -1;
    }
    const xterm = doc?.querySelector('.xterm');
    if (xterm instanceof HTMLElement) {
      xterm.tabIndex = isActive ? 0 : -1;
    }
    if (term && typeof term.setOption === 'function') {
      term.setOption('disableStdin', !isActive);
      frame.dataset.stdinDisabled = desiredValue;
      return;
    }
  } catch {}

  delete frame.dataset.stdinDisabled;
}

function getRoute(pathname, search = '') {
  const agentMatch = pathname.match(/^\/agents\/([^/]+)\/?$/);
  if (agentMatch) {
    const params = new URLSearchParams(search || '');
    const view = params.get('view');
    return {
      kind: 'agent',
      agentId: decodeURIComponent(agentMatch[1]),
      view: view === 'byobu' || view === 'claude' || view === 'codex' || view === 'history' ? view : null
    };
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
