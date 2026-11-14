/** Вспомогательные запросы к локальному API для замены CSV в браузерных тестах. */
import type { APIRequestContext } from '@playwright/test';
import { expect } from './fixtures';

/** Допустимые типы активных CSV на тестовом сервере. */
type DatasetKind = 'routes' | 'forecast';

/**
 * Проверяет и применяет один CSV в открытом контексте тестового администратора.
 * @param api Обязательный локальный контекст с сессией администратора.
 * @param kind Обязательный тип CSV.
 * @param content Обязательный непустой текст полного CSV с заголовком.
 * @param filename Имя загружаемого файла; по умолчанию стандартное имя указанного типа.
 * @returns Promise<void> после подтверждения сервером, что CSV применён.
 * @throws Ошибка запросов, отказ HTTP, ошибка разбора ответа или отклонение CSV.
 * @remarks Отправляет проверку без записи, затем ровно один запрос с полученной ревизией.
 */
export async function uploadDataset(
  api: APIRequestContext, kind: DatasetKind, content: string,
  filename = kind === 'forecast' ? 'seasonal_forecast.csv' : 'routes.csv',
): Promise<void> {
  const body = { kind, filename, content };
  const preview = await api.post('/api/admin/upload', { data: { ...body, apply: false } });
  expect(preview.ok(), await preview.text()).toBe(true);
  const checked = await preview.json();
  expect(checked).toMatchObject({ ok: true, applied: false, revision: expect.stringMatching(/^[0-9a-f]{64}$/) });
  const apply = await api.post('/api/admin/upload', { data: { ...body, apply: true, expectedRevision: checked.revision } });
  expect(apply.ok(), await apply.text()).toBe(true);
  expect(await apply.json()).toMatchObject({ ok: true, applied: true });
}

/**
 * Восстанавливает резерв указанного типа на локальном тестовом сервере.
 * @param api Обязательный локальный контекст с сессией администратора.
 * @param kind Обязательный тип CSV, для которого уже создан резерв.
 * @returns Promise<void> после подтверждённого восстановления.
 * @throws Ошибка запроса, отказ HTTP или отсутствие резервной копии.
 * @remarks Читает ревизию резерва, затем меняет временный CSV. Повторных запросов не выполняет.
 */
export async function restoreDataset(api: APIRequestContext, kind: DatasetKind): Promise<void> {
  const info = await api.get('/api/admin/data');
  expect(info.ok(), await info.text()).toBe(true);
  const state = await info.json();
  expect(state.backups[kind]).toBe(true);
  const expectedRevision = state.revisions[kind];
  const response = await api.post('/api/admin/restore', { data: { kind, expectedRevision } });
  expect(response.ok(), await response.text()).toBe(true);
}
