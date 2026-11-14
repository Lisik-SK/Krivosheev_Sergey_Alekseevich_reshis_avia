import crypto from 'node:crypto';

/**
 * Администратор для E2E создаётся заново при каждом запуске во временном хранилище.
 * Email и пароль случайные: они генерируются в главном процессе Playwright
 * (этот модуль импортирует playwright.config.ts) и через переменные окружения
 * доходят до воркеров. Постоянных тестовых аккаунтов в проекте нет.
 */
if (!process.env.E2E_ADMIN_EMAIL || !process.env.E2E_ADMIN_PASSWORD) {
  process.env.E2E_ADMIN_EMAIL = `e2e-admin-${crypto.randomBytes(6).toString('hex')}@example.test`;
  process.env.E2E_ADMIN_PASSWORD = `A1-${crypto.randomBytes(18).toString('base64url')}`;
}

export const ADMIN = {
  email: process.env.E2E_ADMIN_EMAIL,
  password: process.env.E2E_ADMIN_PASSWORD,
};
