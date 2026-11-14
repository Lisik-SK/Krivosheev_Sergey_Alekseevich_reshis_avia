/** Завершает замену резерва только после публикации соответствующего текущего CSV. */
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { dataFileDigest, dataFileName, dataFileVersionKey, readDataFileIfPresent, writeDataFile } from './data-file.js';

/** Байты и безопасное имя одной версии CSV; объект не владеет открытым дескриптором. */
interface FileVersion {
  content: Buffer;
  name: string;
}

/** Маркер публикации текущего CSV; хеш байтов и имя резерва отсутствуют в журналах старого формата. */
interface BackupTransaction {
  key: string;
  digest?: string;
  name?: string;
  replacesInvalidPreparation?: boolean;
}

/** Ошибка целостности подготовленного резерва, отличная от временных ошибок ввода-вывода. */
export class InvalidBackupPreparationError extends Error {
  /**
   * Создаёт ошибку повреждённой операции подготовки резерва.
   * @param message Обязательное описание повреждения для диагностики.
   * @param cause Необязательная исходная ошибка, по умолчанию отсутствует.
   * @remarks Возвращает объект ошибки; не выполняет запись или ввод-вывод и не выбрасывает исключений.
   */
  constructor(message: string, cause?: unknown) {
    super(message, { cause });
    this.name = 'InvalidBackupPreparationError';
  }
}

/**
 * Готовит резервную копию для ещё не опубликованной версии.
 * @param file Обязательный путь к текущему CSV.
 * @param key Точный ключ подготовленного нового CSV.
 * @param previous Байты и имя исправной текущей версии для сохранения в резерве.
 * @param replacesInvalidPreparation Необязательное разрешение заменить повреждённый журнал при явно
 * подтверждённой новой загрузке. По умолчанию false.
 * @returns void после записи подготовленного резерва и маркера операции.
 * @remarks Синхронно пишет подготовленный резерв, затем атомарно публикует маркер с его
 * контрольной суммой и именем. Прежний .bak не меняет. Требует единственного процесса записи
 * и отсутствия прежней незавершённой операции, кроме явно разрешённого восстановления.
 * Ошибки записи распространяются.
 */
export function stageBackup(file: string, key: string, previous: FileVersion, replacesInvalidPreparation = false): void {
  writeDataFile(`${file}.bak.pending`, previous.content, previous.name, path.basename(file));
  publishTransaction(`${file}.bak.transaction`, {
    key, digest: dataFileDigest(previous.content), name: previous.name, replacesInvalidPreparation,
  });
}

/**
 * Публикует журнал из полностью записанного временного файла.
 * @param journal Путь к маркеру операции рядом с текущим CSV; при восстановлении допускается прежний маркер.
 * @param transaction Ключ готового CSV и метаданные подготовленного резерва.
 * @returns void после атомарной публикации журнала.
 * @remarks Синхронно пишет диск, очищает временный файл по возможности. Ошибки подготовки
 * или публикации распространяются; недописанный журнал не становится активным.
 */
function publishTransaction(journal: string, transaction: BackupTransaction): void {
  const staged = `${journal}.${randomUUID()}.tmp`;
  try {
    fs.writeFileSync(staged, JSON.stringify(transaction), { flag: 'wx', flush: true });
    fs.renameSync(staged, journal);
  } finally {
    try { fs.rmSync(staged, { force: true }); } catch { /* Ошибка уборки не подменяет результат записи. */ }
  }
}

/**
 * Читает маркер в текущем формате или в прежнем формате с одним ключом версии.
 * @param journal Путь к маркеру операции рядом с текущим CSV.
 * @returns Метаданные операции, либо undefined, если маркер отсутствует.
 * @throws {InvalidBackupPreparationError} При повреждении формата журнала.
 * @throws При ошибке чтения, отличной от ENOENT.
 * @remarks Синхронно читает диск, не меняет файлы и не открывает CSV.
 */
