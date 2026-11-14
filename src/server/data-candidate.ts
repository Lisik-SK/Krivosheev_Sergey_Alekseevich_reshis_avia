/** Проверяет один заменяемый CSV вместе с тем, который останется на диске. */
import { buildSnapshot, type DataKind, type DatasetSnapshot, type DataStore } from './dataStore.js';

/**
 * Строит снимок для проверки предпросмотра, применения и отката.
 * @param store Обязательное хранилище с путями к двум CSV.
 * @param kind Обязательный тип заменяемого файла: forecast или routes.
 * @param content Обязательный текст кандидата.
 * @param filename Необязательное имя кандидата; без него в метаданных используется тип файла.
 * @param current Текущий снимок либо null, если его не удалось загрузить.
 * @returns Снимок с замечаниями. Версия 0 обозначает неопубликованное состояние.
 * @remarks Синхронно читает второй CSV. Ошибки чтения и разбора распространяются; состояние не меняется.
 */
export function buildDataCandidate(
  store: DataStore, kind: DataKind, content: string, filename: string | undefined, current: DatasetSnapshot | null,
): DatasetSnapshot {
  const replacement = { name: filename ?? kind, size: Buffer.byteLength(content), modifiedAt: new Date().toISOString() };
  const routes = kind === 'routes' ? content : store.readCurrentText('routes');
  const forecast = kind === 'forecast' ? content : store.readCurrentText('forecast');
  return buildSnapshot(routes, forecast, {
    version: 0,
    replacingRoutes: kind === 'routes',
    source: {
      forecast: kind === 'forecast' ? replacement : (current?.source.forecast ?? store.fileInfoOrEmpty('forecast')),
      routes: kind === 'routes' ? replacement : (current?.source.routes ?? store.fileInfoOrEmpty('routes')),
    },
  });
}
