/**
 * Экран «Данные» через интерфейс: справочник маршрутов (routes.csv), переключение типа файла,
 * перетаскивание файла, слишком большой файл, кнопка «Отмена».
 * В основном наборе через интерфейс проверялся только файл прогноза.
 */
import { readFile } from 'node:fs/promises';
import type { APIRequestContext, Page } from '@playwright/test';
import { test, expect, loginAdmin, numberOf, settled } from '../e2e/support/fixtures';
import { ORIGINAL, adminApi, patchedForecast, patchedRoutes, restoreDataOnDisk, uploadApply, wantsViaApi } from './support/extra';

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

async function openAdmin(page: Page) {
  await loginAdmin(page);
  await page.goto('/admin');
  await expect(page.getByTestId('admin-current')).toContainText('routes.csv');
}

async function chooseFile(page: Page, name: string, content: string) {
  await page.getByTestId('admin-file').setInputFiles({ name, mimeType: 'text/csv', buffer: Buffer.from(content, 'utf8') });
}

test('скачивание текущих CSV сохраняет имена после замены и отката справочника', async ({ page }) => {
  await openAdmin(page);

  async function expectDownload(kind: 'forecast' | 'routes', filename: string, content: string) {
    const [download] = await Promise.all([
      page.waitForEvent('download'),
      page.getByTestId(`download-${kind}`).click(),
    ]);
    expect(download.suggestedFilename()).toBe(filename);
    expect(await readFile(await download.path())).toEqual(Buffer.from(content, 'utf8'));
  }

  await expectDownload('forecast', 'seasonal_forecast.csv', ORIGINAL.forecast);
  await expectDownload('routes', 'routes.csv', ORIGINAL.routes);

  const replacement = '\uFEFF' + patchedRoutes('0.2');
  const replacementName = 'Маршруты (июнь).csv';
  await page.getByLabel('Справочник маршрутов', { exact: true }).check();
  await chooseFile(page, replacementName, replacement);
  await expect(page.getByTestId('admin-valid')).toBeVisible();
  await page.getByTestId('admin-apply').click();
  await expect(page.getByTestId('admin-applied')).toBeVisible();
  await expect(page.getByTestId('admin-current').getByText(replacementName, { exact: true })).toBeVisible();
  await expectDownload('routes', replacementName, replacement);

  await page.getByTestId('restore-routes').click();
  await expect(page.getByTestId('admin-current').getByText('routes.csv', { exact: true })).toBeVisible();
  await expectDownload('routes', 'routes.csv', ORIGINAL.routes);
});

