/** Завершает замену резерва только после публикации соответствующего текущего CSV. */
import fs from 'node:fs';
import path from 'node:path';
import { dataFileName, dataFileVersionKey, readDataFileIfPresent, writeDataFile } from './data-file.js';

/** Байты и безопасное имя одной версии CSV; объект не владеет открытым дескриптором. */
interface FileVersion {
  content: Buffer;
  name: string;
}

/**
 * Готовит резервную копию для ещё не опубликованной версии.
 * @param file Обязательный путь к текущему CSV.
 * @param key Точный ключ подготовленного нового CSV.
 * @param previous Байты и имя исправной текущей версии для сохранения в резерве.
 * @returns void после записи подготовленного резерва и маркера операции.
 * @remarks Синхронно пишет рядом с текущим файлом; прежний .bak остаётся на месте.
 * Требует единственного процесса записи и завершения прежней операции; ошибки записи распространяются.
 */
export function stageBackup(file: string, key: string, previous: FileVersion): void {
  writeDataFile(`${file}.bak.pending`, previous.content, previous.name, path.basename(file));
  fs.writeFileSync(`${file}.bak.transaction`, key, { flag: 'wx' });
}

/**
 * Завершает прерванную замену резерва или отменяет подготовку, если текущий файл не был опубликован.
 * @param file Обязательный путь к текущему CSV.
 * @returns void; без маркера ничего не делает.
 * @remarks Синхронно читает маркер и статистику текущего CSV. При совпадении ключа
 * атомарно публикует подготовленный .bak. Если ключ не совпал или подготовленный файл
 * уже отсутствует, сохраняет существующий .bak.
 * Удаляет маркер после завершения; при сбое записи маркер остаётся для повтора.
 * Остальные ошибки чтения и записи распространяются. Временные файлы убираются по возможности.
 */
export function finishBackup(file: string): void {
  const journal = `${file}.bak.transaction`;
  let key: string;
  try {
    key = fs.readFileSync(journal, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    return;
  }
  const pending = `${file}.bak.pending`;
  const stat = fs.statSync(file, { bigint: true, throwIfNoEntry: false });
  if (stat && dataFileVersionKey(stat) === key) {
    const previous = readDataFileIfPresent(pending);
    const fallback = path.basename(file);
    if (previous) {
      writeDataFile(`${file}.bak`, previous.content, dataFileName(pending, previous.stat, previous.content, fallback), fallback);
    }
  }
  fs.unlinkSync(journal);
  for (const temporary of [pending, `${pending}.names.json`]) {
    try { fs.rmSync(temporary, { force: true }); } catch { /* Резерв уже определён, остатки подготовки не используются. */ }
  }
}
