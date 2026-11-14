import type { Page } from '@playwright/test';
import type { Meta } from '../../src/client/api';
import { test, expect, openApp, calculate, settled, waitForecast, forecastAt, textOf } from './support/fixtures';
import { expected, margin, num1, norm } from './support/data';

async function enableCompare(page: Page, priceB: number) {
  const b = forecastAt(page, priceB);
  // Чекбокс визуально скрыт внутри label-переключателя
  await page.getByTestId('compare-toggle').check({ force: true });
  await expect(page.getByTestId('price-b')).toBeVisible();
  await page.getByTestId('price-b').fill(String(priceB));
  await b;
  await settled(page);
  await expect(page.getByTestId('compare-card')).toBeVisible();
}

/** Ячейки строки сравнения: [показатель, цена 1, цена 2, разница] без пробелов. */
async function compareRows(page: Page): Promise<string[][]> {
  const rows = page.getByTestId('compare-card').locator('tbody tr');
  const out: string[][] = [];
  for (let i = 0; i < (await rows.count()); i++) out.push((await rows.nth(i).locator('td').allTextContents()).map(norm));
  return out;
}

test.describe('Сравнение двух цен', () => {
  /**
   * Проверяет фокус через Tab и Shift+Tab и оба состояния сравнения через Enter и пробел.
   * @param page Обязательная страница Playwright, где создаётся тестовая сессия и открывается калькулятор.
   * @returns Promise<void> после завершения обеих проверок.
   * @throws Ошибки подготовки страницы, действий Playwright или невыполненных проверок.
   * @remarks Нажатия меняют видимость второй цены и фокус. После каждой пары нажатий сравнение выключено.
   */
  test('переключатель доступен через Tab, Enter и пробел', async ({ page }) => {
    await openApp(page);
    const toggle = page.getByRole('checkbox', { name: 'Сравнить с другой ценой' });
    const comparisonPrice = page.getByTestId('price-b');

    await page.getByTestId('model-price-1').focus();
    await page.keyboard.press('Tab');
    await expect(toggle).toBeFocused();
    await expect(page.locator('.switch__track')).toHaveCSS('outline-style', 'solid');
    await expect(toggle).not.toBeChecked();
    await expect(comparisonPrice).toBeHidden();

    for (const key of ['Enter', 'Space']) {
      await page.keyboard.press(key);
      await expect(toggle).toBeChecked();
      await expect(comparisonPrice).toBeVisible();
      await expect(comparisonPrice).toBeFocused();

      await page.keyboard.press('Shift+Tab');
      await expect(toggle).toBeFocused();
      await page.keyboard.press(key);
      await expect(toggle).not.toBeChecked();
      await expect(comparisonPrice).toBeHidden();
      await expect(toggle).toBeFocused();
    }
  });

  test('каждая кнопка «база» выставляет тариф текущего маршрута только для своей цены', async ({ page }) => {
    const [code, date, base, first, second] = ['MOW-KGD', '2026-06-12', 7500, 8100, 9600] as const;
    await openApp(page, `?from=MOW&to=KGD&date=${date}&price=${first}&b=${second}`);

    const baseButtons = page.getByRole('button', { name: /^база 7\s500$/ });
    await expect(baseButtons).toHaveCount(2);
    await expect(baseButtons.first()).toHaveAccessibleDescription('Цена 1, ₽');
    await expect(baseButtons.last()).toHaveAccessibleDescription('Цена 2, ₽');

    let response = forecastAt(page, base);
    await baseButtons.last().press('Enter');
    expect((await response).ok()).toBe(true);
    await settled(page);
    await expect(page.getByTestId('price')).toHaveValue(String(first));
    await expect(page.getByTestId('price-b')).toHaveValue(String(base));
    await expect(page.getByTestId('price-slider-2')).toHaveValue(String(base));
    expect((await compareRows(page))[0]!.slice(1, 3)).toEqual([
      num1(expected(code, date, first).wants), num1(expected(code, date, base).wants),
    ]);

    response = forecastAt(page, second);
    await page.getByTestId('price-b').fill(String(second));
    await response;
    await settled(page);
    response = forecastAt(page, base);
    await baseButtons.first().click();
    expect((await response).ok()).toBe(true);
    await settled(page);
    await expect(page.getByTestId('price')).toHaveValue(String(base));
    await expect(page.getByTestId('price-slider-1')).toHaveValue(String(base));
    await expect(page.getByTestId('price-b')).toHaveValue(String(second));
    expect((await compareRows(page))[0]!.slice(1, 3)).toEqual([
      num1(expected(code, date, base).wants), num1(expected(code, date, second).wants),
    ]);
  });

  test('кнопка «база» выставляет дробный тариф без округления ползунком', async ({ page }) => {
    const base = 7555.5;
    await page.route('**/api/meta', async (request) => {
      const response = await request.fetch();
      const meta = await response.json() as Meta;
      meta.routes.find((route) => route.code === 'MOW-KGD')!.basePrice = base;
      await request.fulfill({ response, json: meta });
    });
    await openApp(page, '?from=MOW&to=KGD&date=2026-06-12&price=8100');

    const response = forecastAt(page, base);
    await page.getByRole('button', { name: /^база 7\s555,5\s₽$/ }).click();
    expect((await response).ok()).toBe(true);
    await settled(page);
    await expect(page.getByTestId('price')).toHaveValue(String(base));
    await expect(page.getByTestId('price-slider-1')).toHaveValue(String(base));
  });

  test('результаты для цен 1 и 2 совпадают с двумя отдельными расчётами', async ({ page }) => {
    const [code, date, pa, pb] = ['MOW-AER', '2026-06-01', 9500, 11000] as const;
    const a = expected(code, date, pa);
    const b = expected(code, date, pb);

    await openApp(page);
    await calculate(page, { to: 'AER', date, price: pa });
    await expect(page.getByTestId('compare-card')).toHaveCount(0);
    await expect(page.getByTestId('price-b')).toBeHidden();

    await enableCompare(page, pb);
    await expect(page.getByTestId('price')).toHaveAccessibleName(/Цена 1/);
    await expect(page.getByTestId('price-b')).toHaveAccessibleName(/Цена 2/);
    const comparison = page.getByTestId('compare-card');
    await expect(page.getByTestId('results').locator(':scope > :first-child')).toHaveAttribute('data-testid', 'compare-card');
    await expect(comparison.getByRole('columnheader', { name: /Цена 1/ })).toBeVisible();
    await expect(comparison.getByRole('columnheader', { name: /Цена 2/ })).toBeVisible();
    await expect(comparison.getByRole('columnheader', { name: 'Отличие цены 2 от цены 1', exact: true })).toBeVisible();
    const rows = await compareRows(page);
    // Строки 0..2: хотят, купят, свободно (дробные, как в формуле)
    expect(rows[0]!.slice(1, 3)).toEqual([num1(a.wants), num1(b.wants)]);
    expect(rows[1]!.slice(1, 3)).toEqual([num1(a.sales), num1(b.sales)]);
    expect(rows[2]!.slice(1, 3)).toEqual([num1(a.seats - a.sales), num1(b.seats - b.sales)]);
    // Загрузка
    expect(rows[3]!.slice(1, 3)).toEqual([`${a.loadPct}%`, `${b.loadPct}%`]);
    // Последняя строка — риск распродажи
    expect(rows[rows.length - 1]!.slice(1, 3)).toEqual([norm(a.sellOut), norm(b.sellOut)]);
    // Разница спроса при цене 2 и цене 1
    const dWants = b.wants - a.wants;
    expect(rows[0]![3]).toBe(`${dWants > 0 ? '+' : '-'}${num1(Math.abs(dWants))}`);

    // Вердикт: какая цена даёт больше дохода
    const ma = margin(code, date, pa);
    const mb = margin(code, date, pb);
    expect(ma).not.toBe(mb);
    await expect(page.getByTestId('compare-verdict')).toContainText(mb > ma ? 'Цена 2' : 'Цена 1');

    // Цена 1 соответствует основному расчёту
    expect(await textOf(page, 'wants')).toBe(num1(a.wants));

    // Отдельный расчёт по цене 2 даёт те же числа, что её колонка
    await page.getByTestId('compare-toggle').uncheck({ force: true });
    await calculate(page, { price: pb });
    await expect(page.getByTestId('compare-card')).toHaveCount(0);
    expect(await textOf(page, 'wants')).toBe(rows[0]![2]);
  });

  test('перезагрузка восстанавливает цену 2 при включённом и выключенном сравнении', async ({ page }) => {
    await openApp(page);
    await calculate(page, { to: 'LED', date: '2026-06-05', price: 5000 });
    await enableCompare(page, 6100);
    expect(new URL(page.url()).searchParams.get('b')).toBe('6100');

    const requests: number[] = [];
    page.on('request', (r) => {
      if (r.url().endsWith('/api/forecast') && r.method() === 'POST') requests.push((r.postDataJSON() as { price: number }).price);
    });
    const res = waitForecast(page);
    await page.reload();
    await res;
    await settled(page);
    await expect(page.getByTestId('compare-toggle')).toBeChecked();
    await expect(page.getByTestId('price-b')).toHaveValue('6100');
    await expect(page.getByTestId('compare-card')).toBeVisible();
    expect(requests.sort()).toEqual([5000, 6100]);
    const rows = await compareRows(page);
    expect(rows[0]!.slice(1, 3)).toEqual([num1(expected('MOW-LED', '2026-06-05', 5000).wants), num1(expected('MOW-LED', '2026-06-05', 6100).wants)]);

    // Выключили сравнение — параметр b уходит из URL
    const r2 = waitForecast(page);
    await page.getByTestId('compare-toggle').uncheck({ force: true });
    await r2;
    await settled(page);
    await expect(page.getByTestId('compare-card')).toHaveCount(0);
    expect(new URL(page.url()).searchParams.get('b')).toBeNull();

    requests.length = 0;
    const single = waitForecast(page);
    await page.reload();
    await single;
    await settled(page);
    await expect(page.getByTestId('compare-toggle')).not.toBeChecked();
    await expect(page.getByTestId('price-b')).toBeHidden();
    await expect(page.getByTestId('price-b')).toHaveValue('6100');
    await expect(page.getByTestId('compare-card')).toHaveCount(0);
    expect(requests).toEqual([5000]);

    const compared = forecastAt(page, 6100);
    await page.getByTestId('compare-toggle').check({ force: true });
    expect((await compared).ok()).toBe(true);
    await settled(page);
    await expect(page.getByTestId('price-b')).toHaveValue('6100');
    expect(await compareRows(page)).toEqual(rows);
  });

  test('новая цена и выключение сравнения сохраняются до запуска расчёта', async ({ page }) => {
    await page.clock.install();
    await openApp(page, '?b=11000');
    const input = page.getByTestId('price-b');
    await expect(input).toHaveValue('11000');
    // Останавливаем таймер расчёта, чтобы обновить страницу с ещё не применённой ценой.
    await page.clock.pauseAt(Date.now() + 1000);
    await input.fill('11500');
    await page.getByTestId('compare-toggle').uncheck({ force: true });
    await expect(input).toBeHidden();
    expect(new URL(page.url()).searchParams.has('b')).toBe(false);
    const reloaded = waitForecast(page);
    await page.reload();
    await page.clock.resume();
    expect((await reloaded).ok()).toBe(true);
    await settled(page);
    await expect(page.getByTestId('compare-toggle')).not.toBeChecked();
    await expect(input).toBeHidden();
    await expect(input).toHaveValue('11500');
    await expect(page.getByTestId('compare-card')).toHaveCount(0);
    expect(new URL(page.url()).searchParams.get('b')).toBeNull();
  });

  test('оба ползунка обновляют цену, URL и сравнение только после отпускания', async ({ page }) => {
    await openApp(page);
    await expect(page.getByTestId('price-slider-2')).toBeHidden();
    await enableCompare(page, 11000);
    await expect(page.getByTestId('price-slider-2')).toHaveValue('11000');
    let requests = 0;
    page.on('request', (request) => {
      if (request.url().endsWith('/api/forecast') && request.method() === 'POST') requests++;
    });
    for (const [number, field, otherField, queryParam, target] of [
      [1, 'price', 'price-b', 'price', 0.7],
      [2, 'price-b', 'price', 'b', 0.85],
    ] as const) {
      const input = page.getByTestId(field);
      const other = page.getByTestId(otherField);
      const slider = page.getByTestId(`price-slider-${number}`);
      const previous = await input.inputValue();
      const otherPrice = await other.inputValue();
      const previousRows = await compareRows(page);
      const previousRequests = requests;
      await slider.scrollIntoViewIfNeeded();
      const { x, y, width, height } = (await slider.boundingBox())!;
      await page.mouse.move(x + width * 0.55, y + height / 2);
      await page.mouse.down();
      await page.mouse.move(x + width * target, y + height / 2, { steps: 4 });
      await expect(slider).not.toHaveValue(previous);
      await page.waitForTimeout(300);
      await expect(input).toHaveValue(previous);
      expect(await compareRows(page)).toEqual(previousRows);
      expect(new URL(page.url()).searchParams.get(queryParam)).toBe(previous);
      expect(requests).toBe(previousRequests);

      const price = await slider.inputValue();
      const updated = forecastAt(page, Number(price));
      await page.mouse.up();
      expect((await updated).ok()).toBe(true);
      await settled(page);
      await expect(input).toHaveValue(price);
      await expect(other).toHaveValue(otherPrice);
      expect(new URL(page.url()).searchParams.get(queryParam)).toBe(price);
      expect((await compareRows(page))[0]![number]).toBe(num1(expected('MOW-AER', '2026-06-01', Number(price)).wants));
    }
  });

  test('некорректная цена 2 — ошибка у поля, запроса нет', async ({ page }) => {
    await openApp(page);
    const both = page.waitForResponse((r) => r.url().endsWith('/api/forecast') && (r.request().postDataJSON() as { price: number }).price !== 9000);
    await page.getByTestId('compare-toggle').check({ force: true });
    await page.getByTestId('price-b').fill('10000');
    await both;
    await expect(page.getByTestId('compare-card')).toBeVisible();
    await settled(page);
    let count = 0;
    page.on('request', (r) => {
      if (r.url().endsWith('/api/forecast')) count++;
    });
    await page.getByTestId('price-b').fill('-1');
    await expect(page.locator('#err-price-b')).not.toBeEmpty();
    await expect(page.getByTestId('price-b')).toHaveAttribute('aria-invalid', 'true');
    await page.waitForTimeout(500);
    expect(count).toBe(0);
  });
});
