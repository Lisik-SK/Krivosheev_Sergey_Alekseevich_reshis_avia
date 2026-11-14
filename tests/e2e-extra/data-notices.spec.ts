/**
 * Что видит пользователь, когда данные прогноза меняются у него «под ногами»:
 * уведомление о новой версии, жёлтая плашка о битом файле, замечания к данным.
 *
 * Тесты меняют файлы данных тестового сервера и в конце всегда возвращают исходные.
 */
import type { APIRequestContext } from '@playwright/test';
import { restoreDataset } from '../e2e/support/admin-data';
import { test, expect, openApp, registerViaApi, settled, textOf, waitForecast } from '../e2e/support/fixtures';
import { ORIGINAL, adminApi, healthStatus, patchedForecast, patchedRoutes, restoreDataOnDisk, uploadApply, useLang, writeForecastOnDisk } from './support/extra';

const Q = '?from=MOW&to=AER&date=2026-06-01&price=9000';
const NEW_DATA = 'Загружена новая версия прогноза';

let api: APIRequestContext;

test.beforeAll(async () => {
  api = await adminApi();
});
test.afterEach(async () => {
  await restoreDataOnDisk(api);
});
test.afterAll(async () => {
  await api.dispose();
});

test.describe('Уведомления о новых данных', () => {
  test('открытый калькулятор сам обновляет прогноз при замене и откате', async ({ page }) => {
    await openApp(page, Q);
    const opened = await page.evaluate(() => performance.timeOrigin);
    const wants = page.getByTestId('wants');
    await expect(wants).toHaveText('775');

    await uploadApply(api, 'forecast', patchedForecast({ '0.5_base_demand': '850' }));
    await expect(wants).toHaveText('850', { timeout: 12_000 });
    await expect(page.getByTestId('price')).toHaveValue('9000');
    await expect(page.getByTestId('date')).toHaveValue('2026-06-01');

    await restoreDataset(api, 'forecast');
    await expect(wants).toHaveText('775', { timeout: 12_000 });
    expect(await page.evaluate(() => performance.timeOrigin)).toBe(opened);
  });

  test('видимое табло обновляет таблицу и карту без навигации или смены вкладки', async ({ page }) => {
    await registerViaApi(page);
    await page.goto('/board?date=2026-06-12&mode=model');
    const row = page.getByTestId('board').locator('tr[data-route="MOW-KGD"]');
    const arc = page.getByTestId('route-map').locator('.map__route[data-route="MOW-KGD"]');
    await expect(row).toBeVisible();
    await expect(arc).toBeVisible();

    await uploadApply(api, 'routes', ORIGINAL.routes.replace(/^MOW-KGD,[^\r\n]*\r?\n/gm, ''));
    await expect(row).toHaveCount(0, { timeout: 12_000 });
    await expect(arc).toHaveCount(0);
    await expect(page.getByTestId('board-date')).toHaveValue('2026-06-12');
    await expect(page.getByTestId('mode-model')).toHaveAttribute('aria-pressed', 'true');

    await restoreDataset(api, 'routes');
    await expect(row).toBeVisible({ timeout: 12_000 });
    await expect(arc).toBeVisible();
  });

  test('расчёт на границе версий ждёт согласованный прогноз и графики', async ({ page }) => {
    await openApp(page, Q);
    await expect(page.getByTestId('wants')).toHaveText('775');

    let releaseMeta!: () => void;
    let metaArrived!: () => void;
    const gate = new Promise<void>((resolve) => { releaseMeta = resolve; });
    const waiting = new Promise<void>((resolve) => { metaArrived = resolve; });
    await page.route('**/api/meta', async (route) => {
      const response = await route.fetch();
      metaArrived();
      await gate;
      await route.fulfill({ response });
    }, { times: 1 });
    try {
      // Кривая ещё взята из старого кеша, когда новая медиана уже приходит от сервера.
      await uploadApply(api, 'forecast', patchedForecast({ '0.5_base_demand': '850' }));
      await page.getByTestId('price').fill('9100');
      await waiting;
      await expect(page.getByTestId('wants')).toHaveText('775');
    } finally {
      releaseMeta();
    }
    await expect.poll(() => textOf(page, 'wants')).toBe('835,9');
    await settled(page);
  });

  test('после краткого сбоя пересчёта следующая проверка показывает новую версию', async ({ page, problems }) => {
    await openApp(page, Q);
    const wants = page.getByTestId('wants');
    await expect(wants).toHaveText('775');
    await uploadApply(api, 'forecast', patchedForecast({ '0.5_base_demand': '850' }));
    problems.allow(/500|Internal Server Error/);
    await page.route('**/api/forecast', (route) => route.fulfill({
      status: 500, json: { error: 'Временный сбой расчёта' },
    }), { times: 1 });

    const failed = waitForecast(page);
    await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
    expect((await failed).status()).toBe(500);
    await expect(wants).toHaveText('775');
    await expect(wants).toHaveText('850', { timeout: 12_000 });
    await settled(page);
  });

  test('администратор заменил прогноз — при следующем расчёте всплывает уведомление и новые цифры', async ({ page }) => {
    await openApp(page, Q);
    expect(await textOf(page, 'wants')).toBe('775');

    await uploadApply(api, 'forecast', patchedForecast({ '0.5_base_demand': '850' }));

    const res = waitForecast(page);
    await page.getByTestId('price').fill('9100');
    await res;
    await expect(page.locator('.toast')).toContainText(NEW_DATA);
    await settled(page);
    await expect.poll(() => textOf(page, 'wants')).toBe('835,9');
    // Уведомление исчезает само
    await expect(page.locator('.toast')).toHaveCount(0, { timeout: 6_000 });
  });

  test('возврат на вкладку после замены данных — уведомление и пересчёт без нажатия кнопки', async ({ page }) => {
    await openApp(page, Q);
    await uploadApply(api, 'forecast', patchedForecast({ '0.5_base_demand': '850' }));

    const res = waitForecast(page);
    // Браузер шлёт visibilitychange при возврате на вкладку; в тесте вызываем его вручную.
    await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
    await expect(page.locator('.toast')).toContainText(NEW_DATA);
    await res;
    await settled(page);
    await expect.poll(() => textOf(page, 'wants')).toBe('850');
  });

  test('уведомление на английском', async ({ page }) => {
    await page.addInitScript(() => localStorage.setItem('ra-lang', 'en'));
    await openApp(page, Q);
    await uploadApply(api, 'forecast', patchedForecast({ '0.5_base_demand': '850' }));
    await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
    await expect(page.locator('.toast')).toContainText('A new version of the forecast has been loaded');
  });

  test('после замены справочника калькулятор сообщает об обновлении маршрутов', async ({ page }) => {
    await useLang(page, 'en');
    await openApp(page, Q.replace('price=9000', 'price=9500'));
    await uploadApply(api, 'routes', patchedRoutes('0.2'));
    await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
    await expect(page.locator('.toast')).toContainText('Route directory updated');
    await expect.poll(() => textOf(page, 'wants')).toBe('675');
  });
});

