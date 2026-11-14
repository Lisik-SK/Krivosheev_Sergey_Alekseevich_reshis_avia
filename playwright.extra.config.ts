/**
 * Дополнительный набор браузерных тестов: Safari (WebKit), Firefox, iPhone,
 * касания, сбои сети, уведомления о данных, скриншоты.
 *
 * Сервер, глобальная подготовка и администратор берутся из основного playwright.config.ts,
 * поэтому основной конфиг не меняется.
 *
 *   npx playwright test -c playwright.extra.config.ts
 */
import { defineConfig, devices } from '@playwright/test';
import base from './playwright.config';

const EXTRA = './tests/e2e-extra';
const LEGACY = './tests/e2e';
const desktop = { width: 1360, height: 900 };
const firefox = {
  ...devices['Desktop Firefox'],
  viewport: desktop,
  launchOptions: { firefoxUserPrefs: { 'network.proxy.type': 0 } },
};

export default defineConfig({
  ...base,
  testDir: './tests',
  // Эталонные скриншоты отдельно для каждой ОС и браузера: шрифты рисуются по-разному.
  snapshotPathTemplate: '{testDir}/__screenshots__/{platform}/{projectName}/{testFilePath}/{arg}{ext}',
  expect: {
    ...base.expect,
    toHaveScreenshot: { maxDiffPixelRatio: 0.01, animations: 'disabled', caret: 'hide', scale: 'css' },
  },
  reporter: [['list'], ['html', { open: 'never', outputFolder: 'playwright-report-extra' }]],
  projects: [
    // ---------- новые тесты во всех браузерах ----------
    { name: 'extra-desktop-chromium', testDir: EXTRA, use: { ...devices['Desktop Chrome'], viewport: desktop } },
    { name: 'extra-mobile-chromium', testDir: EXTRA, use: { ...devices['Pixel 7'] } },
    { name: 'extra-desktop-firefox', testDir: EXTRA, use: firefox },
    { name: 'extra-desktop-webkit', testDir: EXTRA, use: { ...devices['Desktop Safari'], viewport: desktop } },
    { name: 'extra-iphone-webkit', testDir: EXTRA, use: { ...devices['iPhone 14'] } },

    // ---------- основной набор в браузерах, где он ещё не запускался ----------
    { name: 'legacy-desktop-firefox', testDir: LEGACY, use: firefox },
    { name: 'legacy-desktop-webkit', testDir: LEGACY, use: { ...devices['Desktop Safari'], viewport: desktop } },
    { name: 'legacy-iphone-webkit', testDir: LEGACY, use: { ...devices['iPhone 14'] } },
  ],
});
