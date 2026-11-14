import fs from 'node:fs';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { DataStore } from '../../src/server/dataStore';
import { msg } from '../../src/shared/messages';
import {
  DATA_FORECAST,
  DATA_ROUTES,
  api,
  forecast,
  makeApp,
  makeTempDir,
  meta,
  registerUser,
  writeAndBump,
} from './helpers';

const ORIGINAL_FORECAST = fs.readFileSync(DATA_FORECAST, 'utf8');
const ORIGINAL_ROUTES = fs.readFileSync(DATA_ROUTES, 'utf8');
const AER_0601 = 'MOW-AER,2026-06-01,900,656,8928,667,694,9061,685,723,9163,700,742,9233,710,775,9347,726,';

const tempDirs: string[] = [];
const apps: FastifyInstance[] = [];
afterAll(async () => {
  for (const a of apps) await a.close();
  for (const d of tempDirs) fs.rmSync(d, { recursive: true, force: true });
});

function setupDir(forecastText = ORIGINAL_FORECAST, routesText = ORIGINAL_ROUTES) {
  const dir = makeTempDir('data');
  tempDirs.push(dir);
  const forecastPath = path.join(dir, 'seasonal_forecast.csv');
  const routesPath = path.join(dir, 'routes.csv');
  fs.writeFileSync(forecastPath, forecastText);
  fs.writeFileSync(routesPath, routesText);
  return { dir, forecastPath, routesPath };
}

async function appFor(forecastPath: string, routesPath: string) {
  const app = await makeApp({ forecastPath, routesPath, dataCheckIntervalMs: 0 });
  apps.push(app);
  const { token } = await registerUser(app);
  return { app, token };
}

const AER = { from: 'MOW', to: 'AER', date: '2026-06-01', price: 9500 };

