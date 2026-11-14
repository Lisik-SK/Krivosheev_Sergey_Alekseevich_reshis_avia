import type { City } from '../shared/dataset';
import type { BoardStatus, CurvePoint, DaySummary, ForecastResult, OptimumResult, SellOutProbability } from '../shared/forecast';
import { lang, t } from './i18n';

export interface User {
  id: number;
  email: string;
  name: string;
  role: 'admin' | 'user';
  createdAt: string;
}

/** Справочные параметры маршрута, доступные даты и цены прогноза для формы «Рейс». */
export interface RouteMeta {
  code: string;
  name: string;
  origin: City;
  destination: City;
  basePrice: number;
  priceSensitivity: number;
  costPerPassenger: number | null;
  priceMin: number | null;
  priceMax: number | null;
  dates: string[];
  seats: number[];
  /** Допустимая для расчёта цена 0.5_price по дате YYYY-MM-DD. Ключа нет при отсутствии цены, а в старых снимках может отсутствовать весь словарь. */
  modelPrices?: Readonly<Partial<Record<string, number>>>;
}

export interface FileMeta {
  name: string;
  size: number;
  modifiedAt: string;
}

export interface DataInfo {
  ok: boolean;
  error: string | null;
  version: number;
  loadedAt: string | null;
  flights: number;
  routes: number;
  quantileLevels: number[];
  warnings: string[];
  source: { forecast: FileMeta; routes: FileMeta } | null;
}

export interface Meta {
  routes: RouteMeta[];
  data: DataInfo;
}

/**
 * Метка снимка, использованного для расчёта. Номер растёт в пределах процесса,
 * а дата загрузки различает перезапуски. В сохранённых ранее ответах дата может отсутствовать.
 */
export interface ResponseVersion {
  dataVersion: number;
  dataLoadedAt?: string;
}

/** Ответ прогноза с меткой снимка, использованного для вычислений. */
export type ForecastResponse = ForecastResult & ResponseVersion;

/** Ответ кривой цены с версией данных, использованной для вычислений. */
export interface CurveResponse extends ResponseVersion {
  route: string;
  date: string;
  seats: number;
  bounds: { min: number; max: number };
  basePrice: number;
  costPerPassenger: number | null;
  modelPrice: number | null;
  points: CurvePoint[];
  optimum: OptimumResult;
}

/** Ответ календаря загрузки с версией данных, использованной для вычислений. */
export interface MonthResponse extends ResponseVersion {
  route: string;
  price: number;
  days: DaySummary[];
}

export interface BoardFlight {
  route: string;
  origin: City;
  destination: City;
  price: number;
  seats: number;
  wants: number;
  sales: number;
  rounded: { wants: number; sales: number; freeSeats: number };
  loadFactor: number;
  sellOut: SellOutProbability;
  status: BoardStatus;
  revenue: number;
}

/** Результат табло за выбранную дату с меткой снимка, использованного для вычислений. */
export interface BoardResponse extends ResponseVersion {
  date: string | null;
  priceMode: 'base' | 'model';
  dates: string[];
  flights: BoardFlight[];
}

export interface HistoryItem {
  id: number;
  route: string;
  from: City;
  to: City;
  date: string;
  price: number;
  seats: number;
  sales: number;
  wants: number;
  pinned: boolean;
  createdAt: string;
}

/** Ответ проверки или применения CSV; при успешной проверке содержит ревизию для подтверждения. */
export interface UploadResponse {
  ok: boolean;
  applied: boolean;
  error?: string;
  revision?: string;
  summary?: { flights: number; routes: string[]; dateFrom: string | null; dateTo: string | null; quantileLevels: number[] };
  diff?: {
    addedRoutes: string[];
    removedRoutes: string[];
    changedRoutes?: string[];
    changedFlights: number;
    removedFlights: number;
    perRoute: Array<{ route: string; before: number | null; after: number | null; deltaPct: number | null }>;
  } | null;
  warnings?: string[];
}

/** Сведения о CSV, наличии резервов и идентификаторах текущих состояний для отката. */
export interface AdminData {
  data: DataInfo;
  backups: { forecast: boolean; routes: boolean };
  revisions: { forecast: string; routes: string };
  uploadMaxMb: number;
}

