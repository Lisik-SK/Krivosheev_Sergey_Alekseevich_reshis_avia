/**
 * Проверяет оформленные списки и календарь через пользовательские действия:
 * выбор, закрытие, клавиатуру, локализацию, доступность и размещение на экране.
 * Исходные скрытые поля используются только для проверки значений и вариантов.
 */
import AxeBuilder from '@axe-core/playwright';
import type { Locator, Page } from '@playwright/test';
import type { Meta } from '../../src/client/api';
import { test, expect, openApp, chooseOption, settled, waitForecast } from './support/fixtures';

/**
 * Проверяет, что открытая панель помещается в видимой области страницы.
 * @param page Обязательная страница Playwright с ненулевым viewport.
 * @param panel Обязательный locator единственной видимой панели.
 * @returns Promise<void> после стабилизации границ с допуском 1 CSS px.
 * @throws Ошибка проверки при невидимой панели, отсутствии viewport или выходе за его пределы.
 * @remarks Только читает геометрию DOM; состояние и фокус не меняет.
 */
async function expectInsideViewport(page: Page, panel: Locator): Promise<void> {
  await expect(panel).toBeVisible();
  const viewport = page.viewportSize();
  expect(viewport).not.toBeNull();
  await expect.poll(async () => {
    const box = await panel.boundingBox();
    return box !== null && box.x >= -1 && box.y >= -1
      && box.x + box.width <= viewport!.width + 1
      && box.y + box.height <= viewport!.height + 1;
  }, { message: 'панель должна помещаться в viewport после изменения размера' }).toBe(true);
}

/**
 * Выполняет axe-проверку открытой панели и возвращает ошибки доступности через expect.
 * @param page Обязательная страница Playwright после завершения рендера панели.
 * @param selector Обязательный CSS-селектор открытой панели; должен находить хотя бы один элемент.
 * @returns Promise<void>, если нет нарушений WCAG A/AA в проверяемой панели.
 * @throws Ошибка axe, Playwright или expect при нарушениях; ошибок не подавляет.
 * @remarks Читает DOM и стили через axe, не меняет данные приложения и не делает сетевых запросов.
 */
async function expectAccessiblePanel(page: Page, selector: string): Promise<void> {
  const result = await new AxeBuilder({ page }).include(selector).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa']).analyze();
  expect(result.violations.map((item) => `${item.id}: ${item.nodes.map((node) => node.target.join(' ')).join(', ')}`)).toEqual([]);
}

test('оформленные списки показывают недоступные города и позволяют выбрать доступное направление', async ({ page, isMobile }) => {
  await openApp(page);
  const fromTrigger = page.getByTestId('from-trigger');
  const trigger = page.getByTestId('to-trigger');
  const popup = page.locator('.select-picker:not([hidden])');
  await expect(fromTrigger).toHaveAccessibleName(/Откуда/);
  await expect(trigger).toHaveAccessibleName(/Куда/);
  if (isMobile) await fromTrigger.tap();
  else await fromTrigger.click();
  await expect(popup.getByRole('option', { name: /Москва/ })).toBeEnabled();
  await expect(popup.getByRole('option', { name: /Сочи/ })).toBeVisible();
  await expect(popup.getByRole('option', { name: /Сочи/ })).toBeDisabled();
  await expect(popup.getByRole('option', { name: /Санкт-Петербург/ })).toBeDisabled();
  await page.keyboard.press('Escape');

  if (isMobile) await trigger.tap();
  else await trigger.click();
  await expect(popup).toBeVisible();
  await expect(popup.getByRole('option')).toHaveCount(6);
  await expect(popup.getByRole('option', { name: /Москва/ })).toBeDisabled();
  await expect(popup.getByRole('option', { selected: true })).toContainText('Сочи');
  await expectInsideViewport(page, popup);
  await page.keyboard.press('Escape');
  const response = waitForecast(page);
  await chooseOption(page, 'to', 'OVB');
  expect((await response).request().postDataJSON()).toMatchObject({ to: 'OVB' });
  await settled(page);
  await expect(trigger).toContainText('Новосибирск');
  await expect(trigger).toBeFocused();
});

