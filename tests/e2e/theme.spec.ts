import { test, expect, openApp, registerViaApi, settled } from './support/fixtures';

const html = (page: import('@playwright/test').Page) => page.locator('html');

test.describe('Тема оформления', () => {
  test('переключатель меняет data-theme и сохраняется после перезагрузки', async ({ page }) => {
    await openApp(page);
    const toggle = page.getByTestId('theme-toggle');
    await expect(toggle).toHaveRole('switch');
    await expect(html(page)).toHaveAttribute('data-theme', 'light');
    await expect(toggle).toHaveAttribute('aria-checked', 'false');

    await toggle.click();
    await expect(html(page)).toHaveAttribute('data-theme', 'dark');
    await expect(toggle).toHaveAttribute('aria-checked', 'true');
    expect(await page.evaluate(() => localStorage.getItem('ra-theme'))).toBe('dark');
    // График перерисован и виден в тёмной теме
    await expect(page.getByTestId('demand-chart').locator('.hit')).toHaveCount(9);

    // Фон действительно поменялся
    const darkBg = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);

    await page.reload();
    await expect(html(page)).toHaveAttribute('data-theme', 'dark');
    await settled(page);
    await expect(page.getByTestId('theme-toggle')).toHaveAttribute('aria-checked', 'true');

    await page.getByTestId('theme-toggle').click();
    await expect(html(page)).toHaveAttribute('data-theme', 'light');
    expect(await page.evaluate(() => localStorage.getItem('ra-theme'))).toBe('light');
    const lightBg = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
    expect(lightBg).not.toBe(darkBg);

    await page.reload();
    await expect(html(page)).toHaveAttribute('data-theme', 'light');
  });

  test('тема работает и на странице входа, переносится в приложение', async ({ page }) => {
    await page.goto('/');
    await expect(page.getByTestId('login-form')).toBeVisible();
    const logo = page.locator('.brand__mark');
    const favicon = page.locator('link[rel="icon"]');
    await expect(logo).toHaveCSS('background-image', /\/favicon\.svg/);
    await expect(favicon).toHaveAttribute('href', /\/favicon\.svg/);
    await page.getByTestId('theme-toggle').click();
    await expect(html(page)).toHaveAttribute('data-theme', 'dark');
    await expect(logo).toHaveCSS('background-image', /\/favicon-dark\.svg/);
    await expect(favicon).toHaveAttribute('href', '/favicon-dark.svg');
    await page.reload();
    await expect(html(page)).toHaveAttribute('data-theme', 'dark');
    await expect(page.getByTestId('login-form')).toBeVisible();
    await expect(page.getByTestId('theme-toggle')).toHaveAttribute('aria-checked', 'true');
    await expect(favicon).toHaveAttribute('href', '/favicon-dark.svg');

    await registerViaApi(page);
    await page.reload();
    await expect(page.getByTestId('query-form')).toBeVisible();
    await expect(html(page)).toHaveAttribute('data-theme', 'dark');
    await expect(page.getByTestId('theme-toggle')).toHaveAttribute('aria-checked', 'true');
    await expect(logo).toHaveCSS('background-image', /\/favicon-dark\.svg/);
    await page.getByTestId('theme-toggle').click();
    await expect(logo).toHaveCSS('background-image', /\/favicon\.svg/);
    await expect(favicon).toHaveAttribute('href', /\/favicon\.svg/);
  });

  test('без сохранённого выбора следует системной теме; явный выбор важнее системы', async ({ page }) => {
    await page.emulateMedia({ colorScheme: 'dark' });
    await page.goto('/');
    await expect(html(page)).toHaveAttribute('data-theme', 'dark');
    await page.emulateMedia({ colorScheme: 'light' });
    await expect(html(page)).toHaveAttribute('data-theme', 'light');

    await page.emulateMedia({ colorScheme: 'dark' });
    await expect(html(page)).toHaveAttribute('data-theme', 'dark');
    await page.getByTestId('theme-toggle').click(); // явно выбрали светлую при тёмной системной
    await expect(html(page)).toHaveAttribute('data-theme', 'light');
    await page.emulateMedia({ colorScheme: 'light' });
    await page.emulateMedia({ colorScheme: 'dark' });
    await expect(html(page)).toHaveAttribute('data-theme', 'light');
    await page.reload();
    await expect(html(page)).toHaveAttribute('data-theme', 'light');
    await expect(page.getByTestId('theme-toggle')).toHaveAttribute('aria-checked', 'false');
  });
});