export class ApiError extends Error {
  constructor(
    public readonly status: number,
    message: string,
    public readonly fields: Record<string, string> = {},
  ) {
    super(message);
  }
}

type Method = 'GET' | 'POST' | 'PATCH' | 'DELETE';

async function request<T>(method: Method, url: string, body?: unknown, signal?: AbortSignal): Promise<T> {
  let res: Response;
  const headers: Record<string, string> = { Accept: 'application/json', 'X-Lang': lang() };
  if (method !== 'GET') headers['Content-Type'] = 'application/json';
  try {
    res = await fetch(url, {
      method,
      credentials: 'same-origin',
      headers,
      body: method !== 'GET' ? JSON.stringify(body ?? {}) : undefined,
      signal,
    });
  } catch (err) {
    if ((err as Error).name === 'AbortError') throw err;
    throw new ApiError(0, t('error.network'));
  }
  let data: unknown = null;
  const text = await res.text();
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      data = null;
    }
  }
  if (!res.ok) {
    const d = (data ?? {}) as { error?: string; fields?: Record<string, string> };
    throw new ApiError(res.status, d.error ?? t('error.server', { status: res.status }), d.fields ?? {});
  }
  return data as T;
}

type FlightQuery = { from: string; to: string; date: string; price: number };

export const api = {
  me: () => request<{ user: User | null }>('GET', '/api/auth/me'),
  authConfig: () => request<{ allowRegistration: boolean }>('GET', '/api/auth/config'),
  login: (email: string, password: string) => request<{ user: User }>('POST', '/api/auth/login', { email, password }),
  register: (name: string, email: string, password: string) =>
    request<{ user: User }>('POST', '/api/auth/register', { name, email, password }),
  logout: () => request<{ ok: true }>('POST', '/api/auth/logout', {}),
  meta: (signal?: AbortSignal) => request<Meta>('GET', '/api/meta', undefined, signal),
  forecast: (q: FlightQuery, signal?: AbortSignal) => request<ForecastResponse>('POST', '/api/forecast', q, signal),
  curve: (q: Omit<FlightQuery, 'price'>, signal?: AbortSignal) =>
    request<CurveResponse>('POST', '/api/forecast/curve', q, signal),
  month: (q: Omit<FlightQuery, 'date'>, signal?: AbortSignal) =>
    request<MonthResponse>('POST', '/api/forecast/month', q, signal),
  board: (date: string, priceMode: 'base' | 'model', signal?: AbortSignal) =>
    request<BoardResponse>('POST', '/api/forecast/board', { date, priceMode }, signal),
  history: () => request<{ items: HistoryItem[] }>('GET', '/api/history'),
  saveHistory: (q: FlightQuery) => request<{ items: HistoryItem[] }>('POST', '/api/history', q),
  pinHistory: (id: number, pinned: boolean) => request<{ items: HistoryItem[] }>('PATCH', `/api/history/${id}`, { pinned }),
  deleteHistory: (id: number) => request<{ items: HistoryItem[] }>('DELETE', `/api/history/${id}`, {}),
  clearHistory: (mode: 'all' | 'unpinned') => request<{ items: HistoryItem[] }>('DELETE', `/api/history?mode=${mode}`, {}),
  adminData: () => request<AdminData>('GET', '/api/admin/data'),
  /**
   * Проверяет CSV или применяет проверенный файл. Тип файла, имя и непустое содержимое
   * обязательны; apply включает запись, для которой обязательна ревизия из ответа проверки.
   * Возвращает ответ сервера; сетевые сбои, ошибки HTTP и конфликт ревизий отклоняют Promise.
   */
  upload: (kind: 'forecast' | 'routes', filename: string, content: string, apply: boolean, expectedRevision?: string) =>
    request<UploadResponse>('POST', '/api/admin/upload', { kind, filename, content, apply, expectedRevision }),
  /**
   * Запрашивает откат CSV указанного типа для обязательной ревизии из сведений о резерве.
   * При успехе сервер меняет активные данные и возвращает подтверждение. Ошибки запроса
   * и несовпадение ревизии отклоняют Promise; автоматических повторов нет.
   */
  restore: (kind: 'forecast' | 'routes', expectedRevision: string) =>
    request<{ ok: true }>('POST', '/api/admin/restore', { kind, expectedRevision }),
};
