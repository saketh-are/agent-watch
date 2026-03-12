import { defineConfig } from '@playwright/test';

const appPort = Number.parseInt(process.env.AGENT_WATCH_E2E_APP_PORT || '3478', 10);
const host = process.env.AGENT_WATCH_E2E_HOST || '127.0.0.1';
const baseURL = `http://${host}:${appPort}`;

export default defineConfig({
  testDir: './tests',
  timeout: 30_000,
  expect: {
    timeout: 5_000
  },
  fullyParallel: false,
  reporter: process.env.CI ? 'github' : 'list',
  use: {
    baseURL,
    headless: true
  },
  webServer: {
    command: 'node tests/helpers/run-e2e-harness.mjs',
    url: `${baseURL}/api/config`,
    reuseExistingServer: false,
    timeout: 30_000
  }
});
