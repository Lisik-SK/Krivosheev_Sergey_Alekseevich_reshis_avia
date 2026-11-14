import type { Page } from '@playwright/test';
import { test, expect, loginAdmin, newUser, openApp, registerViaApi, settled, type TestUser } from './support/fixtures';

async function openRegister(page: Page) {
  await page.goto('/');
  await page.getByRole('tab', { name: 'Регистрация' }).click();
  await expect(page.getByTestId('register-form')).toBeVisible();
}

async function fillRegister(page: Page, u: Partial<TestUser>) {
  const form = page.getByTestId('register-form');
  await form.getByLabel('Имя', { exact: true }).fill(u.name ?? '');
  await form.getByLabel('Рабочий email', { exact: true }).fill(u.email ?? '');
  await form.getByLabel('Пароль', { exact: true }).fill(u.password ?? '');
  await form.getByRole('button', { name: 'Создать аккаунт' }).click();
}

async function login(page: Page, email: string, password: string) {
  const form = page.getByTestId('login-form');
  await form.getByLabel('Email', { exact: true }).fill(email);
  await form.getByLabel('Пароль', { exact: true }).fill(password);
  await form.getByRole('button', { name: 'Войти' }).click();
}

async function me(page: Page) {
  const res = await page.request.get('/api/auth/me');
  expect(res.ok()).toBe(true);
  return (await res.json()) as { user: { email: string; name: string } | null };
}

