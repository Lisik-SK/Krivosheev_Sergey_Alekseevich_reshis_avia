/** Проверяет рамки фокуса при смене мыши, касаний и клавиатуры на настоящих контролах. */
import { test, expect, openApp } from './support/fixtures';

test('кнопки: клик и Shift+клик без рамки, Tab и Shift+Tab с рамкой', async ({ page, isMobile }) => {
  await openApp(page);
  const table = page.getByTestId('table-toggle');
  const chartButton = page.locator('.seg__btn').first();
  const theme = page.getByTestId('theme-toggle');

  for (const button of [table, chartButton, theme]) {
    await page.keyboard.press('Tab');
    await button.click({ modifiers: ['Shift'] });
    await expect(button).toHaveCSS('outline-style', 'none');
    await button.click();
    await expect(button).toHaveCSS('outline-style', 'none');
    if (isMobile) {
      await button.tap();
      await expect(button).toHaveCSS('outline-style', 'none');
    }
  }

  await chartButton.focus();
  await page.keyboard.press('Tab');
  await expect(table).toBeFocused();
  await expect(table).toHaveCSS('outline-style', 'solid');
  await page.keyboard.press('Shift+Tab');
  await expect(chartButton).toBeFocused();
  await expect(chartButton).toHaveCSS('outline-style', 'solid');
  await page.keyboard.press('Tab');
  await page.keyboard.press('Enter');
  await expect(page.getByTestId('scenario-table')).toBeVisible();
  await expect(table).toHaveCSS('outline-style', 'solid');
});

test('сценарии: клик без рамки, стрелки возвращают рамку и сохраняют подсказку', async ({ page, isMobile }) => {
  await openApp(page);
  const chart = page.getByTestId('demand-chart');
  const hits = chart.locator('.hit');
  const rings = chart.locator('.hit-ring');
  await expect(hits).toHaveCount(9);

  for (const index of [0, 4, 8]) {
    await hits.nth(index).click();
    await expect(rings.nth(index)).toHaveCSS('stroke', 'none');
    await hits.nth(index).click({ modifiers: ['Shift'] });
    await expect(rings.nth(index)).toHaveCSS('stroke', 'none');
    await expect(hits.nth(index)).toHaveCSS('outline-style', 'none');
  }

  if (isMobile) {
    await hits.first().tap();
    await expect(rings.first()).toHaveCSS('stroke', 'none');
  }
  await hits.first().focus();
  await page.keyboard.press('ArrowRight');
  await expect(hits.nth(1)).toBeFocused();
  await expect(rings.nth(1)).not.toHaveCSS('stroke', 'none');
  await expect(chart.locator('.tooltip')).toBeVisible();
  await page.keyboard.press('ArrowLeft');
  await expect(hits.first()).toBeFocused();
  await expect(rings.first()).not.toHaveCSS('stroke', 'none');
  await hits.first().click({ modifiers: ['Shift'] });
  await expect(rings.first()).toHaveCSS('stroke', 'none');
});
