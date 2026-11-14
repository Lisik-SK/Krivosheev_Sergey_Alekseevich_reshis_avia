/** Помощник выбирает значения через видимый список, сохраняя проверки исходных данных формы. */
import { expect, type Page } from '@playwright/test';

/**
 * Открывает оформленный список и выбирает вариант по значению исходного select.
 * @param page Обязательная открытая страница Playwright с готовым компонентом.
 * @param testId Обязательный непустой data-testid исходного select; кнопка имеет суффикс -trigger.
 * @param value Обязательное значение существующего доступного option, без значения по умолчанию.
 * @returns Promise<void> после выбора значения и закрытия списка; сетевой ответ не ожидает.
 * @throws Ошибка проверки, если варианта нет, либо ошибка Playwright при недоступном контроле или таймауте.
 * @remarks Читает подпись из DOM, кликает кнопку и вариант; вызванные приложением запросы не перехватывает.
 */
export async function chooseOption(page: Page, testId: string, value: string): Promise<void> {
  const source = page.getByTestId(testId);
  const label = await source.evaluate((element, selected) => {
    const option = [...(element as HTMLSelectElement).options].find((item) => item.value === selected);
    return option?.textContent?.trim() ?? null;
  }, value);
  expect(label, `вариант ${value} существует в ${testId}`).not.toBeNull();
  const trigger = page.getByTestId(`${testId}-trigger`);
  await trigger.click();
  await page.locator('.select-picker:not([hidden])').getByRole('option', { name: label!, exact: true }).click();
  await expect(source).toHaveValue(value);
  await expect(trigger).toHaveAttribute('aria-expanded', 'false');
}
