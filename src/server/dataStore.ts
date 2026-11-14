/**
 * Хранилище прогноза в памяти с «горячей» заменой файлов.
 *
 * При запросах (не чаще checkIntervalMs) сервер сверяет время изменения и размер
 * CSV-файлов. Если файл заменили, данные перечитываются без перезапуска. Если новый
 * файл с ошибкой, продолжаем работать на последней корректной версии и показываем
 * ошибку в /api/health и в интерфейсе.
 */
import fs from 'node:fs';
import path from 'node:path';
import { csvFilename, dataFileName, dataFileVersionKey, downloadDataFile, readDataFile, readDataFileIfPresent, repairPortableName, writeDataFile } from './data-file.js';
import { finishBackup, stageBackup } from './data-file-backup.js';
import { parseForecastCsv, parseRoutesCsv, type FlightForecast, type RouteInfo } from '../shared/dataset.js';
import { LocalizedError, render, type Lang, type Localizable } from '../shared/messages.js';

/** Выбирает CSV прогноза или справочника маршрутов. */
type DataKind = 'forecast' | 'routes';

export interface DatasetSnapshot {
  routes: RouteInfo[];
  routeByCode: Map<string, RouteInfo>;
  flights: Map<string, FlightForecast>;
  /** Даты по маршрутам, по возрастанию. */
  datesByRoute: Map<string, string[]>;
  quantileLevels: number[];
  warnings: Localizable[];
  loadedAt: string;
  version: number;
  source: { forecast: FileInfo; routes: FileInfo };
}

export interface FileInfo {
  name: string;
  size: number;
  modifiedAt: string;
}

export interface DataStatus {
  ok: boolean;
  /** Ошибка последней попытки загрузки (данные при этом могут быть от прошлой версии). */
  error: LoadError | null;
  snapshot: DatasetSnapshot | null;
}

/** Ошибка загрузки, которую можно показать на любом языке. */
export interface LoadError {
  text(lang: Lang): string;
}

export function toLoadError(err: unknown): LoadError {
  if (err instanceof LocalizedError) return { text: (lang) => err.localize(lang) };
  const message = err instanceof Error ? err.message : String(err);
  return { text: () => message };
}

/** Читает идентификатор версии по пути к CSV. Возвращает строку или 'missing' при ошибке stat. Диск не меняет. */
function signature(file: string): string {
  try {
    const st = fs.statSync(file, { bigint: true });
    return dataFileVersionKey(st);
  } catch {
    return 'missing';
  }
}

/**
 * Собирает метаданные одной открытой версии CSV.
 * @param file Обязательный путь для поиска имени и выбора стандартного имени.
 * @param version Обязательные байты и статистика того же файла.
 * @returns Имя, размер и дата изменения версии.
 * @remarks Синхронно читает метаданные имени с диска, при ошибке чтения использует имя по умолчанию. Записей нет.
 */
function fileInfo(file: string, { stat, content }: ReturnType<typeof readDataFile>): FileInfo {
  return { name: dataFileName(file, stat, content, path.basename(file)), size: content.length, modifiedAt: stat.mtime.toISOString() };
}

/**
 * Проверяет обязательные байты CSV независимо от второго файла.
 * @param kind Тип CSV, определяет парсер.
 * @param content Полные байты CSV в UTF-8.
 * @returns void для CSV, который можно разобрать, включая файлы с предупреждениями.
 * @remarks Ошибки разбора распространяются. Не меняет файлы и состояние хранилища.
 */
export function validateDataFile(kind: DataKind, content: Buffer): void {
  if (kind === 'forecast') parseForecastCsv(content.toString('utf8'));
  else parseRoutesCsv(content.toString('utf8'));
}

/**
 * Проверяет пригодность текущей версии для резерва.
 * @param kind Тип CSV, определяет парсер.
 * @param content Обязательные байты текущего CSV.
 * @returns true для читаемого CSV; при ошибке разбора возвращает false.
 * @remarks Работает в памяти, не меняет данные и не пишет на диск.
 */
