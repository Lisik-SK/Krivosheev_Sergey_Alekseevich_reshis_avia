/** Готовит обратные рейсы для браузерных тестов выбора маршрута. */
import { readFileSync } from 'node:fs';
import { request, type APIRequestContext } from '@playwright/test';
import { ADMIN } from './admin-user';
import { expect, test } from './fixtures';

/**
 * Определяет CSV, который принимает API администрирования тестового сервера.
 * Справочник заменяется перед прогнозом, а восстанавливается после него.
 */
type DatasetKind = 'routes' | 'forecast';

/**
 * Выбирает исходные строки на 1 июня 2026 года и добавляет обратные маршруты.
 * @param kind Обязательный тип набора данных. Справочник и прогноз читаются из data/.
 * @returns Полный текст CSV с двумя дополнительными строками в конце.
 * @throws Ошибка чтения или отсутствие исходной строки для любого из двух маршрутов.
 * @remarks Читает официальные CSV синхронно, не меняя файлы.
 */
function csvWithReturnFlights(kind: DatasetKind): string {
  const filename = kind === 'routes' ? 'routes.csv' : 'seasonal_forecast.csv';
  const csv = readFileSync(`data/${filename}`, 'utf8').trimEnd();
  const lines = csv.split(/\r?\n/);
  const additions = ['AER', 'LED'].map((destination) => {
    const route = `MOW-${destination}`;
    const prefix = kind === 'routes' ? `${route},` : `${route},2026-06-01,`;
    const line = lines.find((entry) => entry.startsWith(prefix));
    if (!line) throw new Error(`Missing CSV row: ${prefix}`);
    const cells = line.split(',');
    cells[0] = `${destination}-MOW`;
    if (kind === 'routes') cells[1] = cells[1]!.split(' — ').reverse().join(' — ');
    return cells.join(',');
  });
  return [csv, ...additions, ''].join('\n');
}

/**
 * Заменяет один CSV на тестовом сервере и проверяет применение загрузки.
 * @param api Обязательный открытый контекст запроса с сессией администратора.
 * @param kind Обязательный тип CSV, соответствующий содержимому.
 * @param content Обязательный непустой текст полного CSV с заголовком.
 * @returns Promise<void> после подтверждения сервером, что CSV применён.
 * @throws Ошибка запроса, отказ HTTP, ошибка разбора ответа или отклонение CSV.
 * @remarks Меняет временный CSV и его резервную копию через API. Запрос не повторяется.
 */
async function uploadDataset(api: APIRequestContext, kind: DatasetKind, content: string): Promise<void> {
  const response = await api.post('/api/admin/upload', { data: { kind, content, apply: true } });
  expect(response.ok(), await response.text()).toBe(true);
  expect(await response.json()).toMatchObject({ ok: true, applied: true });
}

/**
 * Восстанавливает резервную копию CSV на тестовом сервере.
 * @param api Обязательный открытый контекст запроса с сессией администратора.
 * @param kind Обязательный тип CSV, для которого уже завершилась загрузка.
 * @returns Promise<void> после подтверждённого восстановления.
 * @throws Ошибка запроса, отказ HTTP или отсутствие резервной копии.
 * @remarks Меняет временный CSV через API. Повторных запросов не выполняет.
 */
async function restoreDataset(api: APIRequestContext, kind: DatasetKind): Promise<void> {
  const response = await api.post('/api/admin/restore', { data: { kind } });
  expect(response.ok(), await response.text()).toBe(true);
}

/**
 * Расширяет тесты выбора рейса двумя обратными маршрутами на 1 июня 2026 года.
 * Перед запуском сценариев входит в тестовый API, применяет справочник, затем прогноз.
 * После сценариев восстанавливает успешно заменённые файлы в обратном порядке даже при ошибке теста,
 * освобождает контекст запросов и передаёт ошибки загрузки или восстановления в Playwright.
 * Фикстура меняет только копии CSV в тестовом сервере. Конфигурация запуска использует один воркер.
 */
export const testWithReturnFlights = test.extend<object, { returnFlights: void }>({
  returnFlights: [
    async ({}, use) => {
      const routes = csvWithReturnFlights('routes');
      const forecast = csvWithReturnFlights('forecast');
      const baseURL = `http://127.0.0.1:${process.env.E2E_PORT ?? 3399}`;
      const api = await request.newContext({ baseURL });
      try {
        const login = await api.post('/api/auth/login', { data: ADMIN });
        expect(login.ok(), await login.text()).toBe(true);
        await uploadDataset(api, 'routes', routes);
        try {
          await uploadDataset(api, 'forecast', forecast);
          try {
            await use();
          } finally {
            await restoreDataset(api, 'forecast');
          }
        } finally {
          await restoreDataset(api, 'routes');
        }
      } finally {
        await api.dispose();
      }
    },
    { scope: 'worker', auto: true },
  ],
});
