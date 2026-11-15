import { defineConfig, devices } from '@playwright/test';
// Генерирует случайные email и пароль администратора E2E до запуска воркеров.
import { ADMIN } from './tests/e2e/support/admin-user';

const PORT = Number(process.env.E2E_PORT ?? 3399);
const STORAGE = process.env.E2E_STORAGE ?? 'test-results/e2e-storage';
// Тесты админки заменяют файлы прогноза — сервер работает с копией data/ (см. tests/e2e/support/prepare-server.mjs).
const DATA = process.env.E2E_DATA ?? 'test-results/e2e-data';

export default defineConfig({
  testDir: 'tests/e2e',
  // После старта webServer проверяет вход владельца.
  globalSetup: './tests/e2e/support/global-setup.ts',
  timeout: 30_000,
  expect: { timeout: 7_000 },
  fullyParallel: false,
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  reporter: [['list']],
  use: {
    baseURL: `http://127.0.0.1:${PORT}`,
    locale: 'ru-RU',
    timezoneId: 'Europe/Moscow',
    trace: 'retain-on-failure',
  },
  projects: [
    { name: 'desktop-chromium', use: { ...devices['Desktop Chrome'], viewport: { width: 1360, height: 900 } } },
    { name: 'mobile-chromium', use: { ...devices['Pixel 7'] } },
  ],
  webServer: {
    // Сервер из собранного dist (npm run build выполняется заранее, см. test:all).
    // Перед стартом: чистое хранилище и свежая копия data/.
    command: 'node tests/e2e/support/prepare-server.mjs && node --disable-warning=ExperimentalWarning dist/node/server/index.js',
    url: `http://127.0.0.1:${PORT}/api/health`,
    reuseExistingServer: false,
    timeout: 30_000,
    env: {
      NODE_ENV: 'production',
      PORT: String(PORT),
      HOST: '127.0.0.1',
      STORAGE_DIR: STORAGE,
      DATA_DIR: DATA,
      AUTH_RATE_LIMIT: '1000',
      // Все браузерные сценарии используют один локальный IP, включая подготовку CSV через API.
      ADMIN_UPLOAD_RATE_LIMIT: '1000',
      INITIAL_ADMIN_EMAIL: ADMIN.email,
      INITIAL_ADMIN_PASSWORD: ADMIN.password,
      LOG_LEVEL: 'warn',
    },
  },
});
