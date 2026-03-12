import { expect, test } from '@playwright/test';

const agentIds = ['alpha', 'beta', 'gamma'];

test.describe('terminal tab behavior', () => {
  test('keeps every tab warm while switching', async ({ page }) => {
    await page.goto('/agents/alpha');
    await waitForAgentFrames(page);

    const initialLoadIds = await getAgentStates(page);

    await clickAgentTab(page, 'beta');
    await expect(page).toHaveURL(/\/agents\/beta/);
    await expect.poll(() => getAgentState(page, 'beta').then((state) => state.helperFocused)).toBe(true);

    await clickAgentTab(page, 'gamma');
    await expect(page).toHaveURL(/\/agents\/gamma/);
    await expect.poll(() => getAgentState(page, 'gamma').then((state) => state.helperFocused)).toBe(true);

    await clickAgentTab(page, 'alpha');
    await expect(page).toHaveURL(/\/agents\/alpha/);

    const finalLoadIds = await getAgentStates(page);

    for (const agentId of agentIds) {
      expect(finalLoadIds[agentId].loadId).toBe(initialLoadIds[agentId].loadId);
    }
  });

  test('autofocuses the visible tab and preserves active-tab selection', async ({ page }) => {
    await page.goto('/agents/alpha');
    await waitForAgentFrames(page);

    await expect.poll(() => getAgentState(page, 'alpha').then((state) => state.helperFocused)).toBe(true);
    await page.keyboard.type('alpha');
    await expect.poll(() => getAgentState(page, 'alpha').then((state) => state.receivedText)).toBe('alpha');
    expect((await getAgentState(page, 'beta')).receivedText).toBe('');
    expect((await getAgentState(page, 'gamma')).receivedText).toBe('');

    await clickAgentTab(page, 'beta');
    await expect(page).toHaveURL(/\/agents\/beta/);
    await expect.poll(() => getAgentState(page, 'beta').then((state) => state.helperFocused)).toBe(true);
    await page.keyboard.type('beta');
    await expect.poll(() => getAgentState(page, 'beta').then((state) => state.receivedText)).toBe('beta');
    expect((await getAgentState(page, 'alpha')).receivedText).toBe('alpha');
    expect((await getAgentState(page, 'gamma')).receivedText).toBe('');

    await selectTerminalOutput(page, 'beta');
    await expect.poll(() => getAgentState(page, 'beta').then((state) => state.lastSelectedText)).toContain('Beta selectable output');

    await clickAgentTab(page, 'gamma');
    await expect(page).toHaveURL(/\/agents\/gamma/);
    await expect.poll(() => getAgentState(page, 'gamma').then((state) => state.helperFocused)).toBe(true);
    await page.keyboard.type('gamma');
    await expect.poll(() => getAgentState(page, 'gamma').then((state) => state.receivedText)).toBe('gamma');
    expect((await getAgentState(page, 'beta')).receivedText).toBe('beta');

    await selectTerminalOutput(page, 'gamma');
    await expect.poll(() => getAgentState(page, 'gamma').then((state) => state.lastSelectedText)).toContain('Gamma selectable output');
    expect((await getAgentState(page, 'beta')).lastSelectedText).toContain('Beta selectable output');
  });
});

async function waitForAgentFrames(page) {
  await expect.poll(async () => {
    const states = await getAgentStates(page);
    return agentIds.every((agentId) => Boolean(states[agentId]?.loadId));
  }).toBe(true);
}

async function clickAgentTab(page, agentId) {
  await page.locator(`#site-nav .nav-link[data-nav-agent-id="${agentId}"]`).click();
}

async function selectTerminalOutput(page, agentId) {
  const frame = await getAgentFrame(page, agentId);
  await frame.locator('.terminal-output').selectText();
}

async function getAgentFrame(page, agentId) {
  const handle = await page
    .locator(`.detail-page[data-agent-id="${agentId}"] .terminal-frame--detail`)
    .elementHandle();

  if (!handle) {
    throw new Error(`Missing iframe for agent "${agentId}"`);
  }

  const frame = await handle.contentFrame();
  if (!frame) {
    throw new Error(`Missing content frame for agent "${agentId}"`);
  }

  return frame;
}

async function getAgentStates(page) {
  const entries = await Promise.all(agentIds.map(async (agentId) => [agentId, await getAgentState(page, agentId)]));
  return Object.fromEntries(entries);
}

async function getAgentState(page, agentId) {
  return page.evaluate((id) => {
    const view = document.querySelector(`.detail-page[data-agent-id="${id}"]`);
    const frame = view?.querySelector('.terminal-frame--detail');
    const doc = frame?.contentDocument;
    const win = frame?.contentWindow;
    const testState = win?.__agentWatchTest || {};

    return {
      loadId: testState.loadId || null,
      receivedText: testState.receivedText || '',
      lastSelectedText: testState.lastSelectedText || '',
      helperFocused: doc?.activeElement?.classList?.contains('xterm-helper-textarea') || false,
      disableStdin: Boolean(testState.disableStdin)
    };
  }, agentId);
}