describe('hot reload of CSV files', () => {
  let app: FastifyInstance;
  let token: string;
  let forecastPath: string;
  let routesPath: string;

  beforeAll(async () => {
    expect(ORIGINAL_FORECAST).toContain(AER_0601);
    ({ forecastPath, routesPath } = setupDir());
    ({ app, token } = await appFor(forecastPath, routesPath));
  });

  const wants = async () => {
    const res = await forecast(app, token, AER);
    expect(res.statusCode).toBe(200);
    return { wants: res.json().median.wants as number, version: res.json().dataVersion as number };
  };
  const dataInfo = async () => (await meta(app, token)).json().data;

  it('serves the original data first', async () => {
    expect(await wants()).toEqual({ wants: 704.5, version: 1 });
  });

  it('picks up a same-size change in the forecast (mtime bumped)', async () => {
    // 775 → 780 keeps the file size and the quantile order.
    const changed = ORIGINAL_FORECAST.replace(AER_0601, AER_0601.replace(',742,9233,710,775,', ',742,9233,710,780,'));
    expect(changed.length).toBe(ORIGINAL_FORECAST.length);
    writeAndBump(forecastPath, changed, 10);
    expect(await wants()).toEqual({ wants: 709.5, version: 2 });
    const info = await dataInfo();
    expect(info.ok).toBe(true);
    expect(info.error).toBeNull();
    expect(info.version).toBe(2);
  });

  it('picks up a size change even without touching mtime', async () => {
    const changed = ORIGINAL_FORECAST.replace(AER_0601, AER_0601.replace('MOW-AER,2026-06-01,900,', 'MOW-AER,2026-06-01,9000,'));
    fs.writeFileSync(forecastPath, changed);
    const r = (await forecast(app, token, AER)).json();
    expect(r.seats).toBe(9000);
    expect(r.median.wants).toBe(704.5);
    expect(r.dataVersion).toBe(3);
  });

  it('picks up a change in routes.csv', async () => {
    writeAndBump(forecastPath, ORIGINAL_FORECAST, 20);
    // sensitivity 0.141 → 0.282: wants = 775 − 0.282×500 = 634
    writeAndBump(routesPath, ORIGINAL_ROUTES.replace('9000,4200,0.141,', '9000,4200,0.282,'), 20);
    expect((await wants()).wants).toBe(634);
    const m = (await meta(app, token)).json();
    expect(m.routes[0].priceSensitivity).toBe(0.282);
  });

  it('keeps serving the last good version when the new file is invalid', async () => {
    writeAndBump(routesPath, ORIGINAL_ROUTES, 30);
    expect((await wants()).wants).toBe(704.5);
    const goodVersion = (await dataInfo()).version;

    writeAndBump(forecastPath, 'route,date\nMOW-AER,2026-06-01\n', 40);
    const r = await wants();
    expect(r.wants).toBe(704.5);
    expect(r.version).toBe(goodVersion);

    const info = await dataInfo();
    expect(info.ok).toBe(false);
    expect(info.error).toBe(msg('ru', 'forecast_missing_cols', { cols: 'seats' }));
    expect(info.version).toBe(goodVersion);
    expect(info.flights).toBe(155);

    const healthRes = await app.inject({ method: 'GET', url: '/api/health' });
    expect(healthRes.statusCode).toBe(200); // old data is still served
    expect(healthRes.json().status).toBe('degraded');
    expect(healthRes.json().data.error).toBe(msg('ru', 'forecast_missing_cols', { cols: 'seats' }));

    // The data error is translated per request.
    const en = (await meta(app, token, { 'x-lang': 'en' })).json().data;
    expect(en.error).toBe(msg('en', 'forecast_missing_cols', { cols: 'seats' }));
    const healthEn = (await app.inject({ method: 'GET', url: '/api/health', headers: { 'accept-language': 'en-GB' } })).json();
    expect(healthEn.data.error).toBe(msg('en', 'forecast_missing_cols', { cols: 'seats' }));
  });

  it('a parse error is reported with its line number', async () => {
    const broken = ORIGINAL_FORECAST.replace(AER_0601, AER_0601.replace('MOW-AER,2026-06-01,', 'MOW-AER,2026-02-30,'));
    writeAndBump(forecastPath, broken, 50);
    for (const lang of ['ru', 'en'] as const) {
      const info = (await meta(app, token, { 'x-lang': lang })).json().data;
      expect(info.error).toBe(msg(lang, 'line_prefix', { line: 2 }) + msg(lang, 'date_invalid', { value: '2026-02-30' }));
    }
    expect((await wants()).wants).toBe(704.5);
  });

  it('keeps serving data when the file is deleted', async () => {
    fs.rmSync(forecastPath);
    const info = await dataInfo();
    expect(info.ok).toBe(false);
    expect(info.error).toBe(msg('ru', 'file_not_found', { what: 'what_forecast', file: forecastPath }));
    expect((await meta(app, token, { 'x-lang': 'en' })).json().data.error).toBe(
      msg('en', 'file_not_found', { what: 'what_forecast', file: forecastPath }),
    );
    expect((await wants()).wants).toBe(704.5);
  });

  it('recovers when the file is fixed', async () => {
    const before = (await dataInfo()).version;
    const changed = ORIGINAL_FORECAST.replace(AER_0601, AER_0601.replace(',742,9233,710,775,', ',742,9233,710,780,'));
    writeAndBump(forecastPath, changed, 60);
    expect(await wants()).toEqual({ wants: 709.5, version: before + 1 });
    const info = await dataInfo();
    expect(info.ok).toBe(true);
    expect(info.error).toBeNull();
    expect((await app.inject({ method: 'GET', url: '/api/health' })).json().status).toBe('ok');
  });
});

