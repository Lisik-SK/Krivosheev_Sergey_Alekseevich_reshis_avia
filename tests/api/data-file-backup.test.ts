/** Проверяет журнал резервной копии на отдельном временном каталоге. */
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { finishBackup, InvalidBackupPreparationError, stageBackup } from '../../src/server/data-file-backup';
import { dataFileVersionKey, downloadDataFile, writeDataFile } from '../../src/server/data-file';
import { makeTempDir } from './helpers';

describe('Подготовка и восстановление резервного CSV', () => {
  let dir: string;
  let current: string;
  let backup: string;
  let pending: string;
  let journal: string;

  beforeEach(() => {
    dir = makeTempDir('csv-backup');
    current = path.join(dir, 'routes.csv');
    backup = `${current}.bak`;
    pending = `${backup}.pending`;
    journal = `${backup}.transaction`;
    writeDataFile(current, Buffer.from('Текущая версия'), 'current.csv', 'routes.csv');
    writeDataFile(backup, Buffer.from('Версия из резерва'), 'older.csv', 'routes.csv');
  });

  afterEach(() => {
    vi.restoreAllMocks();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  /**
   * Публикует новый CSV с резервом в тестовом каталоге, имитируя остановку до завершения журнала.
   * Ничего не возвращает и распространяет ошибки записи.
   */
  function publishWithPendingBackup(): void {
    writeDataFile(current, Buffer.from('Новая версия'), 'new.csv', 'routes.csv', (key) => {
      stageBackup(current, key, { content: Buffer.from('Текущая версия'), name: 'current.csv' });
    });
  }

  it('завершает прерванное создание резерва, сохраняя имя и содержимое', async () => {
    publishWithPendingBackup();
    expect(await downloadDataFile(backup, 'routes.csv')).toEqual({
      content: Buffer.from('Версия из резерва'), name: 'older.csv',
    });

    finishBackup(current);
    finishBackup(current);

    expect(await downloadDataFile(backup, 'routes.csv')).toEqual({
      content: Buffer.from('Текущая версия'), name: 'current.csv',
    });
    expect(fs.existsSync(journal)).toBe(false);
    expect(fs.existsSync(pending)).toBe(false);
  });

  it('читает прежний формат журнала после обновления приложения', async () => {
    publishWithPendingBackup();
    fs.writeFileSync(journal, dataFileVersionKey(fs.statSync(current, { bigint: true })));

    finishBackup(current);

    expect(fs.existsSync(journal)).toBe(false);
    expect(await downloadDataFile(backup, 'routes.csv')).toEqual({
      content: Buffer.from('Текущая версия'), name: 'current.csv',
    });
  });

  it.each(['missing', 'corrupt'])('сохраняет прежний резерв при потере подготовленной версии (%s)', async (damage) => {
    publishWithPendingBackup();
    if (damage === 'missing') fs.unlinkSync(pending);
    else fs.writeFileSync(pending, 'Неполная копия');

    expect(() => finishBackup(current)).toThrow(InvalidBackupPreparationError);
    expect(fs.existsSync(journal)).toBe(true);
    expect(await downloadDataFile(backup, 'routes.csv')).toEqual({
      content: Buffer.from('Версия из резерва'), name: 'older.csv',
    });
    expect(await downloadDataFile(current, 'routes.csv')).toEqual({
      content: Buffer.from('Новая версия'), name: 'new.csv',
    });
  });

  it('не публикует частично записанный журнал при сбое записи', async () => {
    const write = fs.writeFileSync;
    const failure = vi.spyOn(fs, 'writeFileSync').mockImplementation((file, content, options) => {
      if (typeof file === 'string' && file.startsWith(journal)) {
        write(file, 'Частичный журнал', options);
        throw new Error('ENOSPC');
      }
      write(file, content, options);
    });

    expect(() => publishWithPendingBackup()).toThrow('ENOSPC');
    failure.mockRestore();

    expect(fs.existsSync(journal)).toBe(false);
    expect(await downloadDataFile(current, 'routes.csv')).toEqual({
      content: Buffer.from('Текущая версия'), name: 'current.csv',
    });
    expect(await downloadDataFile(backup, 'routes.csv')).toEqual({
      content: Buffer.from('Версия из резерва'), name: 'older.csv',
    });
    publishWithPendingBackup();
    finishBackup(current);
    expect(await downloadDataFile(backup, 'routes.csv')).toEqual({
      content: Buffer.from('Текущая версия'), name: 'current.csv',
    });
  });

  it('повторная ошибка записи не открывает устаревший резерв, следующая загрузка восстанавливает откат', async () => {
    fs.writeFileSync(journal, '{"key":');
    expect(() => finishBackup(current)).toThrow(InvalidBackupPreparationError);

    /**
     * Имитирует явно подтверждённую новую загрузку при повреждённом журнале.
     * Ничего не возвращает, пишет новый текущий CSV и передаёт ошибки вызывающему коду.
     */
    const repairByUpload = () => writeDataFile(current, Buffer.from('Новая версия'), 'new.csv', 'routes.csv', (key) => {
      stageBackup(current, key, { content: Buffer.from('Текущая версия'), name: 'current.csv' }, true);
    });
    const rename = fs.renameSync;
    const failure = vi.spyOn(fs, 'renameSync').mockImplementation((source, target) => {
      if (target === current) throw new Error('EBUSY');
      rename(source, target);
    });

    expect(repairByUpload).toThrow('EBUSY');
    failure.mockRestore();
    expect(() => finishBackup(current)).toThrow(InvalidBackupPreparationError);
    expect(await downloadDataFile(backup, 'routes.csv')).toEqual({
      content: Buffer.from('Версия из резерва'), name: 'older.csv',
    });
    expect(await downloadDataFile(current, 'routes.csv')).toEqual({
      content: Buffer.from('Текущая версия'), name: 'current.csv',
    });

    repairByUpload();
    finishBackup(current);
    expect(fs.existsSync(journal)).toBe(false);
    expect(await downloadDataFile(backup, 'routes.csv')).toEqual({
      content: Buffer.from('Текущая версия'), name: 'current.csv',
    });
    expect(await downloadDataFile(current, 'routes.csv')).toEqual({
      content: Buffer.from('Новая версия'), name: 'new.csv',
    });
  });

  it('не считает временную блокировку подготовленной копии её повреждением', async () => {
    publishWithPendingBackup();
    const error = Object.assign(new Error('EBUSY'), { code: 'EBUSY' });
    const open = fs.openSync;
    const failure = vi.spyOn(fs, 'openSync').mockImplementation((file, flags, mode) => {
      if (file === pending) throw error;
      return open(file, flags, mode);
    });

    expect(() => finishBackup(current)).toThrow(error);
    expect(() => finishBackup(current)).not.toThrow(InvalidBackupPreparationError);
    failure.mockRestore();
    expect(fs.existsSync(journal)).toBe(true);

    finishBackup(current);
    expect(await downloadDataFile(backup, 'routes.csv')).toEqual({
      content: Buffer.from('Текущая версия'), name: 'current.csv',
    });
  });
});