test('выбор города отправления сохраняет город назначения и дату', async ({ page }) => {
  await openApp(page, '?from=AER&to=MOW&date=2026-06-01');
  await page.getByTestId('from-trigger').press('Enter');
  const popup = page.getByRole('listbox', { name: 'Откуда' });
  const unavailable = popup.getByRole('option', { name: /Москва/ });
  await expect(unavailable).toBeVisible();
  await expect(unavailable).toBeDisabled();
  await unavailable.click({ force: true });
  await expect(page.getByTestId('from')).toHaveValue('AER');
  await page.getByTestId('from-trigger').press('Home');
  await expect(popup.getByRole('option', { name: /Сочи/ })).toBeFocused();
  await page.keyboard.press('ArrowDown');
  await expect(popup.getByRole('option', { name: /Санкт-Петербург/ })).toBeFocused();

  const response = waitForecast(page);
  await page.keyboard.press('Enter');
  expect((await response).request().postDataJSON()).toMatchObject({ from: 'LED', to: 'MOW', date: '2026-06-01' });
  await settled(page);
  await expect(page.getByTestId('from')).toHaveValue('LED');
  await expect(page.getByTestId('to')).toHaveValue('MOW');
  await expect(page.getByTestId('date')).toHaveValue('2026-06-01');
});

test('варианты города назначения обновляют доступность при смене даты', async ({ page }) => {
  await page.route('**/api/meta', async (request) => {
    const response = await request.fetch();
    const meta = await response.json() as Meta;
    const route = meta.routes.find((route) => route.code === 'MOW-LED')!;
    route.dates = route.dates.slice(0, 1);
    route.seats = route.seats.slice(0, 1);
    await request.fulfill({ response, json: meta });
  });
  await openApp(page, '?from=MOW&to=AER&date=2026-06-02');

  const trigger = page.getByTestId('to-trigger');
  const popup = page.getByRole('listbox', { name: 'Куда' });
  const destination = popup.getByRole('option', { name: /Санкт-Петербург/ });
  await trigger.press('Enter');
  await expect(destination).toBeVisible();
  await expect(destination).toBeDisabled();
  await destination.click({ force: true });
  await expect(page.getByTestId('to')).toHaveValue('AER');
  await expect(page.getByTestId('date')).toHaveValue('2026-06-02');
  await trigger.press('Home');
  await page.keyboard.press('ArrowDown');
  await expect(popup.getByRole('option', { name: /Калининград/ })).toBeFocused();
  await page.keyboard.press('Escape');

  const response = waitForecast(page);
  await page.getByRole('button', { name: 'Предыдущий день' }).click();
  expect((await response).request().postDataJSON()).toMatchObject({ date: '2026-06-01' });
  await trigger.press('Enter');
  await expect(destination).toBeEnabled();
});

test('список поддерживает стрелки, Home/End, поиск по коду и Enter', async ({ page }) => {
  await openApp(page);
  const trigger = page.getByTestId('to-trigger');
  const popup = page.locator('.select-picker:not([hidden])');
  const values = await page.getByTestId('to').locator('option:not(:disabled)').evaluateAll((items) => items.map((item) => (item as HTMLOptionElement).value));
  const options = popup.getByRole('option').filter({ visible: true }).and(popup.locator('button:enabled'));
  await trigger.focus();
  await page.keyboard.press('ArrowDown');
  await expect(popup).toBeVisible();
  await page.keyboard.press('End');
  await expect(options.last()).toBeFocused();
  let response = waitForecast(page);
  await page.keyboard.press('Enter');
  await response;
  await expect(page.getByTestId('to')).toHaveValue(values[values.length - 1]!);
  await trigger.press('Enter');
  await page.keyboard.press('Home');
  await expect(options.first()).toBeFocused();
  response = waitForecast(page);
  await page.keyboard.press('Enter');
  await response;
  await trigger.press('Enter');
  await page.keyboard.press('ArrowDown');
  await expect(options.nth(1)).toBeFocused();
  await page.keyboard.type('OVB');
  await expect(popup.getByRole('option', { name: /Новосибирск/ })).toBeFocused();
  response = waitForecast(page);
  await page.keyboard.press('Enter');
  await response;
  await expect(page.getByTestId('to')).toHaveValue('OVB');
});