test.describe('Авторизация', () => {
  test('без сессии показывается форма входа', async ({ page }) => {
    await page.goto('/');
    await expect(page.getByTestId('login-form')).toBeVisible();
    await expect(page).toHaveTitle(/Вход/);
    await expect(page.getByRole('tab', { name: 'Вход' })).toHaveAttribute('aria-selected', 'true');
    await expect(page.getByTestId('results')).toHaveCount(0);
    expect((await me(page)).user).toBeNull();
  });

  test('регистрация нового пользователя открывает приложение с его именем', async ({ page }) => {
    const u = newUser();
    await openRegister(page);
    await fillRegister(page, u);
    await expect(page.getByTestId('user-chip')).toContainText(u.name);
    await expect(page.getByTestId('query-form')).toBeVisible();
    for (const field of ['from', 'to', 'date', 'price']) {
      await expect(page.getByTestId(field)).toHaveValue('');
    }
    await expect(page.getByTestId('sales')).toBeHidden();
    await expect(page).toHaveTitle(/Рейс · Решись Авиа/);
    expect((await me(page)).user?.email).toBe(u.email);
  });

  test('клиентская валидация формы регистрации', async ({ page }) => {
    let requests = 0;
    page.on('request', (r) => {
      if (r.url().includes('/api/auth/register')) requests++;
    });
    await openRegister(page);
    const form = page.getByTestId('register-form');

    // Пустая форма
    await fillRegister(page, {});
    await expect(form.getByText('Укажите имя')).toBeVisible();
    await expect(form.getByText('Похоже, в адресе ошибка')).toBeVisible();
    await expect(form.getByText('Пароль — не короче 8 символов')).toBeVisible();
    await expect(form.getByLabel('Имя', { exact: true })).toHaveAttribute('aria-invalid', 'true');
    await expect(form.getByLabel('Имя', { exact: true })).toBeFocused();

    // Некорректный email
    await fillRegister(page, { name: 'Анна', email: 'anna@example', password: 'abcdefg1' });
    await expect(form.getByText('Похоже, в адресе ошибка')).toBeVisible();
    await expect(form.getByText('Укажите имя')).toHaveCount(0);
    await expect(form.getByLabel('Рабочий email', { exact: true })).toHaveAttribute('aria-invalid', 'true');

    // Короткий пароль
    await fillRegister(page, { name: 'Анна', email: 'anna@example.com', password: 'abc1' });
    await expect(form.getByText('Пароль — не короче 8 символов')).toBeVisible();
    await expect(form.getByText('Похоже, в адресе ошибка')).toHaveCount(0);

    // Пароль без цифры
    await fillRegister(page, { name: 'Анна', email: 'anna@example.com', password: 'abcdefghij' });
    await expect(form.getByText('Нужны хотя бы одна буква и одна цифра')).toBeVisible();
    await expect(form.getByLabel('Пароль', { exact: true })).toBeFocused();

    expect(requests, 'невалидная форма не должна уходить на сервер').toBe(0);
  });

  test('повторная регистрация с тем же email — ошибка у поля email', async ({ page, problems }) => {
    problems.allow(/status of 409/);
    const u = newUser();
    await registerViaApi(page, u);
    await page.context().clearCookies();
    await openRegister(page);
    await fillRegister(page, { ...u, name: 'Другой', email: u.email.toUpperCase() });
    const form = page.getByTestId('register-form');
    await expect(form.getByText('Пользователь с таким email уже зарегистрирован')).toBeVisible();
    await expect(form.getByLabel('Рабочий email', { exact: true })).toHaveAttribute('aria-invalid', 'true');
    await expect(page.getByTestId('user-chip')).toHaveCount(0);
  });

  test('выход возвращает на форму входа и закрывает сессию', async ({ page }) => {
    const u = await registerViaApi(page);
    await page.goto('/');
    await expect(page.getByTestId('user-chip')).toContainText(u.name);
    await page.getByTestId('logout').click();
    await expect(page.getByTestId('login-form')).toBeVisible();
    await expect(page.getByTestId('user-chip')).toHaveCount(0);
    expect((await me(page)).user).toBeNull();
    // Защищённое API тоже недоступно
    const meta = await page.request.get('/api/meta');
    expect(meta.status()).toBe(401);
  });

  for (const screen of ['Рейс', 'Табло'] as const) {
    test(`выход с экрана «${screen}» сбрасывает параметры обоих экранов`, async ({ page }) => {
      const user = await openApp(page, '?from=MOW&to=KGD&date=2026-06-12&price=8100&b=8900');
      await page.getByTestId('nav-board').click();
      await expect(page.getByTestId('board-table')).toBeVisible();
      await page.getByTestId('board-date-display').fill('2026-06-19');
      await page.getByTestId('mode-model').click();
      await expect(page).toHaveURL(/date=2026-06-19&mode=model$/);

      if (screen === 'Рейс') {
        await page.getByTestId('nav-flight').click();
        await settled(page);
        await expect(page.getByTestId('price-b')).toHaveValue('8900');
      }

      await page.getByTestId('logout').click();
      await expect(page.getByTestId('login-form')).toBeVisible();
      await expect(page).toHaveURL(/\/$/);
      expect(await page.evaluate(() => history.state)).toBeNull();

      expect(await page.evaluate(() => [
        sessionStorage.getItem('ra-flight-screen-v1'), sessionStorage.getItem('ra-board-screen-v1'),
      ])).toEqual([null, null]);
      if (screen === 'Табло') await page.reload();
      await login(page, user.email, user.password);
      await expect(page.getByTestId('query-form')).toBeVisible();
      await expect(page.getByTestId('nav-flight')).toHaveAttribute('aria-current', 'page');
      for (const field of ['from', 'to', 'date', 'price', 'price-b']) {
        await expect(page.getByTestId(field)).toHaveValue('');
      }
      await expect(page.getByTestId('compare-toggle')).not.toBeChecked();
      await expect(page.getByTestId('sales')).toBeHidden();

      await page.getByTestId('nav-board').click();
      await expect(page.getByTestId('board-table')).toBeVisible();
      await expect(page.getByTestId('board-date')).toHaveValue('2026-06-01');
      await expect(page.getByTestId('mode-base')).toHaveAttribute('aria-pressed', 'true');

      if (screen === 'Табло') {
        await page.goBack();
        await expect(page.getByTestId('query-form')).toBeVisible();
        await expect(page.getByTestId('to')).toHaveValue('');
        await expect(page.getByTestId('price')).toHaveValue('');
        await expect(page.getByTestId('compare-toggle')).not.toBeChecked();
      }
    });
  }

  test('после выхода одно «Назад» возвращает на страницу перед сайтом', async ({ page, browserName }) => {
    await page.addInitScript(() => {
      // Отмечаем переход независимо от того, переиспользовал ли браузер документ.
      const markReturn = () => {
        if (sessionStorage.getItem('test-signout-return') === 'waiting') {
          sessionStorage.setItem('test-signout-return', 'arrived');
        }
      };
      window.addEventListener('popstate', markReturn);
      window.addEventListener('pageshow', markReturn);
    });
    await page.route('**/before-app', (route) => route.fulfill({
      contentType: 'text/html; charset=utf-8',
      body: '<title>Предыдущая страница</title><h1>Предыдущая страница</h1>',
    }));
    await loginAdmin(page);
    await page.goto('/before-app');
    await page.goto('/?from=MOW&to=KGD&date=2026-06-12&price=8100');
    await settled(page);
    await page.getByTestId('nav-board').click();
    await expect(page.getByTestId('board-table')).toBeVisible();
    await page.getByTestId('nav-admin').click();
    await expect(page.getByTestId('admin-current')).toBeVisible();
    await page.getByTestId('nav-flight').click();
    await settled(page);
    await page.getByTestId('nav-board').click();
    await expect(page.getByTestId('board-table')).toBeVisible();
    await page.reload();
    await expect(page.getByTestId('board-table')).toBeVisible();

    await page.evaluate(() => sessionStorage.setItem('test-signout-return', 'waiting'));
    await page.getByTestId('logout').click();
    await expect.poll(() => page.evaluate(() => sessionStorage.getItem('test-signout-return'))).toBe('arrived');
    await expect(page.getByTestId('login-form')).toBeVisible();
    await expect(page).toHaveTitle('Вход · Решись Авиа');
    if (browserName === 'chromium') {
      const session = await page.context().newCDPSession(page);
      try {
        await expect.poll(async () => {
          const navigation = await session.send('Page.getNavigationHistory');
          return navigation.entries[navigation.currentIndex]?.title;
        }).toBe('Вход · Решись Авиа');
      } finally {
        await session.detach();
      }
    }
    await expect(page).toHaveURL(/\/$/);
    await page.goBack();
    await expect(page).toHaveURL(/\/before-app$/);
    await expect(page).toHaveTitle('Предыдущая страница');
  });

  test('вход с неверным паролем показывает ошибку, с верным — пускает', async ({ page, problems }) => {
    problems.allow(/status of 401/);
    const u = await registerViaApi(page);
    await page.context().clearCookies();
    await page.goto('/');

    await login(page, u.email, 'Wrong-pass-1');
    const form = page.getByTestId('login-form');
    await expect(form.getByRole('alert').filter({ hasText: 'Неверный email или пароль' })).toBeVisible();
    await expect(page.getByTestId('user-chip')).toHaveCount(0);
    expect((await me(page)).user).toBeNull();

    await login(page, u.email, u.password);
    await expect(page.getByTestId('user-chip')).toContainText(u.name);
    await expect(page.getByTestId('query-form')).toBeVisible();
    expect((await me(page)).user?.email).toBe(u.email);
  });

  test('пустая форма входа — клиентские ошибки без запроса', async ({ page }) => {
    let requests = 0;
    page.on('request', (r) => {
      if (r.url().includes('/api/auth/login')) requests++;
    });
    await page.goto('/');
    await page.getByTestId('login-form').getByRole('button', { name: 'Войти' }).click();
    await expect(page.getByText('Укажите email')).toBeVisible();
    await expect(page.getByText('Введите пароль')).toBeVisible();
    expect(requests).toBe(0);
  });

  test('истёкшая сессия при пересчёте возвращает на вход с сообщением', async ({ page, problems }) => {
    problems.allow(/status of 401/);
    await openApp(page);
    await page.context().clearCookies(); // сессия «протухла»
    await page.getByTestId('price').fill('9100');
    await expect(page.getByTestId('login-form')).toBeVisible();
    await expect(page.getByRole('status').filter({ hasText: 'Сессия истекла. Войдите снова.' })).toBeVisible();
  });

  test('сессия сохраняется после перезагрузки', async ({ page }) => {
    const u = newUser();
    await openRegister(page);
    await fillRegister(page, u);
    await expect(page.getByTestId('user-chip')).toContainText(u.name);
    await page.reload();
    await expect(page.getByTestId('user-chip')).toContainText(u.name);
    await expect(page.getByTestId('login-form')).toHaveCount(0);
    await expect(page.getByTestId('query-form')).toBeVisible();
  });
});