function readTransaction(journal: string): BackupTransaction | undefined {
  let raw: string;
  try {
    raw = fs.readFileSync(journal, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    return undefined;
  }
  const keyFormat = /^-?\d+:-?\d+:-?\d+:-?\d+$/;
  if (keyFormat.test(raw)) return { key: raw };
  let transaction: Partial<BackupTransaction> | null;
  try {
    transaction = JSON.parse(raw) as Partial<BackupTransaction> | null;
  } catch (error) {
    throw new InvalidBackupPreparationError('Повреждён журнал резервной копии CSV', error);
  }
  if (!transaction || typeof transaction.key !== 'string' || !keyFormat.test(transaction.key) ||
      typeof transaction.name !== 'string' ||
      typeof transaction.digest !== 'string' || !/^sha256:[0-9a-f]{64}$/.test(transaction.digest) ||
      (transaction.replacesInvalidPreparation !== undefined && typeof transaction.replacesInvalidPreparation !== 'boolean')) {
    throw new InvalidBackupPreparationError('Повреждён журнал резервной копии CSV');
  }
  return transaction as BackupTransaction;
}

/**
 * Публикует только подтверждённый подготовленный резерв для текущего CSV.
 * @param file Путь к текущему CSV, версия которого уже совпала с ключом журнала.
 * @param pending Путь к подготовленной резервной копии.
 * @param transaction Метаданные связанной операции; прежний формат не содержит контрольной суммы.
 * @returns void после закрытия подготовленных файлов и публикации резерва.
 * @throws {InvalidBackupPreparationError} При отсутствии или повреждении подготовленной копии.
 * @throws При ошибке диска; при любом исключении маркер сохраняется.
 * @remarks Синхронно читает и пишет диск. Прежний резерв сохраняется при неверной контрольной сумме.
 */
function publishPendingBackup(file: string, pending: string, transaction: BackupTransaction): void {
  const previous = readDataFileIfPresent(pending);
  if (!previous) throw new InvalidBackupPreparationError('Подготовленная резервная копия CSV отсутствует');
  if (transaction.digest !== undefined && dataFileDigest(previous.content) !== transaction.digest) {
    throw new InvalidBackupPreparationError('Подготовленная резервная копия CSV повреждена');
  }
  const fallback = path.basename(file);
  const name = transaction.name ?? dataFileName(pending, previous.stat, previous.content, fallback);
  writeDataFile(`${file}.bak`, previous.content, name, fallback);
}

/**
 * Завершает прерванную замену резерва или отменяет подготовку, если текущий файл не был опубликован.
 * @param file Обязательный путь к текущему CSV.
 * @returns void; без маркера ничего не делает.
 * @remarks Синхронно читает маркер и статистику текущего CSV. При совпадении ключа
 * проверяет готовую копию и атомарно публикует .bak. Если ключ не совпал, сохраняет существующий .bak
 * и отменяет подготовку. Если от неё зависело восстановление повреждённой операции, сохраняет
 * маркер и сообщает об ошибке целостности, чтобы старый .bak по-прежнему нельзя было применить.
 * Удаляет маркер после завершения; при утрате подготовленной копии или сбое записи маркер
 * остаётся, чтобы операция не подменила предшествующий резерв более старым.
 * Остальные ошибки чтения и записи распространяются. Временные файлы убираются по возможности.
 */
export function finishBackup(file: string): void {
  const journal = `${file}.bak.transaction`;
  const transaction = readTransaction(journal);
  if (!transaction) return;

  const pending = `${file}.bak.pending`;
  const stat = fs.statSync(file, { bigint: true, throwIfNoEntry: false });
  if (stat && dataFileVersionKey(stat) === transaction.key) {
    publishPendingBackup(file, pending, transaction);
  } else if (transaction.replacesInvalidPreparation) {
    throw new InvalidBackupPreparationError('Восстановление резерва CSV остановилось до публикации текущей версии');
  }
  fs.unlinkSync(journal);
  for (const temporary of [pending, `${pending}.names.json`]) {
    try { fs.rmSync(temporary, { force: true }); } catch { /* Резерв уже определён, остатки подготовки не используются. */ }
  }
}
