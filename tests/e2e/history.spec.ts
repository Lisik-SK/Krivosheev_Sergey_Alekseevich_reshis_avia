import type { Page } from '@playwright/test';
import { test, expect, openApp, calculate, registerViaApi, settled, waitForecast } from './support/fixtures';

function historySaved(page: Page) {
  return page.waitForResponse((r) => r.url().endsWith('/api/history') && r.request().method() === 'POST', { timeout: 5000 });
}

/** Расчёт попадает в историю, если на нём задержаться ~1,5 с. */
async function calcAndSave(page: Page, q: { to?: string; date?: string; price?: number }) {
  const saved = historySaved(page);
  await calculate(page, q);
  expect((await saved).status()).toBe(200);
}

async function openDrawer(page: Page) {
  await page.getByTestId('history-open').click();
  await expect(page.getByTestId('history-drawer')).toBeVisible();
  await expect(page.getByRole('dialog')).toBeVisible();
}

test.describe('История расчётов', () => {
  test('расчёт сохраняется; Escape закрывает панель и возвращает фокус', async ({ page }) => {
    await openApp(page);
    await calcAndSave(page, { to: 'OVB', date: '2026-06-09', price: 12500 });
    await openDrawer(page);
    const items = page.getByTestId('history-item');
    await expect(items.filter({ hasText: 'MOW → OVB' }).filter({ hasText: '09.06.2026' })).toHaveCount(1);
    await expect(items.filter({ hasText: 'MOW → OVB' })).toContainText(/12\s500/);
    await expect(page.getByTestId('history-close')).toBeFocused();

    await page.keyboard.press('Escape');
    await expect(page.getByTestId('history-drawer')).toHaveCount(0);
    await expect(page.getByTestId('history-open')).toBeFocused();
  });

  test('закрепление переносит запись в «Закреплённые», удаление убирает её', async ({ page }) => {
    await openApp(page);
    await calcAndSave(page, { to: 'KGD', date: '2026-06-03', price: 7000 });
    await calcAndSave(page, { to: 'LED', date: '2026-06-04', price: 5000 });
    await openDrawer(page);
    const list = page.getByTestId('history-list');
    const kgd = list.locator('.hist__item').filter({ hasText: 'MOW → KGD' });
    await expect(kgd).toHaveCount(1);
    // Свежий расчёт сверху: LED выше KGD
    await expect(list.locator('.hist__item').first()).toContainText('MOW → LED');

    await kgd.getByTestId('history-pin').click();
    await expect(kgd.getByTestId('history-pin')).toHaveAttribute('aria-pressed', 'true');
    // Закреплённые — первая секция, KGD теперь первый
    await expect(list.locator('h3').first()).toHaveText('Закреплённые');
    await expect(list.locator('ul').first().locator('.hist__item')).toHaveCount(1);
    await expect(list.locator('ul').first()).toContainText('MOW → KGD');
    await expect(list.locator('.hist__item').first()).toContainText('MOW → KGD');

    // Закрепление сохраняется на сервере
    await page.keyboard.press('Escape');
    await page.reload();
    await settled(page);
    await openDrawer(page);
    await expect(list.locator('.hist__item').first()).toContainText('MOW → KGD');
    await expect(list.locator('.hist__item').first().getByTestId('history-pin')).toHaveAttribute('aria-pressed', 'true');

    const before = await list.locator('.hist__item').count();
    await list.locator('.hist__item').filter({ hasText: 'MOW → LED' }).first().getByTestId('history-delete').click();
    await expect(list.locator('.hist__item')).toHaveCount(before - 1);
    await expect(list.locator('.hist__item').filter({ hasText: 'MOW → LED' })).toHaveCount(0);
    const fromServer = (await (await page.request.get('/api/history')).json()) as { items: Array<{ route: string }> };
    expect(fromServer.items.some((i) => i.route === 'MOW-LED')).toBe(false);
  });

  test('клик по записи открывает этот расчёт', async ({ page }) => {
    await openApp(page);
    await calcAndSave(page, { to: 'MRV', date: '2026-06-21', price: 7700 });
    await calculate(page, { to: 'AER', date: '2026-06-02', price: 9100 });
    await openDrawer(page);
    const res = waitForecast(page);
    await page.getByTestId('history-item').filter({ hasText: 'MOW → MRV' }).click();
    expect((await res).request().postDataJSON()).toEqual({ from: 'MOW', to: 'MRV', date: '2026-06-21', price: 7700 });
    await settled(page);
    await expect(page.getByTestId('history-drawer')).toHaveCount(0);
    await expect(page.getByTestId('to')).toHaveValue('MRV');
    await expect(page.getByTestId('date')).toHaveValue('2026-06-21');
    await expect(page.getByTestId('price')).toHaveValue('7700');
  });

  test('массовое удаление истории сохраняет закреплённые по выбору', async ({ page }) => {
    await registerViaApi(page);
    for (const to of ['KGD', 'LED']) {
      const saved = await page.request.post('/api/history', {
        data: { from: 'MOW', to, date: '2026-06-01', price: 7000 },
      });
      expect(saved.ok()).toBe(true);
    }

    await page.goto('/board');
    await openDrawer(page);
    const list = page.getByTestId('history-list');
    const items = list.getByTestId('history-item');
    const pinned = list.locator('.hist__item').filter({ hasText: 'MOW → KGD' });
    await expect(items).toHaveCount(2);
    await pinned.getByTestId('history-pin').click();
    await expect(pinned.getByTestId('history-pin')).toHaveAttribute('aria-pressed', 'true');

    const clearUnpinned = page.getByTestId('history-clear-unpinned');
    const clearAll = page.getByTestId('history-clear-all');
    await clearUnpinned.click();
    await expect(items).toHaveCount(1);
    await expect(items.first()).toContainText('MOW → KGD');
    await expect(clearAll).toBeEnabled();
    await expect(clearUnpinned).toBeDisabled();
    await expect(clearUnpinned).toHaveCSS('cursor', 'default');
    const unpinnedRemoved = await page.request.get('/api/history');
    expect((await unpinnedRemoved.json()).items).toMatchObject([{ route: 'MOW-KGD', pinned: true }]);

    await clearAll.click();
    await expect(items).toHaveCount(0);
    const allRemoved = await page.request.get('/api/history');
    expect((await allRemoved.json()).items).toEqual([]);
  });

  test('история у каждого пользователя своя', async ({ page, browser }) => {
    await openApp(page);
    await calcAndSave(page, { to: 'OVB', price: 12345 });
    const other = await browser.newContext();
    const p2 = await other.newPage();
    try {
      await openApp(p2);
      const res = (await (await p2.request.get('/api/history')).json()) as { items: Array<{ price: number }> };
      expect(res.items.some((i) => i.price === 12345)).toBe(false);
    } finally {
      await other.close();
    }
  });

  // Было: после удаления последней записи фокус теряется (уходит на <body>), а обработчик Escape
  // висит на панели — Escape больше не закрывает диалог.
  test('после удаления последней записи Escape закрывает панель', async ({ page }) => {
    await openApp(page);
    await calcAndSave(page, { price: 9900 });
    await openDrawer(page);
    const items = page.getByTestId('history-list').locator('.hist__item');
    // Удаляем все записи по одной (в истории может быть и стартовый расчёт)
    for (let n = await items.count(); n > 0; n--) {
      await items.first().getByTestId('history-delete').click();
      await expect(items).toHaveCount(n - 1);
    }
    await page.keyboard.press('Escape');
    await expect(page.getByTestId('history-drawer')).toHaveCount(0, { timeout: 2000 });
  });
});