function canBackUp(kind: DataKind, content: Buffer): boolean {
  try {
    validateDataFile(kind, content);
    return true;
  } catch {
    return false;
  }
}

export function flightKey(route: string, date: string): string {
  return `${route}|${date}`;
}

/**
 * Собирает снимок данных и замечания по двум CSV.
 * @param routesText Обязательный текст справочника маршрутов.
 * @param forecastText Обязательный текст прогноза.
 * @param meta Обязательная версия снимка и метаданные обоих файлов. Необязательный флаг
 * replacingRoutes меняет замечания при проверке замены справочника; по умолчанию false.
 * @returns Новый снимок с рейсами, найденными в справочнике, и локализуемыми замечаниями.
 * @remarks Читает переданные значения без записи и сетевых запросов. Ошибки разбора CSV распространяются.
 */
export function buildSnapshot(
  routesText: string,
  forecastText: string,
  meta: { version: number; source: { forecast: FileInfo; routes: FileInfo }; replacingRoutes?: boolean },
): DatasetSnapshot {
  const { routes, warnings: routeWarnings } = parseRoutesCsv(routesText);
  const parsed = parseForecastCsv(forecastText);

  const routeByCode = new Map(routes.map((r) => [r.code, r]));
  const flights = new Map<string, FlightForecast>();
  const datesByRoute = new Map<string, string[]>();
  const unknownRoutes = new Set<string>();

  for (const f of parsed.flights) {
    if (!routeByCode.has(f.route)) {
      unknownRoutes.add(f.route);
      continue;
    }
    flights.set(flightKey(f.route, f.date), f);
    const list = datesByRoute.get(f.route) ?? [];
    list.push(f.date);
    datesByRoute.set(f.route, list);
  }
  const warnings: Localizable[] = [...routeWarnings, ...parsed.warnings];
  if (flights.size === 0) {
    warnings.push({ key: meta.replacingRoutes ? 'replacement_routes_no_matches' : 'no_routes_matched' });
  } else if (!meta.replacingRoutes && unknownRoutes.size) {
    warnings.push({ key: 'unknown_routes', params: { list: [...unknownRoutes].sort().join(', ') } });
  }
  for (const list of datesByRoute.values()) list.sort();

  return {
    routes,
    routeByCode,
    flights,
    datesByRoute,
    quantileLevels: parsed.quantileLevels,
    warnings,
    loadedAt: new Date().toISOString(),
    version: meta.version,
    source: meta.source,
  };
}

export class DataStore {
  private snapshot: DatasetSnapshot | null = null;
  private lastError: LoadError | null = null;
  private lastSignature = '';
  private lastCheck = 0;
  private version = 0;

  constructor(
    readonly forecastPath: string,
    readonly routesPath: string,
    private readonly checkIntervalMs = 2000,
    private readonly log: (msg: string, level?: 'info' | 'warn' | 'error') => void = () => {},
  ) {
    this.reload();
  }

  /** Перечитывает файлы, если они изменились (не чаще checkIntervalMs). */
  refreshIfChanged(force = false): void {
    const now = Date.now();
    if (!force && now - this.lastCheck < this.checkIntervalMs) return;
    this.lastCheck = now;
    const sig = signature(this.forecastPath) + '|' + signature(this.routesPath);
    if (sig !== this.lastSignature) this.reload(sig);
  }

  status(): DataStatus {
    this.refreshIfChanged();
    return { ok: this.lastError === null && this.snapshot !== null, error: this.lastError, snapshot: this.snapshot };
  }

  get(): DatasetSnapshot | null {
    this.refreshIfChanged();
    return this.snapshot;
  }

  /** Текущие тексты файлов; отсутствующий или нечитаемый файл — пустая строка. */
  readCurrentTexts(): { forecast: string; routes: string } {
    const safe = (file: string) => {
      try {
        return fs.readFileSync(file, 'utf8');
      } catch {
        return '';
      }
    };
    return { forecast: safe(this.forecastPath), routes: safe(this.routesPath) };
  }

