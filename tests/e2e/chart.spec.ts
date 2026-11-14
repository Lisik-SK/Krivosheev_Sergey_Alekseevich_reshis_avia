import { test, expect, openApp, calculate } from './support/fixtures';
import { expected, num1, int, norm } from './support/data';

const QLABELS = ['P10', 'P20', 'P30', 'P40', 'P50', 'P60', 'P70', 'P80', 'P90'];

test.describe('График сценариев спроса', () => {
  test('9 столбцов, подпись медианы «хотят купить», линия мест с числом мест', async ({ page }) => {
    const e = expected('MOW-OVB', '2026-06-05', 12500);
    await openApp(page);
    await calculate(page, { to: 'OVB', date: '2026-06-05', price: 12500 });

    const chart = page.getByTestId('demand-chart');
    await expect(chart.locator('.hit')).toHaveCount(9);
    await expect(chart).toHaveAttribute('data-cols', '9');
    expect(await chart.locator('.tick-x').allTextContents()).toEqual(QLABELS);
    expect(norm(await chart.locator('.value-label').textContent())).toBe(num1(e.wants));
    expect(norm(await chart.locator('.value-label').textContent())).toBe(norm(await page.getByTestId('wants').textContent()));
    await expect(chart.locator('.value-label-sub')).toHaveText('хотят купить');
    await expect(chart.locator('.seats-line')).toHaveCount(1);
    expect(norm(await chart.locator('.seats-label').textContent())).toContain(`${int(e.seats)}мест`);
    await expect(chart.locator('svg')).toHaveAttribute('aria-label', /9 сценариям/);

    // Каждый столбец доступен скринридеру со значениями своего сценария
    const labels = await chart.locator('.hit').evaluateAll((els) => els.map((el) => el.getAttribute('aria-label') ?? ''));
    labels.forEach((l, i) => {
      const sc = e.scenarios[i]!;
      expect(l).toContain(QLABELS[i]!);
      expect(norm(l)).toContain(`спросневыше${num1(sc.wants)}`);
      expect(norm(l)).toContain(`Купят${num1(sc.sales)}`);
    });

    // Подпись под графиком: диапазон P10..P90 и медиана
    const caption = norm(await page.getByTestId('chart-caption').textContent());
    expect(caption).toContain(`от${num1(Math.max(0, e.scenarios[0]!.wants))}до${num1(Math.max(0, e.scenarios[8]!.wants))}`);
    expect(caption).toContain('80%');
  });

  test('наведение на столбец показывает подсказку со значениями', async ({ page }) => {
    const e = expected('MOW-AER', '2026-06-01', 9500);
    await openApp(page);
    await calculate(page, { to: 'AER', date: '2026-06-01', price: 9500 });
    const chart = page.getByTestId('demand-chart');
    const tooltip = chart.locator('.tooltip');
    await expect(tooltip).toBeHidden();

    await chart.locator('.hit').nth(8).hover();
    await expect(tooltip).toBeVisible();
    const p90 = e.scenarios[8]!;
    const t = norm(await tooltip.textContent());
    expect(t).toContain('P90');
    expect(t).toContain(`Хотяткупить${num1(p90.wants)}`);
    expect(t).toContain(`Купят${num1(p90.sales)}`);
    expect(t).toContain(p90.overflow > 0 ? `Нехватитмест${num1(p90.overflow)}` : `Свободномест${num1(e.seats - p90.sales)}`);
    await expect(chart.locator('.col').nth(8)).toHaveClass(/is-active/);
    // Подсказка у правого края не вылезает за пределы графика
    const tb = (await tooltip.boundingBox())!;
    const cb = (await chart.boundingBox())!;
    expect(tb.x).toBeGreaterThanOrEqual(cb.x - 1);
    expect(tb.x + tb.width).toBeLessThanOrEqual(cb.x + cb.width + 1);

    await chart.locator('.hit').nth(4).hover();
    const t2 = norm(await tooltip.textContent());
    expect(t2).toContain('P50');
    expect(t2).toContain(`Хотяткупить${num1(e.wants)}`);

    // Уводим курсор — подсказка прячется
    await page.mouse.move(1, 1);
    await expect(tooltip).toBeHidden();
  });

  test('клавиатура: фокус на столбце и стрелка вправо/влево', async ({ page }) => {
    await openApp(page);
    const hits = page.getByTestId('demand-chart').locator('.hit');
    await hits.first().focus();
    await expect(hits.first()).toBeFocused();
    await expect(page.getByTestId('demand-chart').locator('.tooltip')).toBeVisible();
    await page.keyboard.press('ArrowRight');
    await expect(hits.nth(1)).toBeFocused();
    expect(await page.evaluate(() => document.activeElement?.getAttribute('data-q'))).toBe('0.2');
    await page.keyboard.press('ArrowRight');
    await page.keyboard.press('ArrowLeft');
    await expect(hits.nth(1)).toBeFocused();
    // На краю — не уходит за пределы
    await page.keyboard.press('ArrowLeft');
    await page.keyboard.press('ArrowLeft');
    await expect(hits.first()).toBeFocused();
    await expect(page.getByTestId('demand-chart').locator('.tooltip')).toContainText('P10');
  });

  test('при изменении ширины окна график перерисовывается под новую ширину', async ({ page }) => {
    await openApp(page);
    const chart = page.getByTestId('demand-chart');
    const before = Number(await chart.locator('svg').getAttribute('width'));
    const vp = page.viewportSize()!;
    await page.setViewportSize({ width: Math.max(360, Math.round(vp.width * 0.6)), height: vp.height });
    await expect.poll(async () => Number(await chart.locator('svg').getAttribute('width'))).toBeLessThan(before);
    await expect(chart.locator('.hit')).toHaveCount(9);
    const fits = await chart.evaluate((el) => el.querySelector('svg')!.getBoundingClientRect().width <= el.clientWidth + 1);
    expect(fits).toBe(true);
  });

  test('когда желающих больше мест — есть «переполнение» (.bar-over)', async ({ page }) => {
    const e = expected('MOW-AER', '2026-06-01', 5000);
    expect(e.wants).toBeGreaterThan(e.seats);
    await openApp(page);
    await calculate(page, { to: 'AER', date: '2026-06-01', price: 5000 });
    const over = page.getByTestId('demand-chart').locator('.bar-over');
    expect(await over.count()).toBe(e.scenarios.filter((s) => s.overflow > 0).length);
    await expect(page.getByTestId('demand-chart').locator('.col--median .bar-over')).toHaveCount(1);
  });

  test('когда мест хватает всем сценариям — переполнения нет', async ({ page }) => {
    const e = expected('MOW-AER', '2026-06-01', 12000);
    expect(e.scenarios.every((s) => s.overflow === 0)).toBe(true);
    await openApp(page);
    await calculate(page, { to: 'AER', date: '2026-06-01', price: 12000 });
    await expect(page.getByTestId('demand-chart').locator('.hit')).toHaveCount(9);
    await expect(page.getByTestId('demand-chart').locator('.bar-over')).toHaveCount(0);
  });

  test('переключение на таблицу: 9 строк, медиана выделена, значения совпадают', async ({ page }) => {
    const e = expected('MOW-AER', '2026-06-01', 7000);
    await openApp(page);
    await calculate(page, { to: 'AER', date: '2026-06-01', price: 7000 });

    const toggle = page.getByTestId('table-toggle');
    await expect(toggle).toHaveAttribute('aria-pressed', 'false');
    await toggle.click();
    await expect(toggle).toHaveAttribute('aria-pressed', 'true');
    await expect(page.getByTestId('demand-chart')).toHaveCount(0);

    const table = page.getByTestId('scenario-table');
    const rows = table.locator('tbody tr');
    await expect(rows).toHaveCount(9);
    await expect(table.locator('tbody tr.is-median')).toHaveCount(1);
    await expect(rows.nth(4)).toHaveClass(/is-median/);
    await expect(rows.nth(4).locator('td').first()).toContainText('медиана');

    for (let i = 0; i < 9; i++) {
      const sc = e.scenarios[i]!;
      const cells = (await rows.nth(i).locator('td').allTextContents()).map(norm);
      expect(cells[0]).toContain(QLABELS[i]!);
      expect(cells.slice(1)).toEqual([
        num1(sc.base),
        num1(sc.wants),
        num1(sc.sales),
        sc.overflow > 0 ? num1(sc.overflow) : '—',
        num1(sc.free),
      ]);
    }

    // Режим «Таблица» сохраняется при пересчёте
    await calculate(page, { price: 7100 });
    await expect(page.getByTestId('scenario-table')).toBeVisible();

    // Назад к графику
    await page.getByRole('button', { name: 'График' }).click();
    await expect(page.getByTestId('demand-chart').locator('.hit')).toHaveCount(9);
    await expect(page.getByTestId('scenario-table')).toHaveCount(0);
  });
});
