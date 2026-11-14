import { test, expect, newUser, calculate, settled } from './support/fixtures';

test.describe('Заголовки безопасности и CSP', () => {
  test('ответ "/" содержит строгий Content-Security-Policy и защитные заголовки', async ({ page }) => {
    const res = await page.goto('/');
    expect(res?.status()).toBe(200);
    const h = res!.headers();
    const csp = h['content-security-policy'];
    expect(csp, 'Content-Security-Policy').toBeTruthy();
    expect(csp).toContain("default-src 'self'");
    expect(csp).toContain("script-src 'self'");
    expect(csp).toContain("object-src 'none'");
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).not.toContain('unsafe-inline');
    expect(csp).not.toContain('unsafe-eval');
    expect(h['x-content-type-options']).toBe('nosniff');
    expect(h['referrer-policy']).toBe('same-origin');
    expect(h['x-powered-by']).toBeUndefined();
  });

  test('cookie сессии HttpOnly и SameSite', async ({ page }) => {
    const u = newUser();
    await page.goto('/');
    await page.getByRole('tab', { name: 'Регистрация' }).click();
    const form = page.getByTestId('register-form');
    await form.getByLabel('Имя', { exact: true }).fill(u.name);
    await form.getByLabel('Рабочий email', { exact: true }).fill(u.email);
    await form.getByLabel('Пароль', { exact: true }).fill(u.password);
    const signup = page.waitForResponse((response) => response.url().endsWith('/api/auth/register'));
    await form.getByRole('button', { name: 'Создать аккаунт' }).click();
    await expect(page.getByTestId('user-chip')).toBeAttached(); // на телефоне чип скрыт стилями
    const sessionHeader = await (await signup).headerValue('set-cookie');
    expect(sessionHeader).toMatch(/^ra_session=.*; HttpOnly(?:;|$)/i);
    expect(sessionHeader).toMatch(/; SameSite=(?:Lax|Strict)(?:;|$)/i);
    const cookie = (await page.context().cookies()).find((entry) => entry.name === 'ra_session');
    expect(cookie?.httpOnly).toBe(true);
    expect(await page.evaluate(() => document.cookie)).not.toContain('ra_session=');
  });

  test('полный сценарий без нарушений CSP и ошибок консоли', async ({ page, problems }) => {
    const u = newUser();
    await page.goto('/?from=MOW&to=AER&date=2026-06-01&price=9000');
    await page.getByTestId('theme-toggle').click();
    await page.getByRole('tab', { name: 'Регистрация' }).click();
    const form = page.getByTestId('register-form');
    await form.getByLabel('Имя', { exact: true }).fill(u.name);
    await form.getByLabel('Рабочий email', { exact: true }).fill(u.email);
    await form.getByLabel('Пароль', { exact: true }).fill(u.password);
    await form.getByRole('button', { name: 'Показать пароль' }).click();
    await form.getByRole('button', { name: 'Создать аккаунт' }).click();
    await settled(page);

    await calculate(page, { to: 'LED', date: '2026-06-07', price: 4000 });
    await page.getByTestId('demand-chart').locator('.hit').nth(6).hover();
    await expect(page.getByTestId('demand-chart').locator('.tooltip')).toBeVisible();
    await page.getByTestId('table-toggle').click();
    await expect(page.getByTestId('scenario-table')).toBeVisible();
    await page.getByTestId('theme-toggle').click();
    await page.getByRole('button', { name: 'График' }).click();
    await page.getByTestId('apply-best-price').click();
    await settled(page);
    await page.reload();
    await settled(page);
    await page.getByTestId('logout').click();
    await expect(page.getByTestId('login-form')).toBeVisible();

    // Шрифты, стили и скрипты — только со своего origin
    const external = await page.evaluate(() =>
      performance
        .getEntriesByType('resource')
        .map((e) => e.name)
        .filter((n) => !n.startsWith(location.origin)),
    );
    expect(external).toEqual([]);
    expect(await page.evaluate(() => window.__cspViolations)).toEqual([]);
    expect(problems.list).toEqual([]);
  });
});
