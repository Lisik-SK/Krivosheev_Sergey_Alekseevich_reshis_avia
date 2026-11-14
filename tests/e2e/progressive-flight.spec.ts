/** Проверяет порядок ввода, сужение вариантов и полный сброс формы «Рейс». */
import type { Page } from '@playwright/test';
import { chooseOption, expect, isForecast, registerViaApi, settled, test, waitForecast } from './support/fixtures';

/**
 * Открывает пустой калькулятор в новой авторизованной сессии.
 * @param page Обязательная страница Playwright без предварительно введённых параметров.
 * @returns Promise<void> после появления формы.
 * @remarks Создаёт тестовую учётную запись и загружает страницу; ошибки API и Playwright распространяются.
 */
async function openEmptyFlight(page: Page): Promise<void> {
  await registerViaApi(page);
  await page.goto('/');
  await expect(page.getByTestId('query-form')).toBeVisible();
}

/**
 * Читает коды доступных вариантов списка в стабильном порядке.
 * @param page Обязательная страница с формой «Рейс».
 * @param field Обязательное имя списка отправления или назначения.
 * @returns Promise с отсортированными кодами. Пустой список даёт пустой массив.
 * @remarks Только читает DOM, ошибки Playwright распространяются.
 */
async function enabledCodes(page: Page, field: 'from' | 'to'): Promise<string[]> {
  return page.getByTestId(field).locator('option:enabled').evaluateAll((options) =>
    options.map((option) => (option as HTMLOptionElement).value).sort());
}

test('отправление первым сужает назначения и календарь без автозаполнения', async ({ page }) => {
  const requests: string[] = [];
  page.on('response', (response) => {
    if (isForecast(response)) requests.push(response.url());
  });
  await openEmptyFlight(page);
  for (const field of ['from', 'to', 'date', 'date-display', 'price', 'price-b']) {
    await expect(page.getByTestId(field)).toHaveValue('');
  }
  await expect(page.getByTestId('sales')).toBeHidden();
  expect(await enabledCodes(page, 'from')).toEqual(['AER', 'LED', 'MOW']);
  expect(await enabledCodes(page, 'to')).toEqual(['AER', 'KGD', 'LED', 'MOW', 'MRV', 'OVB']);

  await chooseOption(page, 'from', 'AER');
  await expect(page.getByTestId('to')).toHaveValue('');
  expect(await enabledCodes(page, 'to')).toEqual(['MOW']);
  await page.getByTestId('to-trigger').click();
  const otherCity = page.getByRole('option', { name: /Калининград/ });
  await expect(otherCity).toBeVisible();
  await expect(otherCity).toBeDisabled();
  await page.keyboard.press('Escape');

  await page.getByTestId('date-trigger').click();
  const calendar = page.getByRole('dialog', { name: 'Дата вылета' });
  await expect(calendar.locator('[data-date="2026-06-02"]')).toBeDisabled();
  await calendar.locator('[data-date="2026-06-01"]').click();
  await expect(page.getByTestId('to')).toHaveValue('');
  await chooseOption(page, 'to', 'MOW');
  await expect(page.getByTestId('price')).toHaveValue('');
  await expect(page.getByTestId('sales')).toBeHidden();
  expect(requests).toEqual([]);

  const forecast = waitForecast(page);
  await page.getByTestId('price').fill('8800');
  expect((await forecast).request().postDataJSON()).toEqual({ from: 'AER', to: 'MOW', date: '2026-06-01', price: 8800 });
  await settled(page);
});

test('ручная дата переживает немедленное обновление до запуска расчёта', async ({ page }) => {
  await openEmptyFlight(page);
  const loaded = page.waitForEvent('load');
  await page.getByTestId('date-display').evaluate((input: HTMLInputElement) => {
    input.value = '24.06.2026';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    location.reload();
  });
  await loaded;
  await page.waitForURL(/\?date=2026-06-24$/);
  await expect(page.getByTestId('date')).toHaveValue('2026-06-24');
  expect(await enabledCodes(page, 'from')).toEqual(['MOW']);
  await expect(page.getByTestId('price')).toHaveValue('');
  await expect(page.getByTestId('sales')).toBeHidden();
});

test('назначение первым ограничивает отправления и сохраняется после перезагрузки', async ({ page }) => {
  await openEmptyFlight(page);
  await chooseOption(page, 'to', 'MOW');
  await expect(page.getByTestId('from')).toHaveValue('');
  expect(await enabledCodes(page, 'from')).toEqual(['AER', 'LED']);
  await expect(page.getByTestId('date')).toHaveAttribute('max', '2026-06-01');
  await expect(page).toHaveURL(/\?to=MOW$/);
  await page.reload();
  await expect(page.getByTestId('to')).toHaveValue('MOW');
  await expect(page.getByTestId('from')).toHaveValue('');
  await expect(page.getByTestId('date')).toHaveValue('');
  expect(await enabledCodes(page, 'from')).toEqual(['AER', 'LED']);
});

test('дата первой сужает оба списка, сброс очищает результат и сравнение', async ({ page }) => {
  await openEmptyFlight(page);
  await page.getByTestId('date-display').fill('24.06.2026');
  await expect(page.getByTestId('date')).toHaveValue('2026-06-24');
  expect(await enabledCodes(page, 'from')).toEqual(['MOW']);
  expect(await enabledCodes(page, 'to')).toEqual(['AER', 'KGD', 'LED', 'MRV', 'OVB']);
  await chooseOption(page, 'to', 'KGD');
  await chooseOption(page, 'from', 'MOW');
  const forecast = waitForecast(page);
  await page.getByTestId('price').fill('8000');
  expect((await forecast).request().postDataJSON()).toEqual({ from: 'MOW', to: 'KGD', date: '2026-06-24', price: 8000 });
  await settled(page);
  await page.getByText('Сравнить с другой ценой', { exact: true }).click();
  await page.getByTestId('price-b').fill('8200');
  await expect(page.getByTestId('compare-card')).toBeVisible();

  const clear = page.getByTestId('from-trigger').locator('../..').getByRole('button', { name: 'Очистить поля' });
  await clear.click();
  for (const field of ['from', 'to', 'date', 'date-display', 'price', 'price-b']) {
    await expect(page.getByTestId(field)).toHaveValue('');
  }
  await expect(page.getByTestId('compare-toggle')).not.toBeChecked();
  await expect(page.getByTestId('compare-card')).toBeHidden();
  await expect(page.getByTestId('sales')).toBeHidden();
  expect(await enabledCodes(page, 'from')).toEqual(['AER', 'LED', 'MOW']);
  expect(await enabledCodes(page, 'to')).toEqual(['AER', 'KGD', 'LED', 'MOW', 'MRV', 'OVB']);
  await expect(page).toHaveURL(/\/$/);
  await page.getByTestId('nav-board').click();
  await page.getByTestId('nav-flight').click();
  await expect(page.getByTestId('price')).toHaveValue('');
  await page.reload();
  await expect(page.getByTestId('price')).toHaveValue('');
  await expect(page.getByTestId('compare-toggle')).not.toBeChecked();
});