test('очень быстрые нажатия выполняют один откат, даже если подтверждение задержалось', async ({ page }) => {
  await uploadApply(api, 'forecast', patchedForecast({ '0.5_base_demand': '850' }), 'burst.csv');
  await openAdmin(page);
  const restore = page.getByTestId('restore-forecast');
  let restoreCalls = 0;
  page.on('request', (request) => {
    if (request.url().endsWith('/api/admin/restore')) restoreCalls++;
  });

  let releaseRestore!: () => void;
  let writeCompleted!: (status: number) => void;
  const gate = new Promise<void>((resolve) => { releaseRestore = resolve; });
  const written = new Promise<number>((resolve) => { writeCompleted = resolve; });
  await page.route('**/api/admin/restore', async (route) => {
    const response = await route.fetch();
    writeCompleted(response.status());
    await gate;
    await route.fulfill({ response });
  }, { times: 1 });

  try {
    await restore.evaluate((button) => {
      for (let i = 0; i < 20; i++) button.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(await written).toBe(200);
    await expect(restore).toBeDisabled();
    expect(restoreCalls).toBe(1);
    // Проверяет второе нажатие уже по новой кнопке с новой ревизией.
    const earlyClick = page.getByTestId('admin-current').evaluate((current) => new Promise<boolean>((resolve) => {
      const clickUpdated = () => {
        if (!current.textContent?.includes('seasonal_forecast.csv')) return;
        observer.disconnect();
        const updated = current.querySelector<HTMLButtonElement>('[data-testid="restore-forecast"]')!;
        updated.dispatchEvent(new MouseEvent('click', { bubbles: true }));
        resolve(updated.disabled);
      };
      const observer = new MutationObserver(clickUpdated);
      observer.observe(current, { childList: true });
      clickUpdated();
    }));
    releaseRestore();
    expect(await earlyClick).toBe(true);
  } finally {
    releaseRestore();
  }
  await expect(page.getByTestId('admin-current')).toContainText('seasonal_forecast.csv');
  expect(await wantsViaApi(api, 9000)).toBe(775);
  expect(restoreCalls).toBe(1);
  await restore.click();
  await expect(page.getByTestId('admin-current')).toContainText('burst.csv');
  expect(await wantsViaApi(api, 9000)).toBe(850);
  expect(restoreCalls).toBe(2);
});

test('устаревший откат из другой сессии не меняет файлы и перечитывает сведения', async ({ page, problems }) => {
  await uploadApply(api, 'forecast', patchedForecast({ '0.5_base_demand': '850' }), 'middle.csv');
  await openAdmin(page);
  await expect(page.getByTestId('admin-current')).toContainText('middle.csv');
  await uploadApply(api, 'forecast', patchedForecast({ '0.5_base_demand': '800' }), 'latest.csv');
  problems.allow(/409|CONFLICT/i);

  const conflict = page.waitForResponse((response) => response.url().endsWith('/api/admin/restore'));
  await page.getByTestId('restore-forecast').click();
  expect((await conflict).status()).toBe(409);
  await expect(page.getByTestId('admin-preview').getByRole('alert')).toBeVisible();
  await expect(page.getByTestId('admin-current')).toContainText('latest.csv');
  expect(await wantsViaApi(api, 9000)).toBe(800);
});

test('устаревшее подтверждение требует заново проверить тот же файл', async ({ page, problems }) => {
  await openAdmin(page);
  const candidate = patchedForecast({ '0.5_base_demand': '850' });
  const preview = page.getByTestId('admin-valid');
  const apply = page.getByTestId('admin-apply');
  await chooseFile(page, 'candidate.csv', candidate);
  await expect(preview).toBeVisible();

  await uploadApply(api, 'routes', patchedRoutes('0.2'));
  problems.allow(/409|CONFLICT/i);
  const conflict = page.waitForResponse((response) => response.url().endsWith('/api/admin/upload'));
  await apply.click();
  expect((await conflict).status()).toBe(409);
  await expect(page.getByTestId('admin-preview').getByRole('alert')).toBeVisible();
  await expect(apply).toHaveCount(0);
  await expect(page.getByTestId('admin-file')).toHaveValue('');
  expect(await wantsViaApi(api, 9000)).toBe(775);

  await chooseFile(page, 'candidate.csv', candidate);
  await expect(preview).toContainText('candidate.csv');
  await apply.click();
  await expect(page.getByTestId('admin-current')).toContainText('candidate.csv');
  expect(await wantsViaApi(api, 9000)).toBe(850);
});

test('запоздалая проверка одного файла не подменяет предпросмотр следующего', async ({ page }) => {
  await openAdmin(page);
  let releasePreview!: () => void;
  let previewChecked!: () => void;
  const gate = new Promise<void>((resolve) => { releasePreview = resolve; });
  const checked = new Promise<void>((resolve) => { previewChecked = resolve; });
  await page.route('**/api/admin/upload', async (route) => {
    const response = await route.fetch();
    previewChecked();
    await gate;
    await route.fulfill({ response });
  }, { times: 1 });

  try {
    await chooseFile(page, 'first.csv', patchedForecast({ '0.5_base_demand': '850' }));
    await checked;
    await chooseFile(page, 'second.csv', patchedForecast({ '0.5_base_demand': '800' }));
    await expect(page.getByTestId('admin-valid')).toContainText('second.csv');
    const late = page.waitForResponse((response) => response.url().endsWith('/api/admin/upload')
      && response.request().postDataJSON().filename === 'first.csv');
    releasePreview();
    expect((await late).ok()).toBe(true);
    await expect(page.getByTestId('admin-valid')).toContainText('second.csv');
    await page.getByTestId('admin-apply').click();
    await expect(page.getByTestId('admin-current')).toContainText('second.csv');
    expect(await wantsViaApi(api, 9000)).toBe(800);
  } finally {
    releasePreview();
  }
});

test('некорректный UTF-8 не превращается в изменённый текст для загрузки', async ({ page }) => {
  await openAdmin(page);
  let uploads = 0;
  page.on('request', (request) => {
    if (request.url().endsWith('/api/admin/upload')) uploads++;
  });
  await page.getByTestId('admin-file').setInputFiles({
    name: 'encoding.csv', mimeType: 'text/csv', buffer: Buffer.from([0xc3, 0x28]),
  });
  await expect(page.getByTestId('admin-preview').getByRole('alert')).toContainText('Не удалось прочитать файл');
  await expect(page.getByTestId('admin-apply')).toHaveCount(0);
  expect(uploads).toBe(0);
});

test('смена направления доступна только на дату обратного рейса', async ({ page }) => {
  await loginAdmin(page);
  const forwardOnlyRoutes = ORIGINAL.routes.replace(/^AER-MOW,[^\r\n]*\r?\n/gm, '');
  const forwardOnlyForecast = ORIGINAL.forecast.replace(/^AER-MOW,[^\r\n]*\r?\n/gm, '');
  await uploadApply(api, 'routes', forwardOnlyRoutes);
  await uploadApply(api, 'forecast', forwardOnlyForecast);
  await page.goto('/?from=MOW&to=AER&date=2026-06-02&price=9000');
  await settled(page);

  const from = page.getByTestId('from');
  const to = page.getByTestId('to');
  const date = page.getByTestId('date');
  const swap = page.getByTestId('swap-route');
  const seats = page.getByTestId('seats');
  await expect(swap).toBeHidden();

  const routes = `${forwardOnlyRoutes.trimEnd()}\nAER-MOW,Сочи — Москва,8000,4200,0.141,5400,18000\n`;
  await uploadApply(api, 'routes', routes);
  await page.reload();
  await settled(page);
  await expect(swap).toBeHidden();

  const sample = ORIGINAL.forecast.split(/\r?\n/).find((line) => line.startsWith('MOW-AER,2026-06-01,'));
  expect(sample, 'пример рейса из исходного прогноза').toBeDefined();
  const newFlight = sample!.replace(/^MOW-AER,2026-06-01,\d+,/, 'AER-MOW,2026-06-01,350,');
  await uploadApply(api, 'forecast', `${forwardOnlyForecast.trimEnd()}\n${newFlight}\n`);
  await page.reload();
  await settled(page);
  await expect(date).toHaveValue('2026-06-02');
  await expect(swap).toBeVisible();
  await expect(swap).toBeDisabled();
  await expect(swap).toHaveCSS('opacity', '0.5');
  await swap.dispatchEvent('click');
  await expect(from).toHaveValue('MOW');
  await expect(to).toHaveValue('AER');
  await expect(date).toHaveValue('2026-06-02');

  await page.getByRole('button', { name: 'Предыдущий день' }).click();
  await expect(swap).toBeEnabled();
  await page.getByRole('button', { name: 'Следующий день' }).click();
  await expect(swap).toBeDisabled();
  await page.getByTestId('date-display').fill('2026-06-01');
  await expect(swap).toBeEnabled();
  await page.getByTestId('date-trigger').click();
  await page.locator('.date-picker [data-date="2026-06-02"]').click();
  await expect(swap).toBeDisabled();
  await page.getByTestId('calendar-card').locator('button[data-date="2026-06-01"]').click();
  await expect(swap).toBeEnabled();
  await swap.click();
  await expect(from).toHaveValue('AER');
  await expect(to).toHaveValue('MOW');
  await expect(date).toHaveValue('2026-06-01');
  await expect(seats).toHaveText('350');
  await settled(page);
  await expect.poll(() => Object.fromEntries(new URL(page.url()).searchParams)).toMatchObject({
    from: 'AER', to: 'MOW', date: '2026-06-01',
  });

  await swap.click();
  await expect(from).toHaveValue('MOW');
  await expect(to).toHaveValue('AER');
  await expect(date).toHaveValue('2026-06-01');
  await expect(seats).toHaveText('900');
});

test.describe('Экран «Данные»: справочник маршрутов', () => {
  const routesWithoutKaliningrad = ORIGINAL.routes.replace(/^MOW-KGD,[^\r\n]*\r?\n/gm, '');
  const replacementName = 'Маршруты без Калининграда.csv';

  test('табло обновляет маршруты после замены и отката справочника через шапку', async ({ page }) => {
    const date = '2026-06-12';
    const routeCode = 'MOW-KGD';
    const boardLink = page.getByTestId('nav-board');
    const adminLink = page.getByTestId('nav-admin');
    const board = page.getByTestId('board');
    const map = page.getByTestId('route-map');
    const row = board.locator(`tr[data-route="${routeCode}"]`);
    const arc = map.locator(`.map__route[data-route="${routeCode}"]`);

    /**
     * Возвращается на табло и проверяет снимок до завершения запроса.
     * @param cached true, если справочник не менялся и сохранённый результат должен быть виден.
     * @returns Promise<void> после ответа и завершения отрисовки. Ошибки Playwright распространяются.
     * @remarks Перехватывает только один запрос, снимает задержку даже при ошибке проверки.
     */
    async function returnToBoard(cached: boolean): Promise<void> {
      let release!: () => void;
      const gate = new Promise<void>((resolve) => { release = resolve; });
      await page.route('**/api/forecast/board', async (request) => {
        await gate;
        await request.continue();
      }, { times: 1 });
      const request = page.waitForRequest('**/api/forecast/board');
      const response = page.waitForResponse('**/api/forecast/board');
      try {
        await boardLink.click();
        expect((await request).postDataJSON()).toMatchObject({ date, priceMode: 'model' });
        if (cached) {
          await expect(row).toBeVisible();
          await expect(arc).toBeVisible();
        } else {
          await expect(board.locator('tbody tr')).toHaveCount(0);
          await expect(map.locator('.map__route')).toHaveCount(0);
        }
      } finally {
        release();
      }
      expect((await response).ok()).toBe(true);
      await expect(page.getByTestId('board-table')).toBeVisible();
      await expect(board).not.toHaveClass(/is-loading/);
      await expect(page.getByTestId('board-date')).toHaveValue(date);
      await expect(page.getByTestId('mode-model')).toHaveAttribute('aria-pressed', 'true');
    }

    await loginAdmin(page);
    await page.goto(`/board?date=${date}&mode=model`);
    await expect(row).toBeVisible();
    await expect(arc).toBeVisible();
    await adminLink.click();
    await returnToBoard(true);

    await adminLink.click();
    await page.getByLabel('Справочник маршрутов', { exact: true }).check();
    await chooseFile(page, replacementName, routesWithoutKaliningrad);
    await expect(page.getByTestId('admin-valid')).toBeVisible();
    await expect(page.locator('.admin-warnings')).toHaveCount(0);
    const diff = page.getByTestId('admin-diff');
    await expect(diff).toContainText('Будут удалены маршруты: MOW-KGD');
    await expect(diff).toContainText('Перестанут отображаться рейсы');
    await expect(diff).not.toContainText('Изменятся данные 0');
    await page.getByTestId('admin-apply').click();
    await expect(page.getByTestId('admin-applied')).toBeVisible();
    await returnToBoard(false);
    await expect(row).toHaveCount(0);
    await expect(arc).toHaveCount(0);

    await adminLink.click();
    await page.getByTestId('restore-routes').click();
    await expect(page.getByTestId('admin-current').getByText('routes.csv', { exact: true })).toBeVisible();
    await returnToBoard(false);
    await expect(row).toBeVisible();
    await expect(arc).toBeVisible();
  });

  test('открытое табло перечитывает справочник при возврате на вкладку', async ({ page }) => {
    await loginAdmin(page);
    await page.goto('/board?date=2026-06-12&mode=model');
    const row = page.getByTestId('board').locator('tr[data-route="MOW-KGD"]');
    const arc = page.getByTestId('route-map').locator('.map__route[data-route="MOW-KGD"]');
    await expect(row).toBeVisible();
    await expect(arc).toBeVisible();

    await uploadApply(api, 'routes', routesWithoutKaliningrad);
    await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
    await expect(row).toHaveCount(0);
    await expect(arc).toHaveCount(0);
    await expect(page.getByTestId('board-date')).toHaveValue('2026-06-12');
    await expect(page.getByTestId('mode-model')).toHaveAttribute('aria-pressed', 'true');
  });

  test('рейс при возврате через шапку обновляет направления и сохраняет действующие поля', async ({ page }) => {
    await loginAdmin(page);
    await page.goto('/?from=MOW&to=KGD&date=2026-06-12&price=9700');
    await settled(page);
    await page.getByTestId('nav-admin').click();

    await page.getByLabel('Справочник маршрутов', { exact: true }).check();
    await chooseFile(page, replacementName, routesWithoutKaliningrad);
    await expect(page.getByTestId('admin-valid')).toBeVisible();
    await page.getByTestId('admin-apply').click();
    await expect(page.getByTestId('admin-applied')).toBeVisible();

    await page.getByTestId('nav-flight').click();
    await expect(page.getByTestId('from')).toHaveValue('MOW');
    await expect(page.getByTestId('to')).toHaveValue('');
    await expect(page.getByTestId('to').locator('option[value="KGD"]')).toHaveCount(0);
    await expect(page.getByTestId('date')).toHaveValue('2026-06-12');
    await expect(page.getByTestId('price')).toHaveValue('9700');
    await expect(page.getByTestId('sales')).toHaveCount(0);
  });

  test('позднее подтверждение замены справочника сохраняет рейс, открытый из табло', async ({ page }) => {
    await loginAdmin(page);
    await page.goto('/?from=MOW&to=LED&date=2026-06-12&price=9700');
    await settled(page);
    await page.getByTestId('nav-admin').click();
    await page.getByLabel('Справочник маршрутов', { exact: true }).check();
    await chooseFile(page, replacementName, routesWithoutKaliningrad);
    await expect(page.getByTestId('admin-valid')).toBeVisible();

    let releaseUpload!: () => void;
    let uploadSaved!: (status: number) => void;
    let releaseMeta!: () => void;
    const uploadGate = new Promise<void>((resolve) => { releaseUpload = resolve; });
    const saved = new Promise<number>((resolve) => { uploadSaved = resolve; });
    const metaGate = new Promise<void>((resolve) => { releaseMeta = resolve; });

    await page.route('**/api/admin/upload', async (route) => {
      const response = await route.fetch();
      uploadSaved(response.status());
      await uploadGate;
      await route.fulfill({ response });
    }, { times: 1 });
    try {
      await page.getByTestId('admin-apply').click();
      expect(await saved).toBe(200);
      await page.getByTestId('nav-board').click();
      const openFlight = page.getByTestId('board-table').locator('tr[data-route="MOW-AER"]').getByTestId('board-open');
      await expect(openFlight).toBeVisible();

      // Первый запрос отменяет само приложение при повторном открытии формы.
      await page.route('**/api/meta', async () => {
        await metaGate;
      }, { times: 1 });
      const firstMeta = page.waitForRequest('**/api/meta');
      await openFlight.click();
      await firstMeta;
      const refreshedMeta = page.waitForResponse('**/api/meta');
      releaseUpload();
      expect((await refreshedMeta).ok()).toBe(true);
      await settled(page);
      await expect(page.getByTestId('from')).toHaveValue('MOW');
      await expect(page.getByTestId('to')).toHaveValue('AER');
      await expect(page.getByTestId('date')).toHaveValue('2026-06-01');
      await expect(page.getByTestId('price')).toHaveValue('9000');
    } finally {
      releaseUpload();
      releaseMeta();
    }
  });

  test('замена routes.csv через интерфейс меняет расчёт, кнопка «Вернуть» возвращает прежний', async ({ page }) => {
    await openAdmin(page);
    expect(await wantsViaApi(api)).toBe(704.5);

    await page.getByLabel('Справочник маршрутов', { exact: true }).check();
    // Чувствительность MOW-AER 0.141 → 0.2: при цене 9500 хотят 775 − 0.2 × 500 = 675
    await chooseFile(page, 'routes.csv', patchedRoutes('0.2'));
    await expect(page.getByTestId('admin-valid')).toBeVisible();
    await expect(page.getByTestId('admin-diff')).toContainText('Изменятся параметры маршрутов: MOW-AER');
    expect(await wantsViaApi(api), 'до подтверждения данные не меняются').toBe(704.5);

    await page.getByTestId('admin-apply').click();
    await expect(page.getByTestId('admin-applied')).toContainText('Справочник маршрутов заменён');
    await expect(page.locator('.toast')).toContainText('Справочник маршрутов обновлён');
    await expect.poll(() => wantsViaApi(api)).toBe(675);

    await expect(page.getByTestId('restore-routes')).toBeVisible();
    await page.getByTestId('restore-routes').click();
    await expect(page.locator('.toast')).toContainText('Предыдущая версия восстановлена');
    await expect.poll(() => wantsViaApi(api)).toBe(704.5);
  });

  test('некорректный routes.csv — ошибка проверки, данные не меняются', async ({ page }) => {
    await openAdmin(page);
    await page.getByLabel('Справочник маршрутов', { exact: true }).check();
    await chooseFile(page, 'routes.csv', 'route,name\nMOW-AER,Москва — Сочи\n');
    await expect(page.getByTestId('admin-invalid')).toBeVisible();
    await expect(page.getByTestId('admin-apply')).toHaveCount(0);
    expect(await wantsViaApi(api)).toBe(704.5);
  });

  test('новый маршрут без прогноза недоступен в списке и считается после импорта прогноза', async ({ page }) => {
    await openAdmin(page);
    const routesWithoutReverse = ORIGINAL.routes.replace(/^AER-MOW,[^\r\n]*\r?\n/gm, '');
    const forecastWithoutReverse = ORIGINAL.forecast.replace(/^AER-MOW,[^\r\n]*\r?\n/gm, '');
    await uploadApply(api, 'routes', routesWithoutReverse);
    await uploadApply(api, 'forecast', forecastWithoutReverse);
    await page.getByLabel('Справочник маршрутов', { exact: true }).check();
    const routes = `${routesWithoutReverse.trimEnd()}\nAER-MOW,Сочи — Москва,8000,4200,0.141,5400,18000\n`;
    await chooseFile(page, 'routes.csv', routes);
    await expect(page.getByTestId('admin-valid')).toBeVisible();
    await expect(page.getByTestId('admin-diff')).toContainText('AER-MOW');
    await page.getByTestId('admin-apply').click();
    await expect(page.getByTestId('admin-applied')).toBeVisible();

    const from = page.getByTestId('from');
    const to = page.getByTestId('to');
    const date = page.getByTestId('date');
    await page.goto('/?from=MOW&to=AER&date=2026-06-01&price=9000');
    await settled(page);
    await expect(page.getByTestId('seats')).toHaveText('900');
    await page.goto('/?from=LED&to=MOW&date=2026-06-01&price=5500');
    await settled(page);
    await page.getByTestId('from-trigger').click();
    await expect(page.getByRole('option', { name: /Сочи/ })).toBeDisabled();
    await page.goto('/?from=AER&to=MOW');
    await expect(to).toHaveValue('MOW');
    const forecastUnavailable = page.getByTestId('forecast-unavailable');
    await expect(forecastUnavailable).toContainText('Прогноз для этого маршрута пока не загружен.');
    await expect(date).toBeDisabled();
    await expect(page.getByTestId('date-display')).toBeDisabled();
    await expect(page.getByTestId('date-trigger')).toBeDisabled();
    await expect(date).toHaveValue('');
    await expect(page.getByTestId('sales')).toBeHidden();
    await expect(page.getByTestId('seats')).toBeHidden();
    await expect(page.getByTestId('demand-chart')).toBeHidden();

    await page.getByTestId('nav-admin').click();
    const sample = ORIGINAL.forecast.split(/\r?\n/).find((line) => line.startsWith('MOW-AER,2026-06-01,'));
    expect(sample, 'пример рейса из исходного прогноза').toBeDefined();
    const newFlight = sample!.replace(/^MOW-AER,2026-06-01,\d+,/, 'AER-MOW,2026-06-01,350,');
    const forecast = `${forecastWithoutReverse.trimEnd()}\n${newFlight}\n`;
    await chooseFile(page, 'seasonal_forecast.csv', forecast);
    await expect(page.getByTestId('admin-valid')).toBeVisible();
    await page.getByTestId('admin-apply').click();
    await expect(page.getByTestId('admin-applied')).toBeVisible();

    await page.getByTestId('nav-flight').click();
    await expect(from).toHaveValue('AER');
    await expect(to).toHaveValue('MOW');
    await expect(date).toBeEnabled();
    await expect(page.getByTestId('date-display')).toBeEnabled();
    await expect(page.getByTestId('date-trigger')).toBeEnabled();
    await expect(date).toHaveValue('');
    await page.getByTestId('date-display').fill('2026-06-01');
    await page.getByTestId('price').fill('8000');
    await settled(page);
    await expect(forecastUnavailable).toBeHidden();
    await expect(page.getByTestId('seats')).toHaveText('350');
    expect(await numberOf(page, 'sales')).toBe('350');
  });

  test('файл выбран не с тем типом — после переключения типа он перепроверяется', async ({ page }) => {
    await openAdmin(page);
    // Тип по умолчанию — прогноз; routes.csv как прогноз не проходит проверку
    await chooseFile(page, 'routes.csv', ORIGINAL.routes);
    await expect(page.getByTestId('admin-invalid')).toBeVisible();
    await page.getByLabel('Справочник маршрутов', { exact: true }).check();
    await expect(page.getByTestId('admin-valid')).toBeVisible();
    await expect(page.getByTestId('admin-invalid')).toHaveCount(0);
  });

  test('кнопка «Отмена» убирает проверенный файл, данные не меняются', async ({ page }) => {
    await openAdmin(page);
    await page.getByLabel('Справочник маршрутов', { exact: true }).check();
    await chooseFile(page, 'routes.csv', patchedRoutes('0.2'));
    await expect(page.getByTestId('admin-valid')).toBeVisible();
    await page.getByTestId('admin-preview').getByRole('button', { name: 'Отмена' }).click();
    await expect(page.getByTestId('admin-valid')).toHaveCount(0);
    await expect(page.getByTestId('admin-apply')).toHaveCount(0);
    expect(await wantsViaApi(api)).toBe(704.5);
  });
});

test.describe('Экран «Данные»: способы выбора файла', () => {
  test('перетаскивание файла в область загрузки', async ({ page }) => {
    await openAdmin(page);
    const drop = page.getByTestId('admin-drop');
    await drop.evaluate((el, csv) => {
      const dt = new DataTransfer();
      dt.items.add(new File([csv], 'seasonal_forecast.csv', { type: 'text/csv' }));
      for (const type of ['dragenter', 'dragover']) el.dispatchEvent(new DragEvent(type, { dataTransfer: dt, bubbles: true, cancelable: true }));
      el.dispatchEvent(new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true }));
    }, ORIGINAL.forecast);
    await expect(page.getByTestId('admin-valid')).toBeVisible();
    await expect(page.getByTestId('admin-valid')).toContainText('seasonal_forecast.csv');
    await expect(drop).not.toHaveClass(/is-over/);
  });

  test('файл больше лимита отклоняется сразу в браузере, без отправки на сервер', async ({ page }) => {
    await openAdmin(page);
    const hint = await page.locator('.field__hint').filter({ hasText: /МБ|MB/ }).first().textContent();
    const mb = Number(hint?.match(/(\d+)/)?.[1] ?? 5);
    let uploads = 0;
    page.on('request', (r) => {
      if (r.url().endsWith('/api/admin/upload')) uploads++;
    });
    const big = Buffer.alloc(mb * 1024 * 1024 + 1024, 'a');
    await chooseFile(page, 'huge.csv', big.toString('utf8'));
    await expect(page.getByTestId('admin-preview').getByRole('alert')).toBeVisible();
    expect(uploads).toBe(0);
  });
});
