import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadConfig, PROJECT_ROOT } from '../../src/server/config';

const ROOT = path.resolve(__dirname, '..', '..');

describe('loadConfig', () => {
  it('PROJECT_ROOT points at the repository root', () => {
    expect(PROJECT_ROOT).toBe(ROOT);
  });

  it('has sane defaults with an empty environment', () => {
    expect(loadConfig({})).toEqual({
      env: 'development',
      host: '0.0.0.0',
      port: 3000,
      forecastPath: path.join(ROOT, 'data', 'seasonal_forecast.csv'),
      routesPath: path.join(ROOT, 'data', 'routes.csv'),
      dbPath: path.join(ROOT, 'storage', 'app.db'),
      clientDir: path.join(ROOT, 'dist', 'client'),
      sessionTtlHours: 168,
      cookieSecure: 'auto',
      trustProxy: false,
      allowRegistration: true,
      uploadMaxMb: 5,
      adminUploadRateLimitPerMinute: 30,
      logLevel: 'info',
      dataCheckIntervalMs: 2000,
      authRateLimitPerMinute: 10,
    });
  });

  it('UPLOAD_MAX_MB is an integer >= 1', () => {
    expect(loadConfig({ UPLOAD_MAX_MB: '12' }).uploadMaxMb).toBe(12);
    expect(loadConfig({ UPLOAD_MAX_MB: '' }).uploadMaxMb).toBe(5);
    expect(() => loadConfig({ UPLOAD_MAX_MB: '0' })).toThrow(/UPLOAD_MAX_MB/);
    expect(() => loadConfig({ UPLOAD_MAX_MB: '1.5' })).toThrow(/UPLOAD_MAX_MB/);
  });

  it('лимит загрузок CSV по умолчанию равен 30 и принимает положительное целое число', () => {
    expect(loadConfig({ ADMIN_UPLOAD_RATE_LIMIT: '' }).adminUploadRateLimitPerMinute).toBe(30);
    expect(loadConfig({ ADMIN_UPLOAD_RATE_LIMIT: '1000' }).adminUploadRateLimitPerMinute).toBe(1000);
    expect(() => loadConfig({ ADMIN_UPLOAD_RATE_LIMIT: '0' })).toThrow(/ADMIN_UPLOAD_RATE_LIMIT/);
    expect(() => loadConfig({ ADMIN_UPLOAD_RATE_LIMIT: '30.5' })).toThrow(/ADMIN_UPLOAD_RATE_LIMIT/);
  });

  it('NODE_ENV', () => {
    expect(loadConfig({ NODE_ENV: 'production' }).env).toBe('production');
    expect(loadConfig({ NODE_ENV: 'test' }).env).toBe('test');
    expect(loadConfig({ NODE_ENV: 'staging' }).env).toBe('development');
    expect(loadConfig({ NODE_ENV: 'test' }).logLevel).toBe('silent');
    expect(loadConfig({ NODE_ENV: 'production' }).logLevel).toBe('info');
    expect(loadConfig({ NODE_ENV: 'test', LOG_LEVEL: 'debug' }).logLevel).toBe('debug');
  });

  it('HOST', () => {
    expect(loadConfig({ HOST: ' 127.0.0.1 ' }).host).toBe('127.0.0.1');
    expect(loadConfig({ HOST: '   ' }).host).toBe('0.0.0.0');
  });

  describe('integers', () => {
    it('valid PORT', () => {
      expect(loadConfig({ PORT: '8080' }).port).toBe(8080);
      expect(loadConfig({ PORT: '' }).port).toBe(3000);
    });

    it.each(['abc', '0', '-1', '3000.5', '80x', 'NaN', 'Infinity'])('invalid PORT %j throws', (v) => {
      expect(() => loadConfig({ PORT: v })).toThrow(/PORT/);
    });

    it('SESSION_TTL_HOURS >= 1, DATA_CHECK_INTERVAL_MS >= 0, AUTH_RATE_LIMIT >= 1', () => {
      expect(loadConfig({ SESSION_TTL_HOURS: '2' }).sessionTtlHours).toBe(2);
      expect(() => loadConfig({ SESSION_TTL_HOURS: '0' })).toThrow(/SESSION_TTL_HOURS/);
      expect(loadConfig({ DATA_CHECK_INTERVAL_MS: '0' }).dataCheckIntervalMs).toBe(0);
      expect(() => loadConfig({ DATA_CHECK_INTERVAL_MS: '-5' })).toThrow(/DATA_CHECK_INTERVAL_MS/);
      expect(loadConfig({ AUTH_RATE_LIMIT: '25' }).authRateLimitPerMinute).toBe(25);
      expect(() => loadConfig({ AUTH_RATE_LIMIT: '0' })).toThrow(/AUTH_RATE_LIMIT/);
    });
  });

  describe('booleans (ALLOW_REGISTRATION)', () => {
    it.each(['1', 'true', 'TRUE', 'yes', 'on', ' On '])('%j -> true', (v) => {
      expect(loadConfig({ ALLOW_REGISTRATION: v }).allowRegistration).toBe(true);
    });
    it.each(['0', 'false', 'no', 'off', 'False'])('%j -> false', (v) => {
      expect(loadConfig({ ALLOW_REGISTRATION: v }).allowRegistration).toBe(false);
    });
    it('empty -> default (true)', () => {
      expect(loadConfig({ ALLOW_REGISTRATION: '' }).allowRegistration).toBe(true);
    });
  });

  describe('TRUST_PROXY', () => {
    it.each<[string | undefined, boolean | number | string]>([
      [undefined, false],
      ['', false],
      ['  ', false],
      ['true', true],
      ['TRUE', true],
      ['false', false],
      ['1', 1],
      ['2', 2],
      ['127.0.0.1', '127.0.0.1'],
      ['10.0.0.0/8, 127.0.0.1', '10.0.0.0/8, 127.0.0.1'],
      ['loopback', 'loopback'],
    ])('%j -> %j', (v, expected) => {
      expect(loadConfig(v === undefined ? {} : { TRUST_PROXY: v }).trustProxy).toEqual(expected);
    });
  });

  describe('paths', () => {
    it('relative FORECAST_PATH / ROUTES_PATH resolve against the project root, not cwd', () => {
      const c = loadConfig({ FORECAST_PATH: 'my/forecast.csv', ROUTES_PATH: ' my/routes.csv ' });
      expect(c.forecastPath).toBe(path.join(ROOT, 'my', 'forecast.csv'));
      expect(c.routesPath).toBe(path.join(ROOT, 'my', 'routes.csv'));
    });

    it('absolute paths are kept', () => {
      const abs = path.resolve(ROOT, '..', 'elsewhere', 'f.csv');
      expect(loadConfig({ FORECAST_PATH: abs }).forecastPath).toBe(abs);
    });

    it('DATA_DIR sets both files; explicit paths win', () => {
      const c = loadConfig({ DATA_DIR: 'other' });
      expect(c.forecastPath).toBe(path.join(ROOT, 'other', 'seasonal_forecast.csv'));
      expect(c.routesPath).toBe(path.join(ROOT, 'other', 'routes.csv'));
      expect(loadConfig({ DATA_DIR: 'other', FORECAST_PATH: 'x.csv' }).forecastPath).toBe(path.join(ROOT, 'x.csv'));
    });

    it('empty FORECAST_PATH falls back to the default', () => {
      expect(loadConfig({ FORECAST_PATH: '  ' }).forecastPath).toBe(path.join(ROOT, 'data', 'seasonal_forecast.csv'));
    });

    it('DB_PATH, STORAGE_DIR, CLIENT_DIR', () => {
      expect(loadConfig({ DB_PATH: 'db/x.db' }).dbPath).toBe(path.join(ROOT, 'db', 'x.db'));
      expect(loadConfig({ STORAGE_DIR: 'var' }).dbPath).toBe(path.join(ROOT, 'var', 'app.db'));
      expect(loadConfig({ CLIENT_DIR: 'public' }).clientDir).toBe(path.join(ROOT, 'public'));
    });
  });

  describe('COOKIE_SECURE', () => {
    it.each<[string | undefined, 'auto' | boolean]>([
      [undefined, 'auto'],
      ['auto', 'auto'],
      [' AUTO ', 'auto'],
      ['true', true],
      ['1', true],
      ['yes', true],
      ['false', false],
      ['0', false],
    ])('%j -> %j', (v, expected) => {
      expect(loadConfig(v === undefined ? {} : { COOKIE_SECURE: v }).cookieSecure).toBe(expected);
    });

    // Regression: an empty value (docker-compose `COOKIE_SECURE: ${COOKIE_SECURE}`) used to become false.
    it.each(['', '   '])('empty COOKIE_SECURE %j falls back to the default "auto"', (v) => {
      expect(loadConfig({ COOKIE_SECURE: v }).cookieSecure).toBe('auto');
    });
  });
});
