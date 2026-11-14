/**
 * Клавиатура: календарь стрелками, Enter и пробел, куда девается фокус после выбора,
 * удержание фокуса в панели истории.
 */
import type { Page } from '@playwright/test';
import { test, expect, openApp, settled, waitForecast } from '../e2e/support/fixtures';

const Q = '?from=MOW&to=AER&date=2026-06-01&price=9500';

const activeDate = (page: Page) => page.evaluate(() => document.activeElement?.getAttribute('data-date') ?? null);
const focusOnBody = (page: Page) => page.evaluate(() => !document.activeElement || document.activeElement === document.body);

async function calendarDates(page: Page): Promise<string[]> {
  return page.getByTestId('calendar').locator('button.cal__cell').evaluateAll((els) => els.map((e) => e.getAttribute('data-date')!));
}

test.describe('Календарь с клавиатуры', () => {
  test('стрелки двигают фокус: ←/→ на день, ↑/↓ на неделю, за край не уходит', async ({ page }) => {
    await openApp(page, Q);
    const dates = await calendarDates(page);
    expect(dates.length).toBeGreaterThan(8);
    const first = page.getByTestId('calendar').locator('button.cal__cell').first();
    await first.focus();
    expect(await activeDate(page)).toBe(dates[0]);

    await page.keyboard.press('ArrowRight');
    expect(await activeDate(page)).toBe(dates[1]);
    await page.keyboard.press('ArrowDown');
    expect(await activeDate(page)).toBe(dates[8]);
    await page.keyboard.press('ArrowUp');
    expect(await activeDate(page)).toBe(dates[1]);
    await page.keyboard.press('ArrowLeft');
    expect(await activeDate(page)).toBe(dates[0]);
    await page.keyboard.press('ArrowLeft');
    expect(await activeDate(page), 'на первом дне ← никуда не уводит').toBe(dates[0]);
    await page.keyboard.press('ArrowUp');
    expect(await activeDate(page), 'в первой неделе ↑ никуда не уводит').toBe(dates[0]);
  });

  test('Enter и пробел выбирают день', async ({ page }) => {
    await openApp(page, Q);
    const dates = await calendarDates(page);
    const cal = page.getByTestId('calendar');

    await cal.locator(`button[data-date="${dates[3]}"]`).focus();
    let res = waitForecast(page);
    await page.keyboard.press('Enter');
    expect((await res).request().postDataJSON()).toMatchObject({ date: dates[3] });
    await settled(page);
    await expect(page.getByTestId('date')).toHaveValue(dates[3]!);
    await expect(cal.locator(`button[data-date="${dates[3]}"]`)).toHaveAttribute('aria-selected', 'true');

    await cal.locator(`button[data-date="${dates[6]}"]`).focus();
    res = waitForecast(page);
    await page.keyboard.press('Space');
    expect((await res).request().postDataJSON()).toMatchObject({ date: dates[6] });
    await settled(page);
    await expect(page.getByTestId('date')).toHaveValue(dates[6]!);
  });

  test('после выбора дня с клавиатуры фокус не теряется', async ({ page }) => {
    await openApp(page, Q);
    const dates = await calendarDates(page);
    await page.getByTestId('calendar').locator(`button[data-date="${dates[4]}"]`).focus();
    const res = waitForecast(page);
    await page.keyboard.press('Enter');
    await res;
    await settled(page);
    expect(await focusOnBody(page), 'фокус ушёл на <body>: пользователю клавиатуры придётся начинать обход страницы сначала').toBe(false);
  });
});

test.describe('Фокус после действий с клавиатуры', () => {
  test('после выбора цены на кривой дохода (Enter) фокус не теряется', async ({ page }) => {
    await openApp(page, Q);
    const hit = page.getByTestId('profit-curve').locator('.hit');
    await hit.focus();
    await page.keyboard.press('ArrowRight');
    await page.keyboard.press('ArrowRight');
    const res = waitForecast(page);
    await page.keyboard.press('Enter');
    await res;
    await settled(page);
    expect(await focusOnBody(page), 'фокус ушёл на <body> после выбора цены').toBe(false);
  });

  test('«Подставить эту цену» с клавиатуры: фокус остаётся на странице результата', async ({ page }) => {
    await openApp(page, Q);
    const apply = page.getByTestId('apply-best-price');
    await apply.focus();
    const res = waitForecast(page);
    await page.keyboard.press('Enter');
    await res;
    await settled(page);
    expect(await focusOnBody(page), 'фокус ушёл на <body> после нажатия кнопки').toBe(false);
  });

  test('переключение «График / Таблица» с клавиатуры оставляет фокус на кнопке', async ({ page }) => {
    await openApp(page, Q);
    const toggle = page.getByTestId('table-toggle');
    await toggle.focus();
    await page.keyboard.press('Enter');
    await expect(page.getByTestId('scenario-table')).toBeVisible();
    await expect(toggle).toBeFocused();
  });
});

test.describe('Панель истории с клавиатуры', () => {
  test('Tab и Shift+Tab не выпускают фокус из панели', async ({ page, browserName }) => {
    test.skip(browserName === 'webkit', 'Safari по умолчанию не переводит фокус клавишей Tab на кнопки');
    await openApp(page, Q);
    await expect
      .poll(async () => ((await (await page.request.get('/api/history')).json()) as { items: unknown[] }).items.length, { timeout: 10_000 })
      .toBeGreaterThan(0);
    await page.getByTestId('history-open').focus();
    await page.keyboard.press('Enter');
    const drawer = page.getByTestId('history-drawer');
    await expect(drawer).toBeVisible();
    await expect(page.getByTestId('history-close')).toBeFocused();
    await expect(page.getByTestId('history-item').first()).toBeVisible();

    const insideDrawer = () => page.evaluate(() => !!document.activeElement?.closest('[data-testid="history-drawer"]'));
    for (let i = 0; i < 8; i++) {
      await page.keyboard.press('Tab');
      expect(await insideDrawer(), `Tab №${i + 1}: фокус вышел из панели`).toBe(true);
    }
    for (let i = 0; i < 8; i++) {
      await page.keyboard.press('Shift+Tab');
      expect(await insideDrawer(), `Shift+Tab №${i + 1}: фокус вышел из панели`).toBe(true);
    }
    await page.keyboard.press('Escape');
    await expect(drawer).toHaveCount(0);
    await expect(page.getByTestId('history-open')).toBeFocused();
  });
});
