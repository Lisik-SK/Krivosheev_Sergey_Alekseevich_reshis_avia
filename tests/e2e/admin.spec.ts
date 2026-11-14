import fs from 'node:fs';
import path from 'node:path';
import type { Page } from '@playwright/test';
import { test, expect, loginAdmin, registerViaApi, settled, waitForecast, textOf } from './support/fixtures';
import { expected, num1 } from './support/data';

const ORIGINAL_FORECAST = fs.readFileSync(path.resolve('data', 'seasonal_forecast.csv'), 'utf8');

/** Тот же файл, но у MOW-AER 2026-06-01 медианный спрос 775 → 850. */
function modifiedForecast(): string {
  const lines = ORIGINAL_FORECAST.split(/\r?\n/);
  const head = lines[0]!.split(',');
  const col = head.indexOf('0.5_base_demand');
  const i = lines.findIndex((l) => l.startsWith('MOW-AER,2026-06-01,'));
  const cells = lines[i]!.split(',');
  expect(cells[col]).toBe('775');
  cells[col] = '850';
  lines[i] = cells.join(',');
  return lines.join('\n');
}

async function upload(page: Page, name: string, content: string) {
  await page.getByTestId('admin-file').setInputFiles({ name, mimeType: 'text/csv', buffer: Buffer.from(content, 'utf8') });
}

async function wantsFor(page: Page, query: string): Promise<string> {
  const res = waitForecast(page);
  await page.goto('/' + query);
  await res;
  await settled(page);
  return textOf(page, 'wants');
}

/** Гарантированно вернуть исходный файл прогноза (через API администратора). */
async function restoreOriginal(page: Page) {
  const res = await page.request.post('/api/admin/upload', {
    data: { kind: 'forecast', filename: 'seasonal_forecast.csv', content: ORIGINAL_FORECAST, apply: true },
  });
  expect(res.ok(), await res.text()).toBe(true);
}

