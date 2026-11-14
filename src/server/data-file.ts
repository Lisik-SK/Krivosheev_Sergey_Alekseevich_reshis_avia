/** Связывает имя загруженного CSV с конкретной версией файла на диске. */
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

/**
 * Приводит переданное имя к безопасному имени файла для интерфейса и скачивания.
 * @param value Необязательное имя из запроса или метаданных, может иметь произвольный тип.
 * @param fallback Имя настроенного файла для пустого или непригодного значения.
 * @returns Последний компонент имени без управляющих и недопустимых в Windows символов.
 * @remarks Не использует это имя как путь, не выполняет ввод-вывод.
 */
export function csvFilename(value: unknown, fallback: string): string {
  if (typeof value !== 'string') return fallback;
  const name = path.win32.basename(value)
    .replace(/[\u0000-\u001f\u007f-\u009f\uD800-\uDFFF<>:"|?*]/gu, '_')
    .trim().replace(/[. ]+$/, '');
  return name ? [...name].slice(0, 255).join('') : fallback;
}

/**
 * Строит ключ версии по статистике открытого или ещё не переименованного файла.
 * @param stat Обязательная статистика файла в формате bigint.
 * @returns Ключ, сохраняющийся при переименовании и различающий версии с одинаковым содержимым.
 * @remarks Чистая функция без записи, запросов и ожидаемых ошибок.
 */
export function dataFileVersionKey(stat: fs.BigIntStats): string {
  return `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeNs}`;
}

/**
 * Читает сопутствующие имена для версий CSV.
 * @param file Обязательный путь к настроенному CSV или его резервной копии.
 * @returns Объект имён или пустой объект при отсутствии, повреждении или ошибке чтения метаданных.
 * @remarks Синхронно читает диск, не меняет файлов.
 */
function readNames(file: string): Record<string, unknown> {
  try {
    const names: unknown = JSON.parse(fs.readFileSync(`${file}.names.json`, 'utf8'));
    if (names && typeof names === 'object' && !Array.isArray(names)) return names as Record<string, unknown>;
  } catch {
    // Файлы старых версий и вручную заменённые CSV доступны под настроенным именем.
  }
  return {};
}

/**
 * Возвращает имя версии CSV или настроенное имя при отсутствии совпадения.
 * @param file Обязательный путь к CSV или резервной копии.
 * @param stat Обязательная статистика именно той версии CSV, для которой нужно имя.
 * @param fallback Имя настроенного CSV без суффикса резервной копии.
 * @returns Безопасное имя файла для интерфейса или заголовка скачивания.
 * @remarks Синхронно читает метаданные; ошибки чтения метаданных заменяет именем по умолчанию.
 */
export function dataFileName(file: string, stat: fs.BigIntStats, fallback: string): string {
  return csvFilename(readNames(file)[dataFileVersionKey(stat)], fallback);
}

/**
 * Публикует подготовленный CSV и имя его версии.
 * @param file Обязательный целевой путь CSV или резервной копии.
 * @param content Обязательные байты CSV, включая необязательный BOM.
 * @param name Обязательное безопасное имя публикуемой версии.
 * @param fallback Настроенное имя CSV для ранее существовавшей версии без метаданных.
 * @param beforePublish Необязательная синхронная подготовка перед заменой CSV, по умолчанию отсутствует.
 * @returns void после переименования подготовленного файла в целевой.
 * @remarks Синхронно готовит CSV и метаданные рядом с целью. Сначала публикует метаданные,
 * в которых учтены обе версии, затем атомарно меняет CSV. При сбое второго переименования
 * прежний CSV сохраняет имя. Ошибки подготовки и записи распространяются, временные файлы удаляются по возможности.
 */
export function writeDataFile(file: string, content: Buffer, name: string, fallback: string, beforePublish?: () => void): void {
  const suffix = `.${randomUUID()}.tmp`;
  const staged = `${file}${suffix}`;
  const namesPath = `${file}.names.json`;
  const stagedNames = `${namesPath}${suffix}`;
  try {
    fs.writeFileSync(staged, content, { flag: 'wx' });
    const previous = fs.statSync(file, { bigint: true, throwIfNoEntry: false });
    const names: Record<string, string> = {};
    if (previous) names[dataFileVersionKey(previous)] = dataFileName(file, previous, fallback);
    names[dataFileVersionKey(fs.statSync(staged, { bigint: true }))] = name;
    fs.writeFileSync(stagedNames, JSON.stringify(names), { flag: 'wx' });
    fs.renameSync(stagedNames, namesPath);
    beforePublish?.();
    fs.renameSync(staged, file);
  } finally {
    for (const temporary of [staged, stagedNames]) {
      try { fs.rmSync(temporary, { force: true }); } catch { /* Ошибка уборки не подменяет результат записи. */ }
    }
  }
}
