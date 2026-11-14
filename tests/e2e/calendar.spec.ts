import { test, expect, openApp, calculate, settled, isForecast } from './support/fixtures';
import { datesOf, expected, norm, num1 } from './support/data';

test.describe('Календарь загрузки по дням', () => {
  test('кнопка на каждый день прогноза, проценты = продажи/места при текущей цене', async ({ page }) => {
    const [code, price] = ['MOW-KGD', 8000];
    await openApp(page);
    await calculate(page, { to: 'KGD', date: '2026-06-10', price });

    const card = page.getByTestId('calendar-card');
    await card.scrollIntoViewIfNeeded();
    const days = card.locator('button.cal__cell');
    const dates = datesOf(code);
    await expect(days).toHaveCount(dates.length);
    expect(await days.evaluateAll((els) => els.map((e) => e.getAttribute('data-date')))).toEqual(dates);

    const vals = await days.evaluateAll((els) => els.map((e) => [e.getAttribute('data-date'), e.querySelector('.cal__val')?.textContent ?? '']));
    for (const [date, text] of vals) {
      expect(norm(text), `${date}`).toBe(`${expected(code, date!, price).loadPct}%`);
    }
    // Выбранный день отмечен
    await expect(card.locator('button[data-date="2026-06-10"]')).toHaveAttribute('aria-selected', 'true');
    await expect(card.locator('button[aria-selected="true"]')).toHaveCount(1);
  });

  test('при смене цены проценты пересчитываются', async ({ page }) => {
    await openApp(page);
    await calculate(page, { price: 14000 });
    const cell = page.getByTestId('calendar-card').locator('button[data-date="2026-06-20"] .cal__val');
    await expect.poll(async () => norm(await cell.textContent())).toBe(`${expected('MOW-AER', '2026-06-20', 14000).loadPct}%`);
  });

  test('клик по дню меняет дату, пересчитывает прогноз и прокручивает страницу до начала', async ({ page }) => {
    await openApp(page);
    const day = page.getByTestId('calendar-card').locator('button[data-date="2026-06-17"]');
    await day.scrollIntoViewIfNeeded();
    expect(await page.evaluate(() => window.scrollY)).toBeGreaterThan(0);
    const res = page.waitForResponse((x) => isForecast(x) && (x.request().postDataJSON() as { date: string }).date === '2026-06-17');
    await day.click();
    await res;
    await settled(page);
    await expect(page.getByTestId('date')).toHaveValue('2026-06-17');
    await expect(page.getByTestId('calendar-card').locator('button[data-date="2026-06-17"]')).toHaveAttribute('aria-selected', 'true');
    expect(norm(await page.getByTestId('wants').textContent())).toBe(num1(expected('MOW-AER', '2026-06-17', 9000).wants));
    expect(new URL(page.url()).searchParams.get('date')).toBe('2026-06-17');
    await expect.poll(() => page.evaluate(() => window.scrollY)).toBe(0);
  });
});