test.describe('Администрирование данных', () => {
  test('замечания отделены от сводки и раскрываются по всей ширине строки', async ({ page, isMobile }) => {
    await loginAdmin(page);
    await page.goto('/admin');
    await expect(page.getByTestId('admin-current')).toBeVisible();
    const sample = ORIGINAL_FORECAST.split(/\r?\n/).find((line) => line.startsWith('MOW-AER,2026-06-01,'))!;
    await upload(page, 'seasonal_forecast.csv', `${ORIGINAL_FORECAST.trimEnd()}\n${sample.replace(/^MOW-AER,/, 'LOL-KOT,')}\n`);

    const notice = page.getByTestId('admin-preview').locator('.alert--warn');
    const summary = notice.locator('summary').filter({ hasText: 'Замечания: 1' });
    const warnings = page.getByText(/Маршруты не найдены.*LOL-KOT/);
    await expect(summary).toBeVisible();
    await expect(notice.locator(':scope > svg > circle')).toBeVisible();
    await expect(summary).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
    await expect(summary).toHaveCSS('font-weight', '400');
    await expect(warnings).toBeHidden();
    const panel = notice.locator('details');
    const panelBox = (await panel.boundingBox())!;
    const headingBox = (await summary.boundingBox())!;
    const fileBox = (await page.getByTestId('admin-valid').boundingBox())!;
    const noticeBox = (await notice.boundingBox())!;
    expect(noticeBox.y - (fileBox.y + fileBox.height)).toBeGreaterThanOrEqual(8);
    expect(headingBox.x + headingBox.width).toBeCloseTo(noticeBox.x + noticeBox.width - 15);

    const position = { x: panelBox.width - 6, y: headingBox.height / 2 };
    if (isMobile) await panel.tap({ position });
    else await panel.click({ position });
    await expect(warnings).toBeVisible();
    await summary.press('Enter');
    await expect(warnings).toBeHidden();
  });

  test('раздел «Данные» доступен владельцу, регистрация выдаёт обычную роль', async ({ page }) => {
    await loginAdmin(page);
    await page.goto('/admin');
    await expect(page.getByTestId('admin-current')).toContainText('seasonal_forecast.csv');
    const res = await page.request.post('/api/auth/register', { data: { name: 'Второй', email: `second.${Date.now()}@example.com`, password: 'Pa55word-xyz' } });
    expect(res.status()).toBe(201);
    expect(((await res.json()) as { user: { role: string } }).user.role).toBe('user');
  });

  test('загрузка изменённого прогноза: проверка, разница, замена и откат', async ({ page }) => {
    await loginAdmin(page);
    const q = '?from=MOW&to=AER&date=2026-06-01&price=9000';
    try {
      expect(await wantsFor(page, q)).toBe('775');
      await expect(page.getByTestId('nav-admin')).toBeVisible();
      await page.getByTestId('nav-admin').click();
      await expect(page).toHaveURL(/\/admin$/);
      await expect(page.getByTestId('admin-current')).toContainText('seasonal_forecast.csv');

      await upload(page, 'seasonal_forecast.csv', modifiedForecast());
      await expect(page.getByTestId('admin-valid')).toBeVisible();
      await expect(page.getByTestId('admin-diff')).toBeVisible();
      await expect(page.getByTestId('admin-diff')).toContainText('1');
      await expect(page.getByTestId('admin-preview').locator('tr').filter({ hasText: 'MOW-AER' })).toBeVisible();

      // До подтверждения данные не изменились
      const before = await (await page.request.post('/api/forecast', { data: { from: 'MOW', to: 'AER', date: '2026-06-01', price: 9000 } })).json();
      expect(before.median.wants).toBe(775);

      await page.getByTestId('admin-apply').click();
      await expect(page.getByTestId('admin-applied')).toContainText('Новый прогноз');
      await expect(page.locator('.toast')).toContainText('Загружена новая версия прогноза');
      await expect(page.getByTestId('restore-forecast')).toBeVisible();

      expect(await wantsFor(page, q)).toBe('850');
      expect(await textOf(page, 'free-seats')).toBe(String(900 - 850));

      // Откат к прежней версии
      await page.goto('/admin');
      await page.getByTestId('restore-forecast').click();
      await expect.poll(async () => (await (await page.request.post('/api/forecast', { data: { from: 'MOW', to: 'AER', date: '2026-06-01', price: 9000 } })).json()).median.wants).toBe(775);
      expect(await wantsFor(page, q)).toBe(num1(expected('MOW-AER', '2026-06-01', 9000).wants));
    } finally {
      await restoreOriginal(page);
    }
  });

  test('некорректный файл — ошибка проверки, данные не меняются', async ({ page }) => {
    await loginAdmin(page);
    await page.goto('/admin');
    await expect(page.getByTestId('admin-current')).toBeVisible();
    await upload(page, 'broken.csv', 'foo,bar\n1,2\n');
    await expect(page.getByTestId('admin-invalid')).toBeVisible();
    await expect(page.getByTestId('admin-apply')).toHaveCount(0);
    const r = await (await page.request.post('/api/forecast', { data: { from: 'MOW', to: 'AER', date: '2026-06-01', price: 9500 } })).json();
    expect(r.median.wants).toBe(704.5);
  });

  test('обычный пользователь не видит раздел «Данные», /admin — запрещено', async ({ page }) => {
    await registerViaApi(page);
    await page.goto('/');
    await expect(page.getByTestId('query-form')).toBeVisible();
    await expect(page.getByTestId('nav-board')).toBeVisible();
    await expect(page.getByTestId('nav-admin')).toHaveCount(0);
    await page.goto('/admin');
    await expect(page.getByText('Раздел доступен только администратору.')).toBeVisible();
    await expect(page.getByTestId('admin-file')).toHaveCount(0);
    const api = await page.request.get('/api/admin/data');
    expect(api.status()).toBe(403);
    const up = await page.request.post('/api/admin/upload', { data: { kind: 'forecast', content: 'x', apply: true } });
    expect(up.status()).toBe(403);
  });
});