  fileInfoOrEmpty(kind: 'forecast' | 'routes'): FileInfo {
    const file = kind === 'forecast' ? this.forecastPath : this.routesPath;
    try {
      return fileInfo(file, readDataFile(file));
    } catch {
      return { name: path.basename(file), size: 0, modifiedAt: new Date(0).toISOString() };
    }
  }

  /**
   * Возвращает содержимое и имя резервной копии CSV.
   * @param kind Обязательный тип CSV: прогноз или справочник.
   * @returns Байты и имя одной версии файла; старые версии используют настроенное имя.
   * @remarks При чтении резерва сначала завершает прерванную замену, если новый CSV уже опубликован.
   * Синхронно читает байты и имя. Ошибки завершения записи и чтения, включая ENOENT, распространяются.
   */
  readBackup(kind: DataKind): { content: Buffer; name: string } {
    const target = kind === 'forecast' ? this.forecastPath : this.routesPath;
    finishBackup(target);
    const file = `${target}.bak`;
    const { content, stat } = readDataFile(file);
    return { content, name: dataFileName(file, stat, content, path.basename(target)) };
  }

  /**
   * Проверяет наличие резервного файла.
   * @param kind Обязательный тип CSV: прогноз или справочник.
   * @returns true, если .bak существует после завершения прерванной записи, иначе false.
   * @remarks Может завершить запись или очистить временный резерв. Если завершение не удалось,
   * пишет причину в журнал и скрывает действие отката, чтобы не предложить устаревший резерв.
   * Обновляет переносимость имён текущей и резервной версий; сбой обновления только журналируется.
   */
  hasBackup(kind: DataKind): boolean {
    const file = kind === 'forecast' ? this.forecastPath : this.routesPath;
    if (!this.tryFinishBackup(file)) return false;
    const backup = `${file}.bak`;
    for (const version of [file, backup]) {
      try {
        repairPortableName(version);
      } catch (error) {
        this.log(`Не удалось обновить имя CSV (${path.basename(version)}): ${String(error)}`, 'warn');
      }
    }
    return fs.existsSync(backup);
  }

  /**
   * Читает актуальный CSV для скачивания.
   * @param kind Обязательный тип CSV: прогноз или справочник.
   * @returns Promise с байтами и именем одной версии файла.
   * @remarks Синхронно открывает файл и читает метаданные имени, затем асинхронно читает байты
   * через тот же дескриптор, определяет имя и закрывает дескриптор при любом исходе.
   * Файлы не меняет; ошибки открытия, чтения или закрытия отклоняют Promise.
   */
  downloadFile(kind: DataKind): Promise<{ content: Buffer; name: string }> {
    const file = kind === 'forecast' ? this.forecastPath : this.routesPath;
    return downloadDataFile(file, path.basename(file));
  }

  /**
   * Заменяет текущий CSV и сохраняет предыдущие байты и имя в резервной копии.
   * @param kind Обязательный тип CSV: прогноз или справочник.
   * @param content Обязательные байты предварительно проверенного CSV.
   * @param filename Необязательное исходное имя, при отсутствии берётся настроенное имя.
   * @returns void после публикации, перечитывания данных и попытки завершить резерв либо при точном повторе.
   * @remarks Завершает незакрытую операцию, затем читает текущий CSV. При одинаковом имени и байтах
   * новой записи нет. При замене исправной версии готовит резерв, публикует текущий CSV и завершает резерв;
   * для отсутствующего или повреждённого CSV сохраняет прежний резерв. При ошибке до публикации
   * прежний резерв остаётся; при ошибке после публикации запись резерва будет повторена при следующем
   * обращении к нему или замене. Ошибки до публикации распространяются. Ошибка завершения после
   * публикации журналируется: операция применения уже состоялась. reload отражает ошибки загрузки набора.
   */
  replaceFile(kind: DataKind, content: Buffer, filename?: string): void {
    const target = kind === 'forecast' ? this.forecastPath : this.routesPath;
    const fallback = path.basename(target);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    finishBackup(target);
    const name = csvFilename(filename, fallback);
    const previous = readDataFileIfPresent(target);
    let prepareBackup: ((key: string) => void) | undefined;
    if (previous) {
      const previousName = dataFileName(target, previous.stat, previous.content, fallback);
      if (previousName === name && previous.content.equals(content)) return;
      if (canBackUp(kind, previous.content)) {
        /** Готовит резерв из текущей версии по обязательному ключу публикации; ошибки диска распространяются. */
        prepareBackup = (key) => stageBackup(target, key, { content: previous.content, name: previousName });
      }
    }
    writeDataFile(target, content, name, fallback, prepareBackup);
    this.reload();
    this.tryFinishBackup(target);
  }

