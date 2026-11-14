/** Проверяет геометрию шапки и кнопок выбора даты в разных браузерах. */
import type { Locator } from '@playwright/test';
import { expect, loginAdmin, openApp, test } from './support/fixtures';

/**
 * Проверяет центрирование SVG в кнопках по обеим осям.
 * @param buttons Обязательный локатор заданного числа видимых кнопок с одним SVG в каждой.
 * @param count Ожидаемое положительное целое число кнопок.
 * @returns Promise<void>. Читает геометрию DOM без изменения страницы.
 * @throws Ошибка проверки при неверном числе кнопок, отсутствии SVG или смещении больше 0,25 CSS px.
 */
async function expectCenteredIcons(buttons: Locator, count: number): Promise<void> {
  await expect(buttons).toHaveCount(count);
  for (const button of await buttons.all()) {
    await expect(button).toBeVisible();
    const box = (await button.boundingBox())!;
    const icon = await button.locator('svg').boundingBox();
    expect(icon).not.toBeNull();
    expect(Math.abs(icon!.x + icon!.width / 2 - box.x - box.width / 2)).toBeLessThanOrEqual(0.25);
    expect(Math.abs(icon!.y + icon!.height / 2 - box.y - box.height / 2)).toBeLessThanOrEqual(0.25);
  }
}

test('на узком экране все действия шапки помещаются в строку с логотипом', async ({ page }) => {
  await loginAdmin(page);
  await page.goto('/');
  await expect(page.getByTestId('nav-admin')).toBeVisible();
  const topbar = page.locator('.topbar');
  const controls = topbar.locator('.brand, button, .user-chip').filter({ visible: true });

  for (const brandName of ['Решись Авиа', 'Reshis Avia']) {
    await expect(topbar.getByRole('link', { name: brandName })).toBeVisible();
    // Проверяем, что даже длинное имя администратора не вытесняет кнопку выхода.
    await topbar.locator('.user-chip__name').evaluate(element => {
      element.prepend('Александра Константиновна Смирнова ');
    });
    await page.evaluate(() => document.fonts.ready.then(() => undefined));
    for (const width of [320, 375, 390, 640, 641, 700, 860, 861, 1360]) {
      await page.setViewportSize({ width, height: 800 });
      await expect(controls).toHaveCount(width <= 640 ? 5 : 6);
      const boxes = await controls.evaluateAll(elements => elements.map(element => {
        const { left, right, top, bottom } = element.getBoundingClientRect();
        return { left, right, top, bottom };
      }));
      const brand = boxes[0]!;
      const actions = boxes.slice(1);
      for (const [index, action] of actions.entries()) {
        expect(action.top + action.bottom, `${brandName}, ${width} px`).toBeCloseTo(brand.top + brand.bottom, 0);
        expect(action.left).toBeGreaterThanOrEqual(boxes[index]!.right);
        expect(action.right).toBeLessThanOrEqual(width);
      }
      const navigation = (await topbar.getByRole('navigation').boundingBox())!;
      if (width <= 860) {
        expect(navigation.y).toBeGreaterThanOrEqual(Math.max(...boxes.map(box => box.bottom)));
      } else {
        expect(navigation.y + navigation.height / 2).toBeCloseTo((brand.top + brand.bottom) / 2, 0);
      }
    }
    if (brandName === 'Решись Авиа') await page.getByTestId('lang-toggle').click();
  }
});

test('иконки выбора дня, открытия календаря и переключения месяца центрированы', async ({ page }) => {
  await openApp(page);
  await expectCenteredIcons(page.locator('.query__date > .icon-btn, .query__date .date-field__trigger'), 3);
  await page.getByTestId('date-trigger').click();
  await expectCenteredIcons(page.locator('.date-picker__head .icon-btn'), 2);
});
