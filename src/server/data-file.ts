/** Связывает имя загруженного CSV с конкретной версией файла на диске. */
import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';

/** Асинхронно читает байты из обязательного открытого дескриптора; при ошибке отклоняет Promise, дескриптор не закрывает. */
const readDescriptor = promisify(fs.readFile);

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
 * @param content Байты той же версии для поиска имени после переноса CSV.
 * @param fallback Имя настроенного CSV без суффикса резервной копии.
 * @returns Безопасное имя файла для интерфейса или заголовка скачивания.
 * @remarks Синхронно читает метаданные; ошибки чтения метаданных заменяет именем по умолчанию.
 */
export function dataFileName(file: string, stat: fs.BigIntStats, content: Buffer, fallback: string): string {
  return resolveName(readNames(file), stat, content, fallback);
}

/**
 * Формирует переносимый ключ из обязательных байтов CSV. Возвращает SHA-256 с префиксом;
 * не обращается к диску, не меняет вход и не имеет ожидаемых ошибок.
 */
function digestKey(content: Buffer): string {
  return `sha256:${createHash('sha256').update(content).digest('hex')}`;
}

/**
 * Ищет имя версии в обязательном объекте метаданных по статистике или байтам того же CSV.
 * @param names Метаданные одного пути, допускается пустой объект и старый формат без хешей.
 * @param stat Статистика открытой версии.
 * @param content Байты открытой версии.
 * @param fallback Настроенное имя на случай отсутствия совпадения.
 * @returns Безопасное имя; приоритет у точного совпадения статистики.
 * @remarks Не выполняет ввод-вывод и не имеет ожидаемых ошибок.
 */
function resolveName(names: Record<string, unknown>, stat: fs.BigIntStats, content: Buffer, fallback: string): string {
  return csvFilename(names[dataFileVersionKey(stat)] ?? names[digestKey(content)], fallback);
}

/**
 * Читает байты и статистику одного открытого CSV.
 * @param file Обязательный путь к файлу.
 * @returns Байты и статистика одного дескриптора.
 * @remarks Читает диск синхронно, закрывает дескриптор при любом исходе, ошибки распространяются.
 */
export function readDataFile(file: string): { content: Buffer; stat: fs.BigIntStats } {
  const fd = fs.openSync(file, 'r');
  try {
    return { content: fs.readFileSync(fd), stat: fs.fstatSync(fd, { bigint: true }) };
  } finally {
    fs.closeSync(fd);
  }
}

/**
 * Читает CSV или подтверждает его отсутствие.
 * @param file Обязательный путь к файлу.
 * @returns Байты и статистика, либо undefined только при ENOENT.
 * @remarks Остальные ошибки синхронного чтения распространяются; диск не меняет.
 */
export function readDataFileIfPresent(file: string): ReturnType<typeof readDataFile> | undefined {
  try {
    return readDataFile(file);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    return undefined;
  }
}

/**
 * Читает актуальные байты и имя для скачивания.
 * @param file Обязательный путь к текущему CSV.
 * @param fallback Настроенное имя CSV при отсутствии метаданных.
 * @returns Promise с байтами и именем одной версии.
 * @remarks Открывает дескриптор и читает метаданные до первого ожидания, затем асинхронно
 * читает байты через тот же дескриптор и закрывает его. Ошибки чтения CSV отклоняют Promise.
 */
export async function downloadDataFile(file: string, fallback: string): Promise<{ content: Buffer; name: string }> {
  const fd = fs.openSync(file, 'r');
  try {
    const stat = fs.fstatSync(fd, { bigint: true });
    const names = readNames(file);
    const content = await readDescriptor(fd);
    return { content, name: resolveName(names, stat, content, fallback) };
  } finally {
    fs.closeSync(fd);
  }
}

/**
 * Переносит имя CSV в метаданные по хешу, если версия достоверно совпала по точному ключу.
 * @param file Обязательный путь к текущему CSV или резерву.
 * @returns void; ничего не меняет, если файл отсутствует, имя неизвестно или метаданные актуальны.
 * @remarks Читает версию и метаданные, синхронно заменяет только JSON рядом с CSV.
 * Исправляет старый формат и прерванное уточнение имени; ошибки ввода-вывода распространяются.
 */
export function repairPortableName(file: string): void {
  const version = readDataFileIfPresent(file);
  if (!version) return;
  const names = readNames(file);
  const key = dataFileVersionKey(version.stat);
  const name = names[key];
  if (typeof name !== 'string') return;
  const digest = digestKey(version.content);
  if (names[digest] === name) return;
  names[digest] = name;
  const namesPath = `${file}.names.json`;
  const staged = `${namesPath}.${randomUUID()}.tmp`;
  try {
    fs.writeFileSync(staged, JSON.stringify(names), { flag: 'wx' });
    fs.renameSync(staged, namesPath);
  } finally {
    try { fs.rmSync(staged, { force: true }); } catch { /* Ошибка уборки не подменяет результат записи. */ }
  }
}

/**
 * Публикует CSV и его имя для единственного процесса записи.
 * @param file Обязательный путь CSV или копии.
 * @param content Обязательные байты новой версии.
 * @param name Безопасное имя новой версии.
 * @param fallback Настроенное имя при отсутствии метаданных.
 * @param beforePublish Необязательная подготовка резерва; получает точный ключ новой версии до замены CSV.
 * @returns void после замены CSV и обновления переносимых метаданных, если это возможно.
 * @remarks Пишет временные файлы рядом с целевыми. До замены CSV метаданные сохраняют имена обеих версий;
 * при одинаковых байтах до замены переносимым остаётся старое имя. Ошибки до замены распространяются.
 * Ошибка уточнения переносимого имени после замены не отменяет публикацию: точный ключ уже записан.
 */
export function writeDataFile(file: string, content: Buffer, name: string, fallback: string, beforePublish?: (key: string) => void): void {
  const suffix = `.${randomUUID()}.tmp`;
  const staged = `${file}${suffix}`;
  const namesPath = `${file}.names.json`;
  const stagedNames = `${namesPath}${suffix}`;
  try {
    fs.writeFileSync(staged, content, { flag: 'wx' });
    const previous = readDataFileIfPresent(file);
    const key = dataFileVersionKey(fs.statSync(staged, { bigint: true }));
    const digest = digestKey(content);
    const names: Record<string, string> = { [key]: name, [digest]: name };
    if (previous) {
      const previousName = dataFileName(file, previous.stat, previous.content, fallback);
      names[dataFileVersionKey(previous.stat)] = previousName;
      names[digestKey(previous.content)] = previousName;
    }
    fs.writeFileSync(stagedNames, JSON.stringify(names), { flag: 'wx' });
    fs.renameSync(stagedNames, namesPath);
    beforePublish?.(key);
    fs.renameSync(staged, file);
    if (names[digest] !== name) {
      try {
        fs.writeFileSync(stagedNames, JSON.stringify({ [key]: name, [digest]: name }), { flag: 'wx' });
        fs.renameSync(stagedNames, namesPath);
      } catch { /* Точный ключ новой версии уже доступен. */ }
    }
  } finally {
    for (const temporary of [staged, stagedNames]) {
      try { fs.rmSync(temporary, { force: true }); } catch { /* Ошибка уборки не подменяет результат записи. */ }
    }
  }
}