  /**
   * Пытается завершить резервирование.
   * @param file Обязательный путь к текущему CSV.
   * @returns true при завершении или отсутствии операции, false при ошибке с записью в журнал.
   * @remarks Может опубликовать подготовленный резерв; при сбое оставляет операцию для повторной попытки.
   */
  private tryFinishBackup(file: string): boolean {
    try {
      finishBackup(file);
      return true;
    } catch (error) {
      this.log(`Не удалось завершить запись резервной копии (${path.basename(file)}): ${String(error)}`, 'warn');
      return false;
    }
  }

  /**
   * Перечитывает оба обязательных CSV и обновляет снимок в памяти.
   * @param sig Необязательная вычисленная подпись пары; при отсутствии сверяется диск.
   * @returns void. При сбое сохраняет прежний снимок и запоминает ошибку; при успехе обновляет версию.
   * @remarks Синхронно читает файлы, разбирает данные и пишет в журнал; ошибки чтения и разбора не выбрасывает.
   */
  reload(sig?: string): void {
    this.lastSignature = sig ?? signature(this.forecastPath) + '|' + signature(this.routesPath);
    this.lastCheck = Date.now();
    try {
      const routes = readSource(this.routesPath, 'what_routes');
      const forecast = readSource(this.forecastPath, 'what_forecast');
      const snapshot = buildSnapshot(routes.content.toString('utf8'), forecast.content.toString('utf8'), {
        version: this.version + 1,
        source: { forecast: fileInfo(this.forecastPath, forecast), routes: fileInfo(this.routesPath, routes) },
      });
      this.version++;
      this.snapshot = snapshot;
      this.lastError = null;
      this.log(
        `Прогноз загружен: ${snapshot.flights.size} рейсов, ${snapshot.routes.length} маршрутов (${path.basename(this.forecastPath)})`,
      );
      for (const w of snapshot.warnings) this.log(`Предупреждение по данным: ${render('ru', w)}`, 'warn');
    } catch (err) {
      // Если файл не удалось прочитать (например, его держит Excel или антивирус),
      // подпись не запоминаем: при следующей проверке попробуем снова.
      if (err instanceof LocalizedError && err.key === 'file_read_error') this.lastSignature = '';
      this.lastError = toLoadError(err);
      const text = this.lastError.text('ru');
      this.log(
        this.snapshot
          ? `Не удалось перечитать данные, работаем на прежней версии: ${text}`
          : `Не удалось загрузить данные: ${text}`,
        'error',
      );
    }
  }
}

/**
 * Читает версию CSV для загрузки снимка.
 * @param file Обязательный путь к CSV.
 * @param what Ключ перевода типа файла для диагностики.
 * @returns Байты и статистика из одного дескриптора.
 * @remarks Синхронно читает диск без записи; преобразует ошибки в локализованную диагностику.
 */
function readSource(file: string, what: 'what_routes' | 'what_forecast'): ReturnType<typeof readDataFile> {
  try {
    return readDataFile(file);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') throw new LocalizedError('file_not_found', { what, file });
    throw new LocalizedError('file_read_error', { what, file, code: code ?? 'error' });
  }
}
