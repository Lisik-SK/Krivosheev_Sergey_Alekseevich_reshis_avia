import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** Корень проекта: из src/server и из dist/node/server путь разный, поэтому ищем по маркеру. */
function findProjectRoot(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  // src/server -> ../.. ; dist/node/server -> ../../..
  const parent = path.basename(path.dirname(here));
  const grandParent = path.basename(path.dirname(path.dirname(here)));
  if (parent === 'node' && grandParent === 'dist') return path.resolve(here, '..', '..', '..');
  return path.resolve(here, '..', '..');
}

export const PROJECT_ROOT = findProjectRoot();

export interface AppConfig {
  env: 'development' | 'production' | 'test';
  host: string;
  port: number;
  forecastPath: string;
  routesPath: string;
  dbPath: string;
  clientDir: string;
  sessionTtlHours: number;
  cookieSecure: 'auto' | boolean;
  trustProxy: boolean | number | string;
  allowRegistration: boolean;
  /** Максимальный размер загружаемого CSV, МБ. */
  uploadMaxMb: number;
  logLevel: string;
  /** Как часто (мс) сервер проверяет, не изменились ли CSV-файлы. */
  dataCheckIntervalMs: number;
  /** Лимит попыток входа/регистрации с одного IP в минуту. */
  authRateLimitPerMinute: number;
}

function bool(v: string | undefined, fallback: boolean): boolean {
  if (v === undefined || v === '') return fallback;
  return /^(1|true|yes|on)$/i.test(v.trim());
}

function int(v: string | undefined, fallback: number, name: string, min = 0): number {
  if (v === undefined || v === '') return fallback;
  const n = Number(v);
  if (!Number.isInteger(n) || n < min) throw new Error(`Переменная окружения ${name} должна быть целым числом ≥ ${min}`);
  return n;
}

function resolvePath(v: string | undefined, fallback: string): string {
  return path.resolve(PROJECT_ROOT, v && v.trim() ? v.trim() : fallback);
}

function parseTrustProxy(v: string | undefined): boolean | number | string {
  if (v === undefined || v.trim() === '') return false;
  const s = v.trim();
  if (/^(true|false)$/i.test(s)) return s.toLowerCase() === 'true';
  if (/^\d+$/.test(s)) return Number(s);
  return s; // список IP/подсетей через запятую
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const nodeEnv = env.NODE_ENV === 'production' ? 'production' : env.NODE_ENV === 'test' ? 'test' : 'development';
  const dataDir = resolvePath(env.DATA_DIR, 'data');
  const cookieSecureRaw = (env.COOKIE_SECURE?.trim() || 'auto').toLowerCase();

  return {
    env: nodeEnv,
    host: env.HOST?.trim() || '0.0.0.0',
    port: int(env.PORT, 3000, 'PORT', 1),
    forecastPath: env.FORECAST_PATH?.trim()
      ? resolvePath(env.FORECAST_PATH, '')
      : path.join(dataDir, 'seasonal_forecast.csv'),
    routesPath: env.ROUTES_PATH?.trim() ? resolvePath(env.ROUTES_PATH, '') : path.join(dataDir, 'routes.csv'),
    dbPath: env.DB_PATH?.trim() ? resolvePath(env.DB_PATH, '') : path.join(resolvePath(env.STORAGE_DIR, 'storage'), 'app.db'),
    clientDir: resolvePath(env.CLIENT_DIR, path.join('dist', 'client')),
    sessionTtlHours: int(env.SESSION_TTL_HOURS, 24 * 7, 'SESSION_TTL_HOURS', 1),
    cookieSecure: cookieSecureRaw === 'auto' ? 'auto' : bool(cookieSecureRaw, false),
    trustProxy: parseTrustProxy(env.TRUST_PROXY),
    allowRegistration: bool(env.ALLOW_REGISTRATION, true),
    uploadMaxMb: int(env.UPLOAD_MAX_MB, 5, 'UPLOAD_MAX_MB', 1),
    logLevel: env.LOG_LEVEL?.trim() || (nodeEnv === 'test' ? 'silent' : 'info'),
    dataCheckIntervalMs: int(env.DATA_CHECK_INTERVAL_MS, 2000, 'DATA_CHECK_INTERVAL_MS'),
    authRateLimitPerMinute: int(env.AUTH_RATE_LIMIT, 10, 'AUTH_RATE_LIMIT', 1),
  };
}
