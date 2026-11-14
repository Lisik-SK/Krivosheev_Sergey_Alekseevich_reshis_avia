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
import { promisify } from 'node:util';
import { csvFilename, dataFileName, dataFileVersionKey, writeDataFile } from './data-file.js';
import { parseForecastCsv, parseRoutesCsv, type FlightForecast, type RouteInfo } from '../shared/dataset.js';
import { LocalizedError, render, type Lang, type Localizable } from '../shared/messages.js';

/** Асинхронно читает байты по пути или открытому дескриптору. При сбое отклоняет Promise, дескриптор оставляет владельцу. */
const readFileAsync = promisify(fs.readFile);

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

/** Читает имя, размер и дату изменения CSV по обязательному пути. Возвращает FileInfo; ошибки stat распространяются, записей нет. */
function fileInfo(file: string): FileInfo {
  const st = fs.statSync(file, { bigint: true });
  const modifiedAt = fs.statSync(file).mtime.toISOString();
  return { name: dataFileName(file, st, path.basename(file)), size: Number(st.size), modifiedAt };
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
      return fileInfo(file);
    } catch {
      return { name: path.basename(file), size: 0, modifiedAt: new Date(0).toISOString() };
    }
  }

  /**
   * Возвращает содержимое и имя текущего CSV или резервной копии.
   * @param kind Обязательный тип CSV: прогноз или справочник.
   * @param backup true для резервной копии, по умолчанию false.
   * @returns Байты и имя одной версии файла; старые версии используют настроенное имя.
   * @remarks Синхронно открывает файл, сверяет имя по статистике дескриптора, читает байты и закрывает дескриптор.
   * Ошибки чтения, включая ENOENT, распространяются. Файлы не изменяет.
   */
  readFileVersion(kind: 'forecast' | 'routes', backup = false): { content: Buffer; name: string } {
    const target = kind === 'forecast' ? this.forecastPath : this.routesPath;
    const file = backup ? `${target}.bak` : target;
    const fd = fs.openSync(file, 'r');
    try {
      const name = dataFileName(file, fs.fstatSync(fd, { bigint: true }), path.basename(target));
      return { content: fs.readFileSync(fd), name };
    } finally {
      fs.closeSync(fd);
    }
  }

  /**
   * Читает актуальный CSV для скачивания.
   * @param kind Обязательный тип CSV: прогноз или справочник.
   * @returns Promise с байтами и именем одной версии файла.
   * @remarks Синхронно открывает файл и определяет имя до передачи управления, затем читает байты
   * асинхронно через тот же дескриптор и закрывает его при любом исходе.
   * Файлы не меняет; ошибки открытия, чтения или закрытия отклоняют Promise.
   */
  async downloadFile(kind: 'forecast' | 'routes'): Promise<{ content: Buffer; name: string }> {
    const file = kind === 'forecast' ? this.forecastPath : this.routesPath;
    const fd = fs.openSync(file, 'r');
    try {
      const name = dataFileName(file, fs.fstatSync(fd, { bigint: true }), path.basename(file));
      return { content: await readFileAsync(fd), name };
    } finally {
      fs.closeSync(fd);
    }
  }

  /**
   * Заменяет текущий CSV и сохраняет предыдущие байты и имя в резервной копии.
   * @param kind Обязательный тип CSV: прогноз или справочник.
   * @param content Обязательные байты предварительно проверенного CSV.
   * @param filename Необязательное исходное имя, при отсутствии берётся настроенное имя.
   * @returns void после публикации и перечитывания набора данных.
   * @remarks Синхронно готовит новую версию, сохраняет резервную копию и публикует новую версию.
   * Если публикация не удалась, восстанавливает прежний бэкап при его наличии. Ошибки записи
   * распространяются; ошибки разбора после записи отражаются в состоянии через reload.
   */
  replaceFile(kind: 'forecast' | 'routes', content: Buffer, filename?: string): void {
    const target = kind === 'forecast' ? this.forecastPath : this.routesPath;
    const fallback = path.basename(target);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    const backupPath = `${target}.bak`;
    const backup = fs.existsSync(backupPath) ? this.readFileVersion(kind, true) : undefined;
    let backupReplaced = false;
    try {
      writeDataFile(target, content, csvFilename(filename, fallback), fallback, () => {
        if (!fs.existsSync(target)) return;
        const previous = this.readFileVersion(kind);
        writeDataFile(backupPath, previous.content, previous.name, fallback);
        backupReplaced = true;
      });
    } catch (error) {
      if (backupReplaced && backup) {
        try {
          writeDataFile(backupPath, backup.content, backup.name, fallback);
        } catch (backupError) {
          throw new AggregateError([error, backupError], 'Не удалось заменить CSV и восстановить резервную копию');
        }
      }
      throw error;
    }
    this.reload();
  }

  reload(sig?: string): void {
    this.lastSignature = sig ?? signature(this.forecastPath) + '|' + signature(this.routesPath);
    this.lastCheck = Date.now();
    try {
      const routesText = readText(this.routesPath, 'what_routes');
      const forecastText = readText(this.forecastPath, 'what_forecast');
      const snapshot = buildSnapshot(routesText, forecastText, {
        version: this.version + 1,
        source: { forecast: fileInfo(this.forecastPath), routes: fileInfo(this.routesPath) },
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

function readText(file: string, what: 'what_routes' | 'what_forecast'): string {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') throw new LocalizedError('file_not_found', { what, file });
    throw new LocalizedError('file_read_error', { what, file, code: code ?? 'error' });
  }
}
