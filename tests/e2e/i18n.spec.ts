import { test, expect, openApp, calculate, newUser, registerViaApi, settled, waitForecast } from './support/fixtures';

test.describe('Английский интерфейс', () => {
  test('переключатель RU/EN переводит интерфейс и сохраняется после перезагрузки', async ({ page }) => {
    await openApp(page);
    await expect(page.locator('html')).toHaveAttribute('lang', 'ru');
    await expect(page.getByTestId('price')).toHaveAccessibleName('Цена билета, ₽');

    const res = waitForecast(page);
    await page.getByTestId('lang-toggle').click();
    await res;
    await settled(page);
    await expect(page.locator('html')).toHaveAttribute('lang', 'en');
    await expect(page.getByTestId('price')).toHaveAccessibleName('Ticket price, ₽');
    await expect(page.getByText('Sales forecast', { exact: true })).toBeVisible();
    await expect(page.getByTestId('to').locator('option[value="AER"]')).toContainText('Sochi');
    await expect(page.getByTestId('nav-board')).toHaveText('Board');
    expect(await page.evaluate(() => localStorage.getItem('ra-lang'))).toBe('en');

    // Числа в английском формате: точка как десятичный разделитель
    await calculate(page, { price: 9500 });
    await expect(page.getByTestId('wants')).toHaveText('704.5');

    await page.reload();
    await settled(page);
    await expect(page.getByTestId('price')).toHaveAccessibleName('Ticket price, ₽');
    await expect(page.locator('html')).toHaveAttribute('lang', 'en');

    // Обратно на русский
    const back = waitForecast(page);
    await page.getByTestId('lang-toggle').click();
    await back;
    await expect(page.getByTestId('price')).toHaveAccessibleName('Цена билета, ₽');
  });

  test('ошибки сервера приходят на английском', async ({ page, problems }) => {
    problems.allow(/status of (401|409)/);
    await page.addInitScript(() => localStorage.setItem('ra-lang', 'en'));
    const u = await registerViaApi(page, newUser());
    await page.context().clearCookies();
    await page.goto('/');
    const login = page.getByTestId('login-form');
    await expect(login.getByRole('button', { name: 'Sign in' })).toBeVisible();

    await login.locator('input[name=email]').fill(u.email);
    await login.locator('input[name=password]').fill('Wrong-pass-1');
    await login.getByRole('button', { name: 'Sign in' }).click();
    await expect(login.getByRole('alert').filter({ hasText: 'Wrong email or password' })).toBeVisible();

    // Повторная регистрация — серверная ошибка поля email
    await page.getByRole('tab', { name: 'Sign up' }).click();
    const reg = page.getByTestId('register-form');
    await reg.locator('input[name=name]').fill('Someone');
    await reg.locator('input[name=email]').fill(u.email);
    await reg.locator('input[name=password]').fill(u.password);
    await reg.locator('button[type=submit]').click();
    await expect(reg.getByText('A user with this email already exists')).toBeVisible();

    // API отвечает на языке из X-Lang
    const r = await page.request.post('/api/forecast', { headers: { 'X-Lang': 'en' }, data: { from: 'MOW', to: 'AER', date: '2026-06-01', price: 1 } });
    expect(r.status()).toBe(401);
    expect(((await r.json()) as { error: string }).error).toMatch(/Sign in/);
  });

  test('серверная ошибка валидации прогноза на английском (дата вне прогноза)', async ({ page }) => {
    await registerViaApi(page);
    const r = await page.request.post('/api/forecast', { headers: { 'X-Lang': 'en' }, data: { from: 'MOW', to: 'AER', date: '2027-01-01', price: 9000 } });
    expect(r.status()).toBeGreaterThanOrEqual(400);
    const body = (await r.json()) as { error: string; fields?: Record<string, string> };
    const text = `${body.error} ${Object.values(body.fields ?? {}).join(' ')}`;
    expect(text).not.toMatch(/[А-Яа-яЁё]/);
    const ru = await page.request.post('/api/forecast', { headers: { 'X-Lang': 'ru' }, data: { from: 'MOW', to: 'AER', date: '2027-01-01', price: 9000 } });
    expect(JSON.stringify(await ru.json())).toMatch(/[А-Яа-яЁё]/);
  });
});