test.describe('Плашки о состоянии данных', () => {
  test('битый файл на сервере — жёлтая плашка с причиной, расчёт идёт по прошлой версии', async ({ page }) => {
    writeForecastOnDisk('route,date,seats\nMOW-AER,2026-06-01,900\n');
    await expect.poll(() => healthStatus(api), { timeout: 15_000, message: 'сервер не заметил битый файл' }).toBe('degraded');

    await openApp(page, Q);
    const alert = page.locator('#main .alert--warn').filter({ hasText: 'Новый файл прогноза не загрузился' });
    await expect(alert).toBeVisible();
    await expect(alert).toContainText('Пока показаны данные предыдущей версии');
    // Цифры по прошлой (исправной) версии
    expect(await textOf(page, 'wants')).toBe('775');

    // Файл исправили — плашка пропадает при возврате на вкладку
    await restoreDataOnDisk(api);
    await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
    await expect(alert).toHaveCount(0);
  });

  test('замечания к данным (квантили не по возрастанию) — сворачиваемый список, медиана не меняется', async ({ page }) => {
    // P10 больше медианы — сервер выровняет квантили и оставит замечание.
    await uploadApply(api, 'forecast', patchedForecast({ '0.1_base_demand': '2000' }));
    await openApp(page, Q);
    const details = page.locator('#main .alert--warn details');
    await expect(details.locator('summary')).toContainText(/Замечания к данным: \d+/);
    await details.locator('summary').click();
    await expect(details.locator('li').first()).toBeVisible();
    expect(await textOf(page, 'wants')).toBe('775');
  });

  test('/api/health честно сообщает о битом файле: degraded, потом снова ok', async () => {
    expect(await healthStatus(api)).toBe('ok');
    writeForecastOnDisk('this is not a csv');
    await expect.poll(() => healthStatus(api), { timeout: 15_000 }).toBe('degraded');
    await restoreDataOnDisk(api);
    expect(await healthStatus(api)).toBe('ok');
  });
});