describe('data problems', () => {
  it('keeps directory routes without a forecast, while skipping forecast rows for unknown routes', async () => {
    const extra = ORIGINAL_FORECAST.split('\n')
      .filter((l) => l.startsWith('MOW-AER,2026-06-0'))
      .map((l) => l.replace('MOW-AER', 'MOW-XXX'))
      .join('\n');
    const routes = ORIGINAL_ROUTES.trimEnd() + '\nMOW-KZN,Москва — Казань,7000,3000,0.1,4000,14000\n';
    const { forecastPath, routesPath } = setupDir(ORIGINAL_FORECAST.trimEnd() + '\n' + extra + '\n', routes);
    const { app, token } = await appFor(forecastPath, routesPath);

    const m = (await meta(app, token)).json();
    expect(m.data.ok).toBe(true);
    expect(m.data.warnings).toEqual([msg('ru', 'unknown_routes', { list: 'MOW-XXX' })]);
    expect((await meta(app, token, { 'x-lang': 'en' })).json().data.warnings).toEqual([
      msg('en', 'unknown_routes', { list: 'MOW-XXX' }),
    ]);
    expect(m.data.flights).toBe(155);
    expect(m.data.routes).toBe(6);
    expect(m.routes.map((r: { code: string }) => r.code)).toEqual(['MOW-AER', 'MOW-LED', 'MOW-KGD', 'MOW-OVB', 'MOW-MRV', 'MOW-KZN']);
    expect(m.routes[5]).toMatchObject({ code: 'MOW-KZN', dates: [], seats: [] });

    expect((await forecast(app, token, AER)).json().median.wants).toBe(704.5);
    const xxx = await forecast(app, token, { ...AER, to: 'XXX' });
    expect(xxx.statusCode).toBe(400);
    expect(xxx.json().fields).toEqual({ to: msg('ru', 'city_not_found', { city: 'XXX' }) });
    for (const lang of ['ru', 'en'] as const) {
      const error = msg(lang, 'route_no_forecast', { route: 'MOW-KZN' });
      const headers = { 'x-lang': lang };
      const kzn = await forecast(app, token, { ...AER, to: 'Казань' }, headers);
      expect(kzn.statusCode).toBe(404);
      expect(kzn.json()).toMatchObject({ error, fields: { date: error } });
      const curve = await api(app, 'POST', '/api/forecast/curve', token, { ...AER, to: 'KZN' }, headers);
      expect(curve.statusCode).toBe(404);
      expect(curve.json()).toMatchObject({ error });
    }
    const month = await api(app, 'POST', '/api/forecast/month', token, { ...AER, to: 'KZN' });
    expect(month.statusCode).toBe(200);
    expect(month.json()).toMatchObject({ route: 'MOW-KZN', days: [] });
    const board = await api(app, 'POST', '/api/forecast/board', token, { date: AER.date });
    expect(board.statusCode).toBe(200);
    expect(board.json().flights).toHaveLength(5);
    expect(board.json().flights).not.toContainEqual(expect.objectContaining({ route: 'MOW-KZN' }));
  });

  it('missing route from a city that has other routes → hint lists them (ru and en)', async () => {
    const extra = ORIGINAL_FORECAST.split('\n')
      .filter((l) => l.startsWith('MOW-AER,'))
      .map((l) => l.replace('MOW-AER', 'AER-LED'))
      .join('\n');
    const routes = ORIGINAL_ROUTES.trimEnd() + '\nAER-LED,Сочи — Санкт-Петербург,6000,3000,0.1,3000,12000\n';
    const { forecastPath, routesPath } = setupDir(ORIGINAL_FORECAST.trimEnd() + '\n' + extra + '\n', routes);
    const { app, token } = await appFor(forecastPath, routesPath);

    for (const lang of ['ru', 'en'] as const) {
      const res = await forecast(app, token, { ...AER, from: 'Сочи', to: 'Калининград' }, { 'x-lang': lang });
      expect(res.statusCode).toBe(404);
      const hint = msg(lang, 'route_hint_available', { list: 'Санкт-Петербург' });
      expect(res.json().error).toBe(msg(lang, 'route_missing', { from: 'AER', to: 'KGD', hint }));
      expect(res.json().fields).toEqual({ to: msg(lang, 'route_field') });
    }
    // The new route itself works: 775 − 0.1 × (9500 − 6000) = 425
    const ok = await forecast(app, token, { ...AER, from: 'AER', to: 'LED' });
    expect(ok.json().median.wants).toBe(425);
  });

  it('crossing quantiles and duplicate rows show up as warnings in /api/meta; the median is kept', async () => {
    const dup = ORIGINAL_FORECAST.split('\n').find((l) => l.startsWith('MOW-LED,2026-06-15'))!;
    const dupLine = ORIGINAL_FORECAST.trimEnd().split('\n').length + 1;
    const crossing = ORIGINAL_FORECAST.replace(AER_0601, AER_0601.replace(',742,9233,710,775,', ',742,9233,710,999,'));
    const { forecastPath, routesPath } = setupDir(crossing.trimEnd() + '\n' + dup + '\n');
    const { app, token } = await appFor(forecastPath, routesPath);
    const warnings: string[] = (await meta(app, token)).json().data.warnings;
    expect(warnings).toEqual([
      msg('ru', 'flight_duplicate', { line: dupLine, route: 'MOW-LED', date: '2026-06-15' }),
      msg('ru', 'quantiles_sorted', { count: 1 }),
    ]);
    // The median 999 stays; levels above it are clamped up to 999, below are untouched (656..742 < 999).
    const r = (await forecast(app, token, { ...AER, price: 9000 })).json();
    expect(r.median.wants).toBe(999);
    expect(r.scenarios.map((s: { wants: number }) => s.wants)).toEqual([656, 694, 723, 742, 999, 999, 999, 999, 999]);
  });

  it('serves the directory with a warning when no route matches the forecast', async () => {
    const onlyUnknown = ORIGINAL_FORECAST.replace(/^MOW-/gm, 'LED-');
    const { forecastPath, routesPath } = setupDir(onlyUnknown);
    const { app, token } = await appFor(forecastPath, routesPath);
    const health = await app.inject({ method: 'GET', url: '/api/health' });
    expect(health.statusCode).toBe(200);
    expect(health.json()).toMatchObject({ status: 'degraded', data: { flights: 0, routes: 5 } });
    for (const lang of ['ru', 'en'] as const) {
      const m = await meta(app, token, { 'x-lang': lang });
      expect(m.statusCode).toBe(200);
      expect(m.json().data).toMatchObject({ flights: 0, routes: 5, warnings: [msg(lang, 'no_routes_matched')] });
      expect(m.json().routes).toHaveLength(5);
      expect(m.json().routes.every((r: { dates: string[]; seats: number[] }) => !r.dates.length && !r.seats.length)).toBe(true);
    }
    expect((await forecast(app, token, AER)).statusCode).toBe(404);
    const board = await api(app, 'POST', '/api/forecast/board', token, {});
    expect(board.statusCode).toBe(200);
    expect(board.json()).toMatchObject({ date: null, dates: [], flights: [] });
  });

  it('missing files at startup → 503, then the app recovers once the files appear', async () => {
    const dir = makeTempDir('missing');
    tempDirs.push(dir);
    const forecastPath = path.join(dir, 'seasonal_forecast.csv');
    const routesPath = path.join(dir, 'routes.csv');
    const { app, token } = await appFor(forecastPath, routesPath);

    const health = await app.inject({ method: 'GET', url: '/api/health' });
    expect(health.statusCode).toBe(503);
    expect(health.json().status).toBe('error');
    expect(health.json().data.error).toBe(msg('ru', 'file_not_found', { what: 'what_routes', file: routesPath }));
    expect((await forecast(app, token, AER)).statusCode).toBe(503);

    fs.writeFileSync(routesPath, ORIGINAL_ROUTES);
    fs.writeFileSync(forecastPath, ORIGINAL_FORECAST);
    const res = await forecast(app, token, AER);
    expect(res.statusCode).toBe(200);
    expect(res.json().median.wants).toBe(704.5);
    const ok = await app.inject({ method: 'GET', url: '/api/health' });
    expect(ok.statusCode).toBe(200);
    expect(ok.json().status).toBe('ok');
  });

  it('semicolon + decimal comma files (Excel RU, incl. "0,5_base_demand" headers) are served with the same numbers', async () => {
    const toSemicolon = (t: string) =>
      String.fromCharCode(0xfeff) +
      t
        .trimEnd()
        .split('\n')
        .map((l) => l.split(',').map((c) => c.replace('.', ',')).join(';'))
        .join('\r\n') +
      '\r\n';
    const excelForecast = toSemicolon(ORIGINAL_FORECAST);
    expect(excelForecast).toContain('0,5_base_demand');
    const { forecastPath, routesPath } = setupDir(excelForecast, toSemicolon(ORIGINAL_ROUTES));
    const { app, token } = await appFor(forecastPath, routesPath);
    const r = (await forecast(app, token, AER)).json();
    expect(r.median.wants).toBe(704.5);
    expect(r.route.priceSensitivity).toBe(0.141);
    expect(r.scenarios).toHaveLength(9);
  });
});

