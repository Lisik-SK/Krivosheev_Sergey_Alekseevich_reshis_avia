/**
 * Разбор и проверка файлов прогноза (seasonal_forecast.csv / ФИО_my_forecast.csv)
 * и справочника маршрутов (routes.csv).
 *
 * Код не привязан к конкретному набору маршрутов, дат или квантилей: всё берётся
 * из заголовков и строк файла. Поэтому прогноз можно заменить своим, не трогая код.
 */
import { CsvError, parseCsv, parseNumber } from './csv.js';
import type { Localizable } from './messages.js';

export interface City {
  code: string;
  name: string;
}

export interface RouteInfo {
  /** Код маршрута в том виде, как он записан в файлах, например MOW-AER. */
  code: string;
  name: string;
  origin: City;
  destination: City;
  /** Базовая цена, руб. */
  basePrice: number;
  /** Сколько пассажиров теряем на каждый рубль сверх базовой цены. */
  priceSensitivity: number;
  costPerPassenger: number | null;
  priceMin: number | null;
  priceMax: number | null;
}

export interface QuantileForecast {
  /** Уровень квантиля, 0 < q < 1. */
  q: number;
  /** Спрос при базовой цене маршрута. */
  baseDemand: number;
  /** Лучшая цена сценария из ML-части (если есть в файле). */
  price: number | null;
  /** Прогноз продаж по этой цене (если есть в файле). */
  priceDemand: number | null;
}

export interface FlightForecast {
  route: string;
  /** Дата в формате YYYY-MM-DD. */
  date: string;
  seats: number;
  /** Квантили по возрастанию q. */
  quantiles: QuantileForecast[];
}

export interface ParsedForecast {
  flights: FlightForecast[];
  quantileLevels: number[];
  /** Замечания к данным (переводимые: см. messages.ts). */
  warnings: Localizable[];
}

/** Справочник названий городов по кодам IATA — на случай, если в routes.csv нет колонки name. */
export const KNOWN_CITIES: Record<string, string> = {
  MOW: 'Москва',
  LED: 'Санкт-Петербург',
  AER: 'Сочи',
  KGD: 'Калининград',
  OVB: 'Новосибирск',
  MRV: 'Минеральные Воды',
  KZN: 'Казань',
  SVX: 'Екатеринбург',
  KRR: 'Краснодар',
  ROV: 'Ростов-на-Дону',
  UFA: 'Уфа',
  KUF: 'Самара',
  VVO: 'Владивосток',
  KJA: 'Красноярск',
  IKT: 'Иркутск',
  MMK: 'Мурманск',
  AAQ: 'Анапа',
  SIP: 'Симферополь',
  GOJ: 'Нижний Новгород',
  PEE: 'Пермь',
  TJM: 'Тюмень',
  OMS: 'Омск',
  CEK: 'Челябинск',
  KHV: 'Хабаровск',
};

const QUANTILE_COLUMN = /^(0?[.,]\d+|0|1(?:[.,]0+)?)_(base_demand|price_demand|price)$/;

/** Названия обязательных столбцов справочника маршрутов. */
const ROUTE_REQUIRED_COLUMNS = ['route', 'base_price', 'price_sensitivity'] as const;

/** Названия столбцов справочника, которые используются при чтении маршрутов. */
const ROUTE_COLUMNS = [
  ...ROUTE_REQUIRED_COLUMNS, 'name', 'cost_per_passenger', 'price_min', 'price_max',
] as const;

/** Названия обязательных столбцов прогноза вне группы квантилей. */
const FORECAST_REQUIRED_COLUMNS = ['route', 'date', 'seats'] as const;

/** Суффиксы заголовков, связывающие столбец с величиной для конкретного уровня квантиля. */
type QuantileColumn = 'base_demand' | 'price' | 'price_demand';

/** Делает спрос неубывающим по q, не меняя медиану. Возвращает true, если что-то исправлено. */
export function enforceMonotone(quantiles: QuantileForecast[]): boolean {
  const mid = quantiles.findIndex((x) => x.q === 0.5);
  let changed = false;
  for (let i = mid - 1; i >= 0; i--) {
    const next = quantiles[i + 1]!.baseDemand;
    if (quantiles[i]!.baseDemand > next) {
      quantiles[i]!.baseDemand = next;
      changed = true;
    }
  }
  for (let i = mid + 1; i < quantiles.length; i++) {
    const prev = quantiles[i - 1]!.baseDemand;
    if (quantiles[i]!.baseDemand < prev) {
      quantiles[i]!.baseDemand = prev;
      changed = true;
    }
  }
  return changed;
}

export function normalizeRouteCode(raw: string): string {
  return raw
    .trim()
    .toUpperCase()
    .replace(/\s+/g, '')
    .replace(/[–—_→>/]/g, '-');
}

