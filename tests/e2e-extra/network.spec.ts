/**
 * Что видит пользователь, когда сеть или сервер подводят.
 * Запросы подменяются через page.route() и context.setOffline(), сервер настоящий.
 */
import { test, expect, openApp, registerViaApi, settled, waitForecast, textOf, loginAdmin } from '../e2e/support/fixtures';
import { expected, num1 } from '../e2e/support/data';
import { NETWORK_NOISE } from './support/extra';

const NO_NETWORK = 'Нет связи с сервером';
const Q = '?from=MOW&to=AER&date=2026-06-01&price=9500';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

test.beforeEach(({ problems }) => problems.allow(NETWORK_NOISE));

test.describe('Сбои сети: запуск приложения', () => {
  test('сервер недоступен при открытии страницы — понятное сообщение, а не пустой экран', async ({ page }) => {
    await page.route('**/api/auth/me', (r) => r.abort('failed'));
    await page.goto('/');
    await expect(page.getByText(NO_NETWORK)).toBeVisible();
  });

  test('сервер отвечает 500 с HTML-страницей ошибки — показан код, страница не падает', async ({ page }) => {
    await page.route('**/api/auth/me', (r) => r.fulfill({ status: 500, contentType: 'text/html', body: '<h1>Internal Server Error</h1>' }));
    await page.goto('/');
    await expect(page.getByText('Ошибка сервера (500)')).toBeVisible();
  });

  test('не загрузились данные прогноза (/api/meta) — сообщение вместо формы', async ({ page }) => {
    await registerViaApi(page);
    await page.route('**/api/meta', (r) => r.abort('failed'));
    await page.goto('/');
    await expect(page.locator('#main .empty')).toContainText(NO_NETWORK);
    await expect(page.getByTestId('query-form')).toHaveCount(0);
    // Шапка с навигацией остаётся, можно уйти на другой экран
    await expect(page.getByTestId('nav-board')).toBeVisible();
  });
});

test.describe('Сбои сети: вход и выход', () => {
  test('вход без связи — ошибка в форме, кнопка снова активна', async ({ page }) => {
    await page.goto('/');
    const form = page.getByTestId('login-form');
    await expect(form).toBeVisible();
    await page.route('**/api/auth/login', (r) => r.abort('failed'));
    await form.locator('input[name=email]').fill('nobody@example.com');
    await form.locator('input[name=password]').fill('Password123');
    await form.locator('button[type=submit]').click();
    await expect(form.getByRole('alert')).toContainText(NO_NETWORK);
    await expect(form.locator('button[type=submit]')).toBeEnabled();
  });

  test('выход без связи всё равно возвращает на форму входа', async ({ page }) => {
    await openApp(page);
    await page.route('**/api/auth/logout', (r) => r.abort('failed'));
    await page.getByTestId('logout').click();
    await expect(page.getByTestId('login-form')).toBeVisible();
  });
});

