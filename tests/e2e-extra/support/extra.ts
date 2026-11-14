/**
 * Общие помощники дополнительного набора.
 * Основные фикстуры (сбор ошибок консоли, CSP, регистрация) берутся из tests/e2e/support.
 */
import fs from 'node:fs';
import path from 'node:path';
import { request, type APIRequestContext, type Page, type TestInfo } from '@playwright/test';
import { expect } from '../../e2e/support/fixtures';
import { ADMIN } from '../../e2e/support/admin-user';

export const BASE_URL = `http://127.0.0.1:${process.env.E2E_PORT ?? 3399}`;
/** Папка с данными, из которой читает тестовый сервер (копия data/, см. prepare-server.mjs). */
export const DATA_DIR = path.resolve(process.env.E2E_DATA ?? 'test-results/e2e-data');

export const ORIGINAL = {
  forecast: fs.readFileSync(path.resolve('data', 'seasonal_forecast.csv'), 'utf8'),
  routes: fs.readFileSync(path.resolve('data', 'routes.csv'), 'utf8'),
};

/** Шумные сообщения консоли, которые браузеры пишут при сбое сети или ответе 4xx/5xx. */
export const NETWORK_NOISE =
  /Failed to load resource|net::ERR_|NetworkError|Load failed|Fetch API cannot load|status of [45]\d\d|due to access control|cancelled|aborted/i;

export function hasTouch(testInfo: TestInfo): boolean {
  return Boolean(testInfo.project.use.hasTouch);
}

/** Отдельный API-клиент администратора (своя cookie, не мешает странице пользователя). */
export async function adminApi(): Promise<APIRequestContext> {
  const api = await request.newContext({ baseURL: BASE_URL });
  const res = await api.post('/api/auth/login', { data: { email: ADMIN.email, password: ADMIN.password } });
  expect(res.status(), await res.text()).toBe(200);
  return api;
}

export async function uploadApply(api: APIRequestContext, kind: 'forecast' | 'routes', content: string) {
  const res = await api.post('/api/admin/upload', {
    data: { kind, filename: kind === 'forecast' ? 'seasonal_forecast.csv' : 'routes.csv', content, apply: true },
  });
  expect(res.ok(), await res.text()).toBe(true);
  const body = (await res.json()) as { ok: boolean; applied: boolean; error?: string };
  expect(body.ok, body.error).toBe(true);
  expect(body.applied).toBe(true);
}

/** Медианный спрос по API, чтобы понять, какие данные сейчас у сервера. */
export async function wantsViaApi(api: APIRequestContext, price = 9500): Promise<number> {
  const res = await api.post('/api/forecast', { data: { from: 'MOW', to: 'AER', date: '2026-06-01', price } });
  if (!res.ok()) return NaN;
  return ((await res.json()) as { median: { wants: number } }).median.wants;
}

export async function healthStatus(api: APIRequestContext): Promise<string> {
  const res = await api.get('/api/health');
  return ((await res.json()) as { status: string }).status;
}

/**
 * Вернуть исходные файлы данных прямо на диск (без загрузки через API — у загрузки
 * есть лимит 30 запросов в минуту) и дождаться, пока сервер их перечитает.
 */
export async function restoreDataOnDisk(api: APIRequestContext) {
  let changed = false;
  for (const [file, content] of [
    ['seasonal_forecast.csv', ORIGINAL.forecast],
    ['routes.csv', ORIGINAL.routes],
  ] as const) {
    const target = path.join(DATA_DIR, file);
    const current = fs.existsSync(target) ? fs.readFileSync(target, 'utf8') : null;
    if (current === content) continue;
    const tmp = `${target}.extra-tmp`;
    fs.writeFileSync(tmp, content, 'utf8');
    fs.renameSync(tmp, target);
    // Время изменения сдвигаем вперёд: сервер замечает файл по размеру и mtime.
    const t = Date.now() / 1000 + 2;
    fs.utimesSync(target, t, t);
    changed = true;
  }
  if (!changed) return;
  const restoredFile = (name: string) => {
    const { size, mtime } = fs.statSync(path.join(DATA_DIR, name));
    return { size, modifiedAt: mtime.toISOString() };
  };
  await expect
    .poll(async () => {
      const res = await api.get('/api/meta');
      return res.ok() ? (await res.json()).data : null;
    }, { timeout: 15_000, message: 'сервер не перечитал исходные данные' })
    .toMatchObject({
      ok: true,
      source: { forecast: restoredFile('seasonal_forecast.csv'), routes: restoredFile('routes.csv') },
    });
}

/** Записать произвольный файл прогноза прямо на диск (имитация ручной замены файла на сервере). */
export function writeForecastOnDisk(content: string) {
  const target = path.join(DATA_DIR, 'seasonal_forecast.csv');
  fs.writeFileSync(target, content, 'utf8');
  const t = Date.now() / 1000 + 2;
  fs.utimesSync(target, t, t);
}

/** Копия прогноза, где в строке MOW-AER 2026-06-01 изменены значения колонок. */
export function patchedForecast(patch: Record<string, string>): string {
  const lines = ORIGINAL.forecast.split(/\r?\n/);
  const head = lines[0]!.split(',');
  const i = lines.findIndex((l) => l.startsWith('MOW-AER,2026-06-01,'));
  expect(i, 'строка MOW-AER 2026-06-01 есть в прогнозе').toBeGreaterThan(0);
  const cells = lines[i]!.split(',');
  for (const [col, value] of Object.entries(patch)) {
    const c = head.indexOf(col);
    expect(c, `колонка ${col} есть в прогнозе`).toBeGreaterThanOrEqual(0);
    cells[c] = value;
  }
  lines[i] = cells.join(',');
  return lines.join('\n');
}

/** Копия routes.csv, где у MOW-AER изменена чувствительность к цене. */
export function patchedRoutes(sensitivity: string): string {
  const lines = ORIGINAL.routes.split(/\r?\n/);
  const head = lines[0]!.split(',');
  const col = head.indexOf('price_sensitivity');
  const i = lines.findIndex((l) => l.startsWith('MOW-AER,'));
  const cells = lines[i]!.split(',');
  cells[col] = sensitivity;
  lines[i] = cells.join(',');
  return lines.join('\n');
}

/** Дождаться шрифтов и окончания CSS-анимаций перед скриншотом или замером. */
export async function stable(page: Page) {
  await page.evaluate(async () => {
    await document.fonts.ready;
    await Promise.all(document.getAnimations().map((a) => a.finished.catch(() => undefined)));
  });
}

export async function useTheme(page: Page, theme: 'light' | 'dark') {
  await page.addInitScript((t) => localStorage.setItem('ra-theme', t), theme);
}

export async function useLang(page: Page, lang: 'ru' | 'en') {
  await page.addInitScript((l) => localStorage.setItem('ra-lang', l), lang);
}
