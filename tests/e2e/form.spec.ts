import type { Page, Request } from '@playwright/test';
import { test, expect, openApp, calculate, chooseOption, isForecast, registerViaApi, settled, textOf } from './support/fixtures';
import { datesOf, expected, flight, num1, route } from './support/data';

function forecastRequests(page: Page): Request[] {
  const list: Request[] = [];
  page.on('request', (r) => {
    if (r.url().endsWith('/api/forecast') && r.method() === 'POST') list.push(r);
  });
  return list;
}

function responseFor(page: Page, pred: (b: { from: string; to: string; date: string; price: number }) => boolean) {
  return page.waitForResponse((res) => isForecast(res) && pred(res.request().postDataJSON()));
}

test.describe('Поведение формы', () => {
  test('смена направления обновляет диапазон дат и сохраняет введённую цену', async ({ page }) => {
    await openApp(page);
    const aer = datesOf('MOW-AER');
    await expect(page.getByTestId('from')).toHaveValue('MOW');
    await expect(page.getByTestId('to')).toHaveValue('AER');
    await expect(page.getByTestId('date')).toHaveAttribute('min', aer[0]!);
    await expect(page.getByTestId('date')).toHaveAttribute('max', aer[aer.length - 1]!);
    await expect(page.getByTestId('price')).toHaveValue(String(route('MOW-AER').basePrice));

    // Опции «Куда» соответствуют маршрутам из routes.csv
    const opts = await page.getByTestId('to').locator('option:not(:disabled)').evaluateAll((els) => els.map((e) => (e as HTMLOptionElement).value));
    expect(opts.sort()).toEqual(['AER', 'KGD', 'LED', 'MRV', 'OVB']);

    await calculate(page, { date: '2026-06-15', price: 9999 });

    const ovb = datesOf('MOW-OVB');
    const res = responseFor(page, (b) => b.to === 'OVB');
    await chooseOption(page, 'to', 'OVB');
    const response = await res;
    const body = response.request().postDataJSON() as { price: number; date: string };
    await settled(page);
    await expect(page.getByTestId('price')).toHaveValue('9999');
    expect(body.price).toBe(9999);
    await expect(page.getByTestId('date')).toHaveAttribute('min', ovb[0]!);
    await expect(page.getByTestId('date')).toHaveAttribute('max', ovb[ovb.length - 1]!);
    await expect(page.getByTestId('date')).toHaveValue('2026-06-15');
    expect((await response.json()).route.code).toBe('MOW-OVB');
    expect(await textOf(page, 'seats')).toBe(String(flight('MOW-OVB', body.date).seats));
  });

  test('стрелки даты отключаются и приглушаются на границах прогноза', async ({ page, isMobile }) => {
    const theme = isMobile ? 'dark' : 'light';
    await page.addInitScript((value) => localStorage.setItem('ra-theme', value), theme);
    await openApp(page);
    await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
    const dates = datesOf('MOW-AER');
    const prev = page.getByRole('button', { name: 'Предыдущий день' });
    const next = page.getByRole('button', { name: 'Следующий день' });
    await expect(page.getByTestId('date')).toHaveValue(dates[0]!);
    await expect(prev).toBeDisabled();
    await expect(prev).toHaveCSS('opacity', '0.5');
    await expect(prev).toHaveCSS('cursor', 'default');
    if (!isMobile) {
      const background = await prev.evaluate((button) => getComputedStyle(button).backgroundColor);
      const color = await prev.evaluate((button) => getComputedStyle(button).color);
      await prev.hover();
      await prev.evaluate(async (button) => {
        await Promise.all(button.getAnimations().map((animation) => animation.finished));
      });
      await expect(prev).toHaveCSS('background-color', background);
      await expect(prev).toHaveCSS('color', color);
    }
    await expect(next).toBeEnabled();
    await expect(next).toHaveCSS('opacity', '1');

    let res = responseFor(page, (b) => b.date === dates[1]);
    await next.click();
    expect((await (await res).json()).date).toBe(dates[1]);
    await settled(page);
    await expect(page.getByTestId('date')).toHaveValue(dates[1]!);
    await expect(prev).toBeEnabled();
    await expect(prev).toHaveCSS('opacity', '1');
    const e = expected('MOW-AER', dates[1]!, route('MOW-AER').basePrice);
    expect(await textOf(page, 'wants')).toBe(num1(e.wants));

    res = responseFor(page, (b) => b.date === dates[0]);
    await prev.click();
    await res;
    await expect(page.getByTestId('date')).toHaveValue(dates[0]!);

    const last = dates[dates.length - 1]!;
    res = responseFor(page, (b) => b.date === last);
    await page.getByTestId('date-display').fill(last);
    await res;
    await expect(next).toBeDisabled();
    await expect(next).toHaveCSS('opacity', '0.5');
    await expect(next).toHaveCSS('cursor', 'default');
    await expect(prev).toBeEnabled();
  });

  test('некорректная цена: ошибка у поля и нет запроса', async ({ page }) => {
    await openApp(page);
    const reqs = forecastRequests(page);
    const price = page.getByTestId('price');
    const err = page.locator('#err-price');

    await price.fill('');
    await expect(err).toHaveText('Укажите цену билета');
    await expect(price).toHaveAttribute('aria-invalid', 'true');

    await price.fill('-500');
    await expect(err).toHaveText('Цена не может быть отрицательной');

    await price.fill('2000000');
    await expect(err).toContainText(/не больше 1.000.000/);

    // Даём отработать debounce (250 мс) — запросов всё равно быть не должно
    await page.waitForTimeout(700);
    expect(reqs).toHaveLength(0);

    // Исправили — ошибка пропадает, расчёт выполняется
    await calculate(page, { price: 9500 });
    await expect(err).toHaveText('');
    await expect(price).not.toHaveAttribute('aria-invalid', 'true');
    expect(await textOf(page, 'wants')).toBe('704,5');
  });

  test('дата вне диапазона прогноза — ошибка у поля даты', async ({ page }) => {
    await openApp(page);
    const reqs = forecastRequests(page);
    await page.getByTestId('date-display').fill('2026-08-15');
    await expect(page.locator('#err-date')).toHaveText('Прогноз есть с 01.06.2026 по 01.07.2026');
    await expect(page.getByTestId('date')).toHaveAttribute('aria-invalid', 'true');
    await expect(page.getByTestId('date-display')).toHaveAttribute('aria-invalid', 'true');
    await page.waitForTimeout(300);
    expect(reqs).toHaveLength(0);
  });

  test('живой пересчёт после ввода цены (debounce, без нажатия кнопки)', async ({ page }) => {
    await openApp(page);
    await expect(page.getByTestId('query-form').getByRole('button', { name: 'Рассчитать' })).toHaveCount(0);
    await expect(page.getByRole('heading', { level: 1 })).toHaveCSS('cursor', 'default');
    await expect(page.locator('.page__lead')).toHaveCSS('cursor', 'default');
    await expect(page.getByTestId('nav-board')).toHaveCSS('cursor', 'pointer');
    const reqs = forecastRequests(page);
    const price = page.getByTestId('price');
    await expect(price).toHaveCSS('cursor', 'text');
    await price.fill('');
    const res = responseFor(page, (b) => b.price === 9500);
    await price.pressSequentially('9500', { delay: 40 });
    await res;
    await settled(page);
    expect(await textOf(page, 'wants')).toBe('704,5');
    expect(await textOf(page, 'free-seats')).toBe('195');
    // Набор цифр подряд не вызывает запрос на каждую клавишу
    expect(reqs.length).toBe(1);
    expect(new URL(page.url()).searchParams.get('price')).toBe('9500');
  });

  test('«цена модели» подставляет цену выбранного дня в своё поле', async ({ page }) => {
    const code = 'MOW-AER';
    const firstDate = '2026-06-01';
    const nextDate = '2026-06-02';
    const firstPrice = flight(code, firstDate).modelPrice;
    const nextPrice = flight(code, nextDate).modelPrice;
    const formatPrice = new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 2 });
    await registerViaApi(page);
    await page.goto(`/?from=MOW&to=AER&date=${firstDate}`);

    const price = page.getByTestId('price');
    const priceB = page.getByTestId('price-b');
    const firstButton = page.getByTestId('model-price-1');
    const secondButton = page.getByTestId('model-price-2');
    await expect(price).toHaveValue('');
    await expect(page.getByTestId('sales')).toBeHidden();
    await expect(firstButton).toContainText(`цена модели ${formatPrice.format(firstPrice)}`);
    await expect(secondButton).toBeHidden();

    const first = responseFor(page, (b) => b.date === firstDate && b.price === firstPrice);
    await firstButton.click();
    expect((await (await first).json()).modelPrice).toBe(firstPrice);
    await settled(page);
    await expect(price).toHaveValue(String(firstPrice));
    await expect(priceB).toHaveValue('');
    const e = expected(code, firstDate, firstPrice);
    expect(await textOf(page, 'wants')).toBe(num1(e.wants));
    expect(await textOf(page, 'free-seats')).toBe(String(e.freeRounded));

    await page.getByTestId('compare-toggle').check({ force: true });
    await expect(secondButton).toContainText(`цена модели ${formatPrice.format(firstPrice)}`);
    await page.getByRole('button', { name: 'Следующий день' }).click();
    await expect(firstButton).toContainText(`цена модели ${formatPrice.format(nextPrice)}`);
    await expect(secondButton).toContainText(`цена модели ${formatPrice.format(nextPrice)}`);

    const second = responseFor(page, (b) => b.date === nextDate && b.price === nextPrice);
    await secondButton.click();
    expect((await second).ok()).toBe(true);
    await settled(page);
    await expect(page.getByTestId('compare-card')).toBeVisible();
    await expect(price).toHaveValue(String(firstPrice));
    await expect(priceB).toHaveValue(String(nextPrice));

    await page.getByRole('button', { name: 'Очистить поля' }).click();
    await expect(firstButton).toBeHidden();
    await expect(secondButton).toBeHidden();
  });

  test('цена вне price_min..price_max — предупреждение', async ({ page }) => {
    const r = route('MOW-AER');
    await openApp(page);
    await expect(page.getByTestId('price-range-warning')).toHaveCount(0);

    await calculate(page, { price: r.priceMax + 1 });
    await expect(page.getByTestId('query-form').getByTestId('price-range-warning')).toBeVisible();

    await calculate(page, { price: r.priceMax });
    await expect(page.getByTestId('price-range-warning')).toHaveCount(0);

    await calculate(page, { price: r.priceMin - 1 });
    await expect(page.getByTestId('price-range-warning')).toBeVisible();

    await calculate(page, { price: r.priceMin });
    await expect(page.getByTestId('price-range-warning')).toHaveCount(0);
  });
});
