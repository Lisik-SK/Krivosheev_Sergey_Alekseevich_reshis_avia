import type { Page } from '@playwright/test';
import { test, expect, newUser, calculate, chooseOption, settled, textOf, numberOf, openApp, loginAdmin } from './support/fixtures';
import { expected, int, num1, norm } from './support/data';

async function expectNoHorizontalOverflow(page: Page, where: string) {
  const m = await page.evaluate(() => ({
    scroll: document.documentElement.scrollWidth,
    client: document.documentElement.clientWidth,
    body: document.body.scrollWidth,
  }));
  expect(m.scroll, `${where}: scrollWidth ${m.scroll} > clientWidth ${m.client}`).toBeLessThanOrEqual(m.client);
  expect(m.body, `${where}: body.scrollWidth`).toBeLessThanOrEqual(m.client);
}

/**
 * Основной сценарий пользователя. Запускается в обоих проектах (desktop-chromium и mobile-chromium / Pixel 7).
 */
test('основной сценарий: регистрация → расчёт → график → таблица → выход; без горизонтальной прокрутки', async ({ page }) => {
  const u = newUser();
  await page.goto('/');
  await expect(page.getByTestId('login-form')).toBeVisible();
  await expectNoHorizontalOverflow(page, 'вход');

  await page.getByRole('tab', { name: 'Регистрация' }).click();
  const form = page.getByTestId('register-form');
  await form.getByLabel('Имя', { exact: true }).fill(u.name);
  await form.getByLabel('Рабочий email', { exact: true }).fill(u.email);
  await form.getByLabel('Пароль', { exact: true }).fill(u.password);
  await expectNoHorizontalOverflow(page, 'регистрация');
  await form.getByRole('button', { name: 'Создать аккаунт' }).click();

  await expect(page.getByTestId('user-chip')).toBeAttached(); // на телефоне чип скрыт стилями
  await expect(page.getByTestId('query-form')).toBeVisible();
  await expectNoHorizontalOverflow(page, 'пустая форма рейса');

  // Пример из условия
  await chooseOption(page, 'from', 'MOW');
  await chooseOption(page, 'to', 'AER');
  await page.getByTestId('date-display').fill('2026-06-01');
  await calculate(page, { price: 9500 });
  expect(await textOf(page, 'seats')).toBe('900');
  expect(await numberOf(page, 'sales')).toBe('705');
  expect(await textOf(page, 'free-seats')).toBe('195');
  expect(await textOf(page, 'wants')).toBe('704,5');

  // Другой маршрут с переполнением
  const e = expected('MOW-OVB', '2026-06-01', 9000);
  await calculate(page, { to: 'OVB', price: 9000 });
  expect(await textOf(page, 'seats')).toBe(int(e.seats));
  expect(await numberOf(page, 'sales')).toBe(int(e.salesRounded));
  expect(await textOf(page, 'wants')).toBe(num1(e.wants));
  expect(await textOf(page, 'sellout')).toBe(norm(e.sellOut));

  const chart = page.getByTestId('demand-chart');
  await chart.scrollIntoViewIfNeeded();
  await expect(chart.locator('.hit')).toHaveCount(9);
  await expect(chart.locator('svg')).toBeVisible();
  expect(norm(await chart.locator('.value-label').textContent())).toBe(num1(e.wants));
  expect(norm(await chart.locator('.seats-label').textContent())).toContain(int(e.seats));
  // График целиком помещается в карточку
  const fits = await chart.evaluate((el) => {
    const svg = el.querySelector('svg')!.getBoundingClientRect();
    const box = el.getBoundingClientRect();
    return svg.width <= box.width + 1 && svg.right <= document.documentElement.clientWidth + 1;
  });
  expect(fits, 'svg графика не шире контейнера').toBe(true);
  await expectNoHorizontalOverflow(page, 'график');

  await chart.locator('.hit').nth(4).click();
  await expect(chart.locator('.tooltip')).toBeVisible();
  await expectNoHorizontalOverflow(page, 'подсказка графика');

  await page.getByTestId('table-toggle').click();
  await expect(page.getByTestId('scenario-table').locator('tbody tr')).toHaveCount(9);
  await expectNoHorizontalOverflow(page, 'таблица');

  await page.getByTestId('theme-toggle').click();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  await expectNoHorizontalOverflow(page, 'тёмная тема');

  await page.getByTestId('logout').click();
  await expect(page.getByTestId('login-form')).toBeVisible();
});

test('очень узкий экран (320 px): нет горизонтальной прокрутки, график сжимается', async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 720 });
  await page.goto('/');
  await expect(page.getByTestId('login-form')).toBeVisible();
  await expectNoHorizontalOverflow(page, 'вход 320');
  await openApp(page);
  await expectNoHorizontalOverflow(page, 'результат 320');
  const chart = page.getByTestId('demand-chart');
  await expect(chart.locator('.hit')).toHaveCount(9);
  const w = await chart.evaluate((el) => [el.querySelector('svg')!.getBoundingClientRect().width, el.clientWidth]);
  expect(w[0]).toBeLessThanOrEqual(w[1]! + 1);
  await page.getByTestId('table-toggle').click();
  await expectNoHorizontalOverflow(page, 'таблица 320');
});

test('нет горизонтальной прокрутки на «/», «/board» и «/admin» (с открытой историей и сравнением)', async ({ page }) => {
  await loginAdmin(page);
  await page.goto('/?from=MOW&to=OVB&date=2026-06-01&price=12000&b=13000');
  await settled(page);
  await expect(page.getByTestId('compare-card')).toBeVisible();
  await expect(page.getByTestId('calendar-card')).toBeVisible();
  await expectNoHorizontalOverflow(page, '/ со сравнением, кривой и календарём');

  await page.getByTestId('history-open').click();
  await expect(page.getByTestId('history-drawer')).toBeVisible();
  await expectNoHorizontalOverflow(page, 'панель истории');
  await page.keyboard.press('Escape');

  await page.getByTestId('nav-board').click();
  await expect(page.getByTestId('board-table')).toBeVisible();
  await expect(page.getByTestId('route-map')).toBeVisible();
  await expectNoHorizontalOverflow(page, '/board');

  await page.getByTestId('nav-admin').click();
  await expect(page.getByTestId('admin-current')).toContainText('csv');
  await page.getByTestId('admin-file').setInputFiles({ name: 'broken.csv', mimeType: 'text/csv', buffer: Buffer.from('a,b\n1,2\n') });
  await expect(page.getByTestId('admin-invalid')).toBeVisible();
  await expectNoHorizontalOverflow(page, '/admin');
});