test('Escape, Tab и клик вне списка закрывают панель без изменения значения', async ({ page }) => {
  await openApp(page);
  const trigger = page.getByTestId('to-trigger');
  const popup = page.locator('.select-picker:not([hidden])');
  await trigger.click();
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('Escape');
  await expect(popup).toBeHidden();
  await expect(trigger).toBeFocused();
  await expect(page.getByTestId('to')).toHaveValue('AER');
  await trigger.click();
  await page.keyboard.press('Tab');
  await expect(popup).toBeHidden();
  expect(await page.evaluate(() => document.activeElement === document.body)).toBe(false);
  await trigger.click();
  await page.getByRole('heading', { level: 1 }).click();
  await expect(popup).toBeHidden();
  await expect(page.getByTestId('to')).toHaveValue('AER');
});

test('Shift+клик не добавляет рамку списку, клавиатурный фокус остаётся видимым', async ({ page }) => {
  await openApp(page);
  const trigger = page.getByTestId('to-trigger');
  await page.keyboard.press('Tab');
  await trigger.click({ modifiers: ['Shift'] });
  await expect(trigger).toHaveCSS('outline-style', 'none');
  await expect(trigger).toHaveCSS('box-shadow', 'none');
  await page.locator('.select-picker:not([hidden])').getByRole('option', { selected: true }).click({ modifiers: ['Shift'] });
  await expect(trigger).toBeFocused();
  await expect(trigger).toHaveCSS('outline-style', 'none');
  await expect(trigger).toHaveCSS('box-shadow', 'none');
  await page.keyboard.press('Tab');
  await page.keyboard.press('Shift+Tab');
  await expect(trigger).toBeFocused();
  await expect(trigger).not.toHaveCSS('box-shadow', 'none');
});

test('календарь переключает месяц и разрешает только даты прогноза', async ({ page, isMobile }) => {
  await openApp(page);
  const display = page.getByTestId('date-display');
  const trigger = page.getByTestId('date-trigger');
  const fieldBox = (await display.boundingBox())!;
  const triggerBox = (await trigger.boundingBox())!;
  expect(triggerBox.y).toBeGreaterThan(fieldBox.y);
  expect(triggerBox.y + triggerBox.height).toBeLessThan(fieldBox.y + fieldBox.height);
  expect(triggerBox.x).toBeGreaterThan(fieldBox.x);
  expect(triggerBox.x + triggerBox.width).toBeLessThan(fieldBox.x + fieldBox.width);
  if (isMobile) await trigger.tap();
  else await trigger.click();
  const popup = page.locator('.date-picker');
  await expect(popup).toBeVisible();
  await expectInsideViewport(page, popup);
  await expect(page.getByTestId('date-prev-month')).toBeDisabled();
  await page.getByTestId('date-next-month').click();
  await expect(popup.locator('[data-date="2026-07-01"]')).toBeEnabled();
  await expect(popup.locator('[data-date="2026-07-02"]')).toBeDisabled();
  await expect(page.getByTestId('date-next-month')).toBeDisabled();
  await expectInsideViewport(page, popup);
  await page.getByTestId('date-prev-month').click();
  await expect(popup.locator('[data-date="2026-06-01"]')).toBeEnabled();
  await expectInsideViewport(page, popup);
  await page.getByTestId('date-next-month').click();
  await expectInsideViewport(page, popup);
  const response = waitForecast(page);
  await popup.locator('[data-date="2026-07-01"]').click();
  expect((await response).request().postDataJSON()).toMatchObject({ date: '2026-07-01' });
  await expect(page.getByTestId('date')).toHaveValue('2026-07-01');
  await expect(page.getByTestId('date-display')).toHaveValue('01.07.2026');
  await expect(popup).toBeHidden();
});

test('календарь доступен клавиатурой и закрывается по Escape, Tab и клику снаружи', async ({ page }) => {
  await openApp(page);
  const trigger = page.getByTestId('date-trigger');
  const popup = page.locator('.date-picker');
  await trigger.focus();
  await page.keyboard.press('Enter');
  await expect(popup.locator('[data-date="2026-06-01"]')).toBeFocused();
  await page.keyboard.press('ArrowRight');
  await expect(popup.locator('[data-date="2026-06-02"]')).toBeFocused();
  const response = waitForecast(page);
  await page.keyboard.press('Enter');
  await response;
  await expect(page.getByTestId('date')).toHaveValue('2026-06-02');
  await trigger.click();
  await page.keyboard.press('Escape');
  await expect(popup).toBeHidden();
  await expect(trigger).toBeFocused();
  await trigger.click();
  await page.keyboard.press('Tab');
  await expect(popup).toBeHidden();
  expect(await page.evaluate(() => document.activeElement === document.body)).toBe(false);
  await trigger.click();
  await page.getByRole('heading', { level: 1 }).click();
  await expect(popup).toBeHidden();
});