/**
 * Приводит дату к YYYY-MM-DD. Понимает ISO (в т.ч. с временем, как пишет pandas),
 * DD.MM.YYYY и DD/MM/YYYY. Возвращает null, если дата некорректна.
 */
export function normalizeDate(raw: string): string | null {
  const s = raw.trim();
  let y: number, m: number, d: number;
  let match = /^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})(?:[T\s].*)?$/.exec(s);
  if (match) {
    y = +match[1]!;
    m = +match[2]!;
    d = +match[3]!;
  } else {
    match = /^(\d{1,2})[./](\d{1,2})[./](\d{4})$/.exec(s);
    if (!match) return null;
    d = +match[1]!;
    m = +match[2]!;
    y = +match[3]!;
  }
  if (m < 1 || m > 12 || d < 1 || d > 31) return null;
  const dt = new Date(Date.UTC(y, m - 1, d));
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== m - 1 || dt.getUTCDate() !== d) return null;
  return `${String(y).padStart(4, '0')}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

/**
 * Строит индекс значимых столбцов независимо от регистра и пробелов по краям.
 * @param header Заголовки в исходном порядке; неизвестные столбцы игнорируются.
 * @param recognized Допустимые названия известных столбцов в нижнем регистре.
 * @returns Отображение нормализованных названий в номера столбцов с нуля.
 * @throws {CsvError} Если известный заголовок встречается в нескольких столбцах.
 * @remarks Работает в памяти и не меняет входные массивы.
 */
function columnIndex(header: string[], recognized: readonly string[]): Map<string, number> {
  const map = new Map<string, number>();
  header.forEach((h, i) => {
    const key = h.trim().toLowerCase();
    if (!recognized.includes(key)) return;
    if (map.has(key)) throw new CsvError('csv_duplicate_column', { column: key });
    map.set(key, i);
  });
  return map;
}

function formatQuantile(q: number): string {
  return String(Math.round(q * 1000) / 1000);
}

/**
 * Разбирает и проверяет справочник маршрутов.
 * @param text Обязательный текст CSV со столбцами маршрута, базовой цены и чувствительности.
 * @returns Маршруты и замечания; при повторе маршрута остаётся последняя строка.
 * @throws {CsvError} При повреждённом CSV, ошибках схемы, значений или отсутствии маршрутов.
 * @remarks Работает в памяти; дополнительные столбцы допускаются, известных столбцов должно быть не больше одного.
 */
export function parseRoutesCsv(text: string): { routes: RouteInfo[]; warnings: Localizable[] } {
  const table = parseCsv(text);
  const idx = columnIndex(table.header, ROUTE_COLUMNS);
  const missing = ROUTE_REQUIRED_COLUMNS.filter((c) => !idx.has(c));
  if (missing.length) {
    throw new CsvError('routes_missing_cols', { cols: missing.join(', ') });
  }

  const warnings: Localizable[] = [];
  const routes: RouteInfo[] = [];
  const seen = new Set<string>();
  const cell = (cells: string[], name: string) => {
    const i = idx.get(name);
    return i === undefined ? undefined : cells[i];
  };

  for (const { line, cells } of table.rows) {
    const code = normalizeRouteCode(cell(cells, 'route') ?? '');
    if (!code) throw new CsvError('route_code_empty', {}, line);
    const parts = code.split('-');
    if (parts.length !== 2 || !parts[0] || !parts[1]) {
      throw new CsvError('route_code_format', { code }, line);
    }
    if (seen.has(code)) {
      warnings.push({ key: 'route_duplicate', params: { line, code } });
      const prev = routes.findIndex((r) => r.code === code);
      routes.splice(prev, 1);
    }
    seen.add(code);

    const basePrice = parseNumber(cell(cells, 'base_price'));
    const sens = parseNumber(cell(cells, 'price_sensitivity'));
    if (basePrice === null || !Number.isFinite(basePrice) || basePrice <= 0) {
      throw new CsvError('base_price_invalid', { code }, line);
    }
    if (sens === null || !Number.isFinite(sens) || sens < 0) {
      throw new CsvError('sensitivity_invalid', { code }, line);
    }
    const optional = (name: string) => {
      const v = parseNumber(cell(cells, name));
      if (v === null) return null;
      if (!Number.isFinite(v)) throw new CsvError('field_not_number', { field: name, code }, line);
      return v;
    };

    const [originCode, destCode] = parts as [string, string];
    const rawName = (cell(cells, 'name') ?? '').trim();
    const nameParts = rawName.split(/\s+[—–-]\s+/);
    const originName =
      nameParts.length === 2 && nameParts[0] ? nameParts[0] : (KNOWN_CITIES[originCode] ?? originCode);
    const destName =
      nameParts.length === 2 && nameParts[1] ? nameParts[1] : (KNOWN_CITIES[destCode] ?? destCode);

    routes.push({
      code,
      name: rawName || `${originName} — ${destName}`,
      origin: { code: originCode, name: originName },
      destination: { code: destCode, name: destName },
      basePrice,
      priceSensitivity: sens,
      costPerPassenger: optional('cost_per_passenger'),
      priceMin: optional('price_min'),
      priceMax: optional('price_max'),
    });
  }
  if (routes.length === 0) throw new CsvError('routes_no_rows');
  return { routes, warnings };
}

/**
 * Разбирает и проверяет прогноз спроса по рейсам.
 * @param text Обязательный CSV с маршрутами, датами, вместимостью и спросом, в том числе медианой.
 * @returns Рейсы, возрастающие уровни квантилей и замечания. Для повторного рейса сохраняется последняя строка,
 * а пересекающиеся квантили приводятся к неубывающему порядку с сохранением медианы.
 * @throws {CsvError} При повреждённом CSV, ошибках схемы, значений или отсутствии рейсов.
 * @remarks Работает в памяти; независимые дополнительные столбцы допускаются, повтор известного поля запрещён.
 */
export function parseForecastCsv(text: string): ParsedForecast {
  const table = parseCsv(text);
  const idx = columnIndex(table.header, FORECAST_REQUIRED_COLUMNS);
  const missing = FORECAST_REQUIRED_COLUMNS.filter((c) => !idx.has(c));
  if (missing.length) {
    throw new CsvError('forecast_missing_cols', { cols: missing.join(', ') });
  }

  // Ищем колонки вида 0.1_base_demand, 0.1_price, 0.1_price_demand.
  const levels = new Map<number, Partial<Record<QuantileColumn, number>>>();
  table.header.forEach((h, i) => {
    const m = QUANTILE_COLUMN.exec(h.trim().toLowerCase());
    if (!m) return;
    const q = Number(m[1]!.replace(',', '.'));
    if (!(q > 0 && q < 1)) return;
    const column = m[2] as QuantileColumn;
    const entry = levels.get(q) ?? {};
    if (entry[column] !== undefined) throw new CsvError('csv_duplicate_column', { column: h });
    entry[column] = i;
    levels.set(q, entry);
  });

  const quantileLevels = [...levels.entries()]
    .filter(([, cols]) => cols.base_demand !== undefined)
    .map(([q]) => q)
    .sort((a, b) => a - b);

  if (quantileLevels.length === 0) {
    throw new CsvError('no_quantile_cols');
  }
  if (!quantileLevels.includes(0.5)) {
    throw new CsvError('no_median');
  }

  const warnings: Localizable[] = [];
  const byKey = new Map<string, FlightForecast>();
  let crossingRows = 0;

  const iRoute = idx.get('route')!;
  const iDate = idx.get('date')!;
  const iSeats = idx.get('seats')!;

  for (const { line, cells } of table.rows) {
    const route = normalizeRouteCode(cells[iRoute] ?? '');
    if (!route) throw new CsvError('route_empty', {}, line);
    const date = normalizeDate(cells[iDate] ?? '');
    if (!date) throw new CsvError('date_invalid', { value: cells[iDate] ?? '' }, line);
    const seats = parseNumber(cells[iSeats]);
    if (seats === null || !Number.isFinite(seats) || Math.round(seats) < 1) {
      throw new CsvError('seats_invalid', { value: cells[iSeats] ?? '' }, line);
    }

    const quantiles: QuantileForecast[] = quantileLevels.map((q) => {
      const cols = levels.get(q)!;
      const base = parseNumber(cells[cols.base_demand!]);
      if (base === null || !Number.isFinite(base)) {
        throw new CsvError('quantile_not_number', { column: `${formatQuantile(q)}_base_demand`, value: cells[cols.base_demand!] ?? '' }, line);
      }
      const opt = (col: number | undefined) => {
        if (col === undefined) return null;
        const v = parseNumber(cells[col]);
        return v !== null && Number.isFinite(v) ? v : null;
      };
      return { q, baseDemand: base, price: opt(cols.price), priceDemand: opt(cols.price_demand) };
    });

    // Квантили модели иногда «перекрещиваются» (0.6 меньше 0.5). Медиану из файла
    // не трогаем: её требует формула из условия. Остальные уровни подтягиваем к ней,
    // чтобы распределение стало неубывающим.
    if (enforceMonotone(quantiles)) crossingRows++;

    const key = `${route}|${date}`;
    if (byKey.has(key)) {
      warnings.push({ key: 'flight_duplicate', params: { line, route, date } });
    }
    byKey.set(key, { route, date, seats: Math.round(seats), quantiles });
  }

  if (byKey.size === 0) throw new CsvError('forecast_no_rows');
  if (crossingRows > 0) {
    warnings.push({ key: 'quantiles_sorted', params: { count: crossingRows } });
  }

  const flights = [...byKey.values()].sort((a, b) =>
    a.route === b.route ? a.date.localeCompare(b.date) : a.route.localeCompare(b.route),
  );
  return { flights, quantileLevels, warnings };
}