describe('DataStore check interval', () => {
  it('does not re-stat files more often than checkIntervalMs; force bypasses it', () => {
    const { forecastPath, routesPath } = setupDir();
    const logs: string[] = [];
    const store = new DataStore(forecastPath, routesPath, 60_000, (m) => logs.push(m));
    expect(store.get()!.version).toBe(1);
    expect(logs[0]).toMatch(/155/);

    writeAndBump(routesPath, ORIGINAL_ROUTES.replace('9000,4200,0.141,', '9000,4200,0.282,'), 10);
    expect(store.get()!.version).toBe(1); // within the interval: not noticed yet
    store.refreshIfChanged(true);
    expect(store.get()!.version).toBe(2);
    expect(store.get()!.routeByCode.get('MOW-AER')!.priceSensitivity).toBe(0.282);

    // Unchanged files are not re-parsed even when forced.
    store.refreshIfChanged(true);
    expect(store.get()!.version).toBe(2);
  });

  // Regression: a transient read error (EBUSY while Excel/antivirus holds the file) used to be stuck
  // until the file changed again, because the signature was stored before reading.
  it('retries after a transient read error without the file having to change again', () => {
    const { forecastPath, routesPath } = setupDir();
    const store = new DataStore(forecastPath, routesPath, 0);
    writeAndBump(routesPath, ORIGINAL_ROUTES.replace('9000,4200,0.141,', '9000,4200,0.282,'), 10);

    const realRead = fs.readFileSync;
    const spy = vi.spyOn(fs, 'readFileSync').mockImplementation(((...args: Parameters<typeof fs.readFileSync>) => {
      if (String(args[0]) === routesPath) {
        throw Object.assign(new Error('EBUSY: resource busy or locked'), { code: 'EBUSY' });
      }
      return realRead(...args);
    }) as typeof fs.readFileSync);
    try {
      const st = store.status();
      expect(st.error!.text('ru')).toBe(msg('ru', 'file_read_error', { what: 'what_routes', file: routesPath, code: 'EBUSY' }));
      expect(st.error!.text('en')).toBe(msg('en', 'file_read_error', { what: 'what_routes', file: routesPath, code: 'EBUSY' }));
      expect(st.snapshot!.version).toBe(1); // old data kept
    } finally {
      spy.mockRestore();
    }
    // The lock is gone and the file on disk is valid; the next check picks it up.
    const st = store.status();
    expect(st.error).toBeNull();
    expect(st.snapshot!.routeByCode.get('MOW-AER')!.priceSensitivity).toBe(0.282);
  });

  it('a parse error (not a read error) is not retried until the file changes', () => {
    const { forecastPath, routesPath } = setupDir();
    const logs: string[] = [];
    const store = new DataStore(forecastPath, routesPath, 0, (m) => logs.push(m));
    writeAndBump(forecastPath, 'route,date\nx,y\n', 10);
    expect(store.status().error).not.toBeNull();
    const n = logs.length;
    store.status();
    store.status();
    expect(logs.length).toBe(n); // no re-parse, no repeated error logs
  });
});