test('ручной ввод даты проверяется и сохраняет ISO-значение при смене языка', async ({ page }) => {
  await openApp(page);
  const display = page.getByTestId('date-display');
  await display.fill('31.02.2026');
  await expect(display).toHaveAttribute('aria-invalid', 'true');
  await expect(page.locator('#err-date')).not.toBeEmpty();
  let response = waitForecast(page);
  await display.fill('2026-06-17');
  await response;
  await expect(page.getByTestId('date')).toHaveValue('2026-06-17');
  await expect(display).not.toHaveAttribute('aria-invalid', 'true');
  response = waitForecast(page);
  await page.getByTestId('lang-toggle').click();
  await response;
  await expect(page.getByTestId('date-display')).toHaveValue('17/06/2026');
  await expect(page.getByTestId('to-trigger')).toContainText('Sochi');
  await expect(page.getByTestId('date')).toHaveValue('2026-06-17');
});

test('цифровой ввод даты без разделителей нормализуется после потери фокуса', async ({ page }) => {
  await openApp(page);
  const display = page.getByTestId('date-display');
  await expect(display).toHaveAttribute('inputmode', 'numeric');
  const response = waitForecast(page);
  await display.fill('17062026');
  expect((await response).request().postDataJSON()).toMatchObject({ date: '2026-06-17' });
  await expect(page.getByTestId('date')).toHaveValue('2026-06-17');
  await expect(display).toHaveValue('17062026');
  await page.getByRole('heading', { level: 1 }).click();
  await expect(display).toHaveValue('17.06.2026');
  await expect(display).not.toHaveAttribute('aria-invalid', 'true');
});

test('открытые панели удаляются при переходе на другой экран и смене языка', async ({ page }) => {
  await openApp(page);
  await page.getByTestId('date-trigger').click();
  await expect(page.locator('.date-picker')).toBeVisible();
  let boardResponse = page.waitForResponse((response) => response.url().endsWith('/api/forecast/board') && response.request().method() === 'POST');
  await page.getByTestId('nav-board').click();
  await boardResponse;
  await expect(page.getByTestId('board-table')).toBeVisible();
  await expect(page.locator('#q-date-calendar')).toHaveCount(0);
  await expect(page.locator('#q-to-listbox')).toHaveCount(0);
  await expect(page.locator('.picker-popup:not([hidden])')).toHaveCount(0);
  await page.getByTestId('board-date-trigger').click();
  await expect(page.getByRole('dialog', { name: 'Дата вылета' })).toBeVisible();
  boardResponse = page.waitForResponse((response) => response.url().endsWith('/api/forecast/board') && response.request().method() === 'POST');
  await page.getByTestId('lang-toggle').click();
  await boardResponse;
  await expect(page.locator('html')).toHaveAttribute('lang', 'en');
  await expect(page.locator('.picker-popup:not([hidden])')).toHaveCount(0);
  await expect(page.locator('.date-picker')).toHaveCount(1);
  await expect(page.getByTestId('board-date-display')).toHaveValue('01/06/2026');
  await expect(page.getByTestId('board-date-trigger')).toHaveAttribute('aria-expanded', 'false');
  await page.getByTestId('board-date-trigger').click();
  await expect(page.getByRole('dialog', { name: 'Departure date' })).toContainText('June');
});

for (const theme of ['light', 'dark'] as const) {
  test(`панели в теме ${theme}: доступность и размещение без переполнения`, async ({ page }) => {
    await page.addInitScript((value) => localStorage.setItem('ra-theme', value), theme);
    await openApp(page);
    await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
    await page.getByTestId('to-trigger').click();
    await expectInsideViewport(page, page.locator('.select-picker:not([hidden])'));
    await expectAccessiblePanel(page, '.select-picker:not([hidden])');
    await page.keyboard.press('Escape');
    await page.getByTestId('date-trigger').click();
    await expectInsideViewport(page, page.locator('.date-picker'));
    await expectAccessiblePanel(page, '.date-picker');
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true);
  });
}