test.describe('Сбои сети: расчёт', () => {
  test('потеря связи при расчёте: ошибка у формы, прежний результат на месте; после восстановления считается', async ({ page, context }) => {
    await openApp(page, Q);
    const before = await textOf(page, 'wants');
    await context.setOffline(true);
    try {
      await page.getByTestId('price').fill('9100');
      const alert = page.getByTestId('query-form').getByRole('alert');
      await expect(alert).toContainText(NO_NETWORK);
      await expect(page.getByTestId('results')).not.toHaveClass(/is-loading/);
      await expect(page.getByTestId('price')).toBeEditable();
      // Старые цифры не пропали и не заменились мусором
      await expect(page.getByTestId('sales')).toBeVisible();
      expect(await textOf(page, 'wants')).toBe(before);
    } finally {
      await context.setOffline(false);
    }
    const res = waitForecast(page);
    await page.getByTestId('price').fill('9101');
    expect((await res).status()).toBe(200);
    await settled(page);
    await expect(page.getByTestId('query-form').getByRole('alert')).toHaveCount(0);
    expect(await textOf(page, 'wants')).toBe(num1(expected('MOW-AER', '2026-06-01', 9101).wants));
  });

  test('ответ 500 с HTML — «Ошибка сервера (500)»', async ({ page }) => {
    await openApp(page, Q);
    await page.route('**/api/forecast', (r) => r.fulfill({ status: 500, contentType: 'text/html', body: '<html>oops</html>' }));
    await page.getByTestId('price').fill('9200');
    await expect(page.getByTestId('query-form').getByRole('alert')).toContainText('Ошибка сервера (500)');
  });

  test('ответ 503 с JSON-ошибкой — показан текст сервера', async ({ page }) => {
    await openApp(page, Q);
    const message = 'Данные прогноза временно недоступны';
    await page.route('**/api/forecast', (r) => r.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: message }) }));
    await page.getByTestId('price').fill('9300');
    await expect(page.getByTestId('query-form').getByRole('alert')).toContainText(message);
  });

  test('ответ 200, но тело не JSON — страница не падает', async ({ page }) => {
    await openApp(page, Q);
    await page.route('**/api/forecast', (r) => r.fulfill({ status: 200, contentType: 'text/html', body: '<html>proxy page</html>' }));
    await page.getByTestId('price').fill('9400');
    // Фикстура problems уронит тест, если на странице будет необработанное исключение.
    await expect(page.getByTestId('query-form').getByRole('alert')).toContainText('Не удалось получить прогноз');
    await expect(page.getByTestId('results')).not.toHaveClass(/is-loading/);
  });

  test('медленный ответ: индикатор загрузки, потом результат', async ({ page }) => {
    await openApp(page, Q);
    await page.route('**/api/forecast', async (r) => {
      await sleep(1500);
      await r.continue().catch(() => undefined);
    });
    const res = waitForecast(page);
    await page.getByTestId('price').fill('9700');
    await expect(page.getByTestId('results')).toHaveClass(/is-loading/);
    await res;
    await settled(page);
    expect(await textOf(page, 'wants')).toBe(num1(expected('MOW-AER', '2026-06-01', 9700).wants));
  });

  test('гонка запросов: поздний ответ на старую цену не перезаписывает новую', async ({ page }) => {
    await openApp(page, Q);
    await page.route('**/api/forecast', async (r) => {
      const body = r.request().postDataJSON() as { price: number };
      if (body.price === 9100) await sleep(2500);
      await r.continue().catch(() => undefined); // запрос мог быть отменён страницей
    });
    const old = page.waitForRequest((r) => r.url().endsWith('/api/forecast') && r.postDataJSON()?.price === 9100);
    await page.getByTestId('price').fill('9100');
    await old;
    const fresh = page.waitForResponse((r) => r.url().endsWith('/api/forecast') && (r.request().postDataJSON() as { price: number }).price === 9600);
    await page.getByTestId('price').fill('9600');
    await fresh;
    await settled(page);
    await sleep(3000); // ждём, пока «старый» ответ гарантированно придёт
    expect(await textOf(page, 'wants')).toBe(num1(expected('MOW-AER', '2026-06-01', 9600).wants));
    await expect(page.locator('#chart-title')).toContainText(/9\s600/);
    expect(page.url()).toContain('price=9600');
  });

  test('сессия истекла посреди работы (401 на дополнительном запросе) — возврат на вход с объяснением', async ({ page, problems }) => {
    problems.allow(/401/);
    await openApp(page, Q);
    await page.route('**/api/forecast/curve', (r) => r.fulfill({ status: 401, contentType: 'application/json', body: JSON.stringify({ error: 'unauthorized' }) }));
    await page.getByRole('button', { name: 'Следующий день', exact: true }).click();
    await expect(page.getByTestId('login-form')).toBeVisible();
    await expect(page.getByText('Сессия истекла. Войдите снова.')).toBeVisible();
  });
});

test.describe('Сбои сети: табло, история, данные', () => {
  test('табло без связи — ошибка; после восстановления табло загружается и ошибка исчезает', async ({ page }) => {
    await registerViaApi(page);
    await page.route('**/api/forecast/board', (r) => r.abort('failed'));
    await page.goto('/board');
    const alert = page.locator('#main').getByRole('alert');
    await expect(alert).toContainText(NO_NETWORK);
    await page.unroute('**/api/forecast/board');
    await page.getByTestId('mode-model').click();
    await expect(page.getByTestId('board-table')).toBeVisible();
    await expect(alert).toHaveCount(0);
  });

  test('история не сохранилась (500) — расчёт работает, панель истории открывается и закрывается', async ({ page }) => {
    await page.route('**/api/history', (r) => r.fulfill({ status: 500, contentType: 'application/json', body: '{"error":"db"}' }));
    await openApp(page, Q);
    await sleep(2000); // сохранение в историю идёт через 1,5 с после расчёта
    await expect(page.getByTestId('sales')).toBeVisible();
    await page.getByTestId('history-open').click();
    await expect(page.getByTestId('history-drawer')).toBeVisible();
    await expect(page.getByTestId('history-close')).toBeFocused();
    await page.keyboard.press('Escape');
    await expect(page.getByTestId('history-drawer')).toHaveCount(0);
  });

  test('закрепить и удалить запись истории без связи — запись не меняется', async ({ page }) => {
    await openApp(page, Q);
    await expect
      .poll(async () => ((await (await page.request.get('/api/history')).json()) as { items: unknown[] }).items.length, { timeout: 10_000 })
      .toBeGreaterThan(0);
    await page.getByTestId('history-open').click();
    const items = page.getByTestId('history-item');
    await expect(items.first()).toBeVisible();
    const count = await items.count();
    await page.route('**/api/history/*', (r) => r.abort('failed'));
    await page.getByTestId('history-pin').first().click();
    await sleep(500);
    await expect(page.getByTestId('history-pin').first()).toHaveAttribute('aria-pressed', 'false');
    await page.getByTestId('history-delete').first().click();
    await sleep(500);
    await expect(items).toHaveCount(count);
  });

  test('проверка файла администратором без связи — ошибка, кнопки «Заменить» нет', async ({ page }) => {
    await loginAdmin(page);
    await page.goto('/admin');
    await expect(page.getByTestId('admin-current')).toContainText('csv');
    await page.route('**/api/admin/upload', (r) => r.abort('failed'));
    await page.getByTestId('admin-file').setInputFiles({ name: 'seasonal_forecast.csv', mimeType: 'text/csv', buffer: Buffer.from('route,date\n') });
    await expect(page.getByTestId('admin-preview').getByRole('alert')).toContainText(NO_NETWORK);
    await expect(page.getByTestId('admin-apply')).toHaveCount(0);
  });
});
