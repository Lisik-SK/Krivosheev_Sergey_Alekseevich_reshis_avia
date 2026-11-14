/**
 * Что видит пользователь, когда данные прогноза меняются у него «под ногами»:
 * уведомление о новой версии, жёлтая плашка о битом файле, замечания к данным.
 *
 * Тесты меняют файлы данных тестового сервера и в конце всегда возвращают исходные.
 */
import type { APIRequestContext } from '@playwright/test';
import { test, expect, openApp, settled, textOf, waitForecast } from '../e2e/support/fixtures';
import { adminApi, healthStatus, patchedForecast, patchedRoutes, restoreDataOnDisk, uploadApply, useLang, writeForecastOnDisk } from './support/extra';

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
