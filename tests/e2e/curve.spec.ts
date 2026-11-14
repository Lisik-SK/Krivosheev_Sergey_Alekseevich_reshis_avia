import { test, expect, openApp, calculate, settled, isForecast, textOf } from './support/fixtures';
import { bruteForceOptimum, expected, num1, route } from './support/data';

const CASES = [
  { code: 'MOW-AER', to: 'AER', date: '2026-06-01' },
  { code: 'MOW-OVB', to: 'OVB', date: '2026-06-14' },
  { code: 'MOW-LED', to: 'LED', date: '2026-06-27' },
];

test.describe('Кривая дохода от цены', () => {
  test('наведение показывает подсказку, клик по графику ставит цену и пересчитывает', async ({ page }) => {
    await openApp(page);
    const card = page.getByTestId('curve-card');
    const curve = page.getByTestId('profit-curve');
    await card.scrollIntoViewIfNeeded();
    await expect(curve.locator('svg')).toBeVisible();
    const tooltip = curve.locator('.tooltip');
    await expect(tooltip).toBeHidden();

    const hit = curve.locator('.hit');
    const box = (await hit.boundingBox())!;
    await page.mouse.move(box.x + box.width * 0.75, box.y + box.height / 2);
    await expect(tooltip).toBeVisible();
    await expect(tooltip).toContainText('₽');
    await expect(curve.locator('.crosshair')).toHaveAttribute('visibility', 'visible');

    const r = route('MOW-AER');
    const res = page.waitForResponse((x) => isForecast(x) && (x.request().postDataJSON() as { price: number }).price !== r.basePrice);
    await page.mouse.click(box.x + box.width * 0.75, box.y + box.height / 2);
    const picked = ((await res).request().postDataJSON() as { price: number }).price;
    await settled(page);
    // Цена в правой четверти диапазона маршрута и попала в поле ввода
    expect(picked).toBeGreaterThan(r.priceMin + (r.priceMax - r.priceMin) * 0.6);
    expect(picked).toBeLessThanOrEqual(r.priceMax);
    await expect(page.getByTestId('price')).toHaveValue(String(picked));
    expect(await textOf(page, 'wants')).toBe(num1(expected('MOW-AER', '2026-06-01', picked).wants));

    await page.mouse.move(1, 1);
    await expect(tooltip).toBeHidden();
  });

  for (const c of CASES) {
    test(`«Подставить эту цену» = оптимум перебором (${c.code} ${c.date})`, async ({ page }) => {
      const best = bruteForceOptimum(c.code, c.date);
      await openApp(page);
      await calculate(page, { to: c.to, date: c.date, price: route(c.code).basePrice + 123 });

      const res = page.waitForResponse((x) => isForecast(x) && (x.request().postDataJSON() as { price: number }).price === best.price);
      await page.getByTestId('apply-best-price').click();
      await res;
      await settled(page);
      await expect(page.getByTestId('price')).toHaveValue(String(best.price));
      expect(await textOf(page, 'wants')).toBe(num1(expected(c.code, c.date, best.price).wants));
      // В подписи под кривой — та же цена
      const note = await textOf(page, 'best-price-note');
      expect(note).toContain(new Intl.NumberFormat('ru-RU').format(best.price).replace(/\s/g, ''));
    });
  }

  test('клавиатура: фокус на кривой, стрелки и Enter выбирают цену', async ({ page }) => {
    await openApp(page);
    const hit = page.getByTestId('profit-curve').locator('.hit');
    await hit.focus();
    await expect(page.getByTestId('profit-curve').locator('.tooltip')).toBeVisible();
    await page.keyboard.press('ArrowRight');
    await page.keyboard.press('ArrowRight');
    const res = page.waitForResponse((x) => isForecast(x));
    await page.keyboard.press('Enter');
    const price = ((await res).request().postDataJSON() as { price: number }).price;
    expect(price).toBeGreaterThan(route('MOW-AER').basePrice);
    await settled(page);
    await expect(page.getByTestId('price')).toHaveValue(String(price));
  });
});
