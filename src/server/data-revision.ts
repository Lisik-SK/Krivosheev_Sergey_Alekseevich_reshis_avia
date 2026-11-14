/** Связывает подтверждение администратора с файлами, которые были ему показаны. */
import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import { dataFileVersionKey } from './data-file.js';
import { HttpError } from './http.js';

/** Случайная метка процесса, чтобы подтверждения истекали при перезапуске. */
const processRevision = randomUUID();

/**
 * Определяет состояние файла по статистике, включая запись поверх существующего CSV.
 * @param file Обязательный путь к файлу данных или резерва.
 * @returns Метку файла либо код ошибки доступа, включая отсутствие файла.
 * @remarks Синхронно читает статистику с диска. Не читает содержимое и не меняет файлы.
 */
export function fileRevision(file: string): string {
  try {
    const stat = fs.statSync(file, { bigint: true });
    return `${dataFileVersionKey(stat)}:${stat.ctimeNs}`;
  } catch (error) {
    return `error:${(error as NodeJS.ErrnoException).code ?? 'unknown'}`;
  }
}

/**
 * Вычисляет ревизию предпросмотра по обоим текущим CSV и показанному кандидату.
 * @param current Обязательная метка состояний обоих текущих файлов.
 * @param kind Обязательный тип кандидата: forecast или routes.
 * @param filename Имя из запроса, либо undefined для настроенного имени.
 * @param content Обязательный полный текст проверяемого CSV.
 * @returns SHA-256 в шестнадцатеричной записи. Не выполняет ввод-вывод и не меняет входные данные.
 */
export function uploadRevision(current: string, kind: string, filename: string | undefined, content: string): string {
  return createHash('sha256')
    .update(JSON.stringify([processRevision, current, kind, filename]))
    .update(content)
    .digest('hex');
}

/**
 * Вычисляет ревизию отката для указанного файла и состояния его резерва.
 * @param current Обязательная метка обоих текущих CSV.
 * @param target Обязательный путь к активному CSV, от которого выводятся пути файлов резерва.
 * @returns SHA-256 в шестнадцатеричной записи, меняется при обновлении текущего или резервного файла.
 * @remarks Синхронно читает статистику файлов; отсутствие части резерва учитывается в ревизии.
 */
export function restoreRevision(current: string, target: string): string {
  const backup = fileRevision(`${target}.bak`);
  const journal = fileRevision(`${target}.bak.transaction`);
  const pending = fileRevision(`${target}.bak.pending`);
  return createHash('sha256').update(JSON.stringify([processRevision, current, target, backup, journal, pending])).digest('hex');
}

/**
 * Требует, чтобы запрос подтвердил именно ожидаемую ревизию.
 * @param expected Непроверенное значение запроса; допустима строка из 64 шестнадцатеричных символов.
 * @param actual Обязательная ревизия, вычисленная сервером.
 * @throws HttpError 428 без корректного подтверждения или 409 при расхождении ревизий.
 * @returns Ничего при совпадении. Не меняет состояние и не выполняет ввод-вывод.
 */
export function requireRevision(expected: unknown, actual: string): void {
  if (typeof expected !== 'string' || !/^[0-9a-f]{64}$/.test(expected)) {
    throw new HttpError(428, 'data_revision_required');
  }
  if (expected !== actual) throw new HttpError(409, 'data_revision_conflict');
}
