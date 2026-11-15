import fs from 'node:fs';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { msg } from '../../src/shared/messages';
import { parseForecastCsv } from '../../src/shared/dataset';
import { api, DATA_FORECAST, DATA_ROUTES, forecast, GOOD_PASSWORD, makeApp, makeTempDir, meta, registerUser, sessionFrom } from './helpers';

const ORIGINAL_FORECAST = fs.readFileSync(DATA_FORECAST, 'utf8');
const ORIGINAL_ROUTES = fs.readFileSync(DATA_ROUTES, 'utf8');
const AER_0601 = 'MOW-AER,2026-06-01,900,656,8928,667,694,9061,685,723,9163,700,742,9233,710,775,9347,726,';
/** Same file with the MOW-AER 2026-06-01 median 775 → 780 (same size, quantiles still sorted). */
const CHANGED_FORECAST = ORIGINAL_FORECAST.replace(AER_0601, AER_0601.replace(',742,9233,710,775,', ',742,9233,710,780,'));
const AER = { from: 'MOW', to: 'AER', date: '2026-06-01', price: 9500 };

/**
 * Запускает подготовку CSV и, если запрошено apply: true, применяет тот же файл с полученной ревизией.
 * @param app Обязательный запущенный тестовый сервер.
 * @param token Обязательная сессия администратора.
 * @param payload Обязательное тело запроса, включая тип, текст и необязательное имя файла.
 * @param headers Необязательные заголовки, по умолчанию пустые.
 * @returns Ответ проверки или применения; при отказе проверки записей не происходит.
 * @remarks Использует внутренний HTTP-интерфейс Fastify и меняет только данные тестового экземпляра.
 */
async function sendUpload(app: FastifyInstance, token: string, payload: Record<string, unknown>, headers = {}) {
  const { apply = false, ...candidate } = payload;
  const preview = await api(app, 'POST', '/api/admin/upload', token, candidate, headers);
  const revision: unknown = preview.json().revision;
  if (!apply || preview.statusCode !== 200 || typeof revision !== 'string') return preview;
  return api(app, 'POST', '/api/admin/upload', token, { ...candidate, apply, expectedRevision: revision }, headers);
}

/**
 * Считывает ревизию отката для имитации отображённой карточки файла.
 * @param app Обязательный запущенный тестовый сервер.
 * @param token Обязательная сессия администратора.
 * @param kind Обязательный тип CSV.
 * @returns Ревизия отката; неожиданная форма ответа приводит к сбою теста.
 * @remarks Читает метаданные через Fastify; хранилище может закончить восстановление резерва.
 */
async function getRestoreRevision(app: FastifyInstance, token: string, kind: 'forecast' | 'routes'): Promise<string> {
  const info = await api(app, 'GET', '/api/admin/data', token);
  const revision = info.json().revisions[kind];
  expect(revision).toMatch(/^[0-9a-f]{64}$/);
  return revision;
}

/**
 * Выполняет один откат с ревизией из актуальной карточки файла.
 * @param app Обязательный запущенный тестовый сервер.
 * @param token Обязательная сессия администратора.
 * @param payload Тип: forecast или routes; другое значение передаётся для проверки отказа.
 * @returns HTTP-ответ отката, включая код отказа. Меняет лишь тестовые данные при успехе.
 */
async function sendRestore(app: FastifyInstance, token: string, { kind }: { kind: string }) {
  const expectedRevision = kind === 'forecast' || kind === 'routes' ? await getRestoreRevision(app, token, kind) : undefined;
  return api(app, 'POST', '/api/admin/restore', token, { kind, expectedRevision });
}

const tempDirs: string[] = [];
const apps: FastifyInstance[] = [];
afterAll(async () => {
  for (const a of apps) await a.close();
  for (const d of tempDirs) fs.rmSync(d, { recursive: true, force: true });
});

function setupDir(forecastText = ORIGINAL_FORECAST, routesText = ORIGINAL_ROUTES) {
  const dir = makeTempDir('admin');
  tempDirs.push(dir);
  const forecastPath = path.join(dir, 'seasonal_forecast.csv');
  const routesPath = path.join(dir, 'routes.csv');
  fs.writeFileSync(forecastPath, forecastText);
  fs.writeFileSync(routesPath, routesText);
  return { dir, forecastPath, routesPath };
}

async function adminApp(over: Parameters<typeof makeApp>[0] = {}, files = setupDir()) {
  const app = await makeApp({ forecastPath: files.forecastPath, routesPath: files.routesPath, ...over });
  apps.push(app);
  const owner = { email: 'owner@example.test', password: GOOD_PASSWORD };
  await app.auth.ensureInitialAdmin(owner.email, owner.password);
  const admin = await api(app, 'POST', '/api/auth/login', undefined, owner);
  expect(admin.statusCode).toBe(200);
  expect(admin.json().user.role).toBe('admin');
  const adminToken = sessionFrom(admin)!;
  const user = await registerUser(app);
  expect(user.res.json().user.role).toBe('user');
  return { app, adminToken, userToken: user.token, ...files };
}

/** Average 0.5_base_demand per route, as the diff reports it. */
function avgMedian(text: string, route: string): number {
  const fl = parseForecastCsv(text).flights.filter((f) => f.route === route);
  return fl.reduce((s, f) => s + f.quantiles.find((q) => q.q === 0.5)!.baseDemand, 0) / fl.length;
}

describe('admin access control', () => {
  let ctx: Awaited<ReturnType<typeof adminApp>>;
  beforeAll(async () => {
    ctx = await adminApp();
  });

  it.each([
    ['GET', '/api/admin/data', undefined],
    ['GET', '/api/admin/download/forecast', undefined],
    ['GET', '/api/admin/download/routes', undefined],
    ['POST', '/api/admin/upload', { kind: 'forecast', content: ORIGINAL_FORECAST }],
    ['POST', '/api/admin/restore', { kind: 'forecast' }],
  ] as const)('%s %s: anonymous → 401, non-admin → 403', async (method, url, payload) => {
    const anon = await api(ctx.app, method, url, undefined, payload);
    expect(anon.statusCode).toBe(401);
    const user = await api(ctx.app, method, url, ctx.userToken, payload);
    expect(user.statusCode).toBe(403);
    expect(user.json().error).toBe(msg('ru', 'admin_only'));
    const userEn = await api(ctx.app, method, url, ctx.userToken, payload, { 'x-lang': 'en' });
    expect(userEn.json().error).toBe(msg('en', 'admin_only'));
    // Nothing was written by the rejected requests.
    expect(fs.readFileSync(ctx.forecastPath, 'utf8')).toBe(ORIGINAL_FORECAST);
    expect(fs.existsSync(`${ctx.forecastPath}.bak`)).toBe(false);
  });

  it('GET /api/admin/data for the admin', async () => {
    const res = await api(ctx.app, 'GET', '/api/admin/data', ctx.adminToken);
    expect(res.statusCode).toBe(200);
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.json()).toMatchObject({
      data: { ok: true, error: null, version: 1, flights: 155, routes: 5 },
      backups: { forecast: false, routes: false },
      uploadMaxMb: 5,
    });
  });
});

describe('GET /api/admin/download/:kind', () => {
  it.each([
    ['forecast', 'seasonal_forecast.csv', ORIGINAL_FORECAST],
    ['routes', 'routes.csv', ORIGINAL_ROUTES],
  ] as const)('downloads the configured %s CSV', async (kind, name, content) => {
    const { app, adminToken } = await adminApp();
    const res = await api(app, 'GET', `/api/admin/download/${kind}`, adminToken);
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toBe('text/csv; charset=utf-8');
    expect(res.headers['content-disposition']).toContain(`attachment; filename="${name}"`);
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.rawPayload).toEqual(Buffer.from(content));
  });

  it('keeps a configured Unicode filename and downloads the exact bytes of a replacement', async () => {
    const files = setupDir();
    const forecastPath = path.join(files.dir, 'Прогноз (июнь).csv');
    fs.renameSync(files.forecastPath, forecastPath);
    const { app, adminToken } = await adminApp({}, { ...files, forecastPath });
    const replacement = `\uFEFF${CHANGED_FORECAST.replace(/\r?\n/g, '\r\n')}`;
    const upload = await sendUpload(app, adminToken, { kind: 'forecast', content: replacement, apply: true });
    expect(upload.json()).toMatchObject({ ok: true, applied: true });

    const res = await api(app, 'GET', '/api/admin/download/forecast', adminToken);
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-disposition']).toBe(
      `attachment; filename*=UTF-8''${encodeURIComponent('Прогноз (июнь).csv').replace('(', '%28').replace(')', '%29')}`,
    );
    expect(res.rawPayload).toEqual(Buffer.from(replacement));
  });

  it.each([
    ['forecast', 'Прогноз (июнь).csv', 'Прогноз (июль).csv', CHANGED_FORECAST],
    ['routes', 'Маршруты (июнь).csv', 'Маршруты (июль).csv', ORIGINAL_ROUTES],
  ] as const)('сохраняет разные имена одинаковых CSV при переносе и откате (%s)', async (kind, firstName, secondName, content) => {
    const files = setupDir();
    const firstApp = await adminApp({}, files);
    for (const filename of [firstName, secondName]) {
      const upload = await sendUpload(firstApp.app, firstApp.adminToken, { kind, filename, content, apply: true });
      expect(upload.statusCode).toBe(200);
      expect(upload.json()).toMatchObject({ ok: true, applied: true, data: { source: { [kind]: { name: filename } } } });
    }
    if (kind === 'forecast') {
      // Воспроизводим метаданные старого формата, где имена записаны только по статистике файла.
      for (const suffix of ['.names.json', '.bak.names.json']) {
        const file = files.forecastPath + suffix;
        const names = Object.entries(JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, string>);
        fs.writeFileSync(file, JSON.stringify(Object.fromEntries(names.filter(([key]) => !key.startsWith('sha256:')))));
      }
      const status = await api(firstApp.app, 'GET', '/api/admin/data', firstApp.adminToken);
      expect(status.json().backups.forecast).toBe(true);
    }
    await firstApp.app.close();
    apps.splice(apps.indexOf(firstApp.app), 1);

    const moved = setupDir();
    for (const type of ['forecastPath', 'routesPath'] as const) {
      for (const suffix of ['', '.names.json', '.bak', '.bak.names.json']) {
        if (fs.existsSync(files[type] + suffix)) fs.copyFileSync(files[type] + suffix, moved[type] + suffix);
      }
    }
    const { app, adminToken } = await adminApp({}, moved);
    const current = await api(app, 'GET', '/api/admin/data', adminToken);
    expect(current.statusCode).toBe(200);
    expect(current.json().data.source[kind].name).toBe(secondName);

    for (const filename of [secondName, firstName]) {
      if (filename === firstName) {
        const restore = await sendRestore(app, adminToken, { kind });
        expect(restore.statusCode).toBe(200);
        expect(restore.json()).toMatchObject({ ok: true, data: { source: { [kind]: { name: filename } } } });
      }
      const download = await api(app, 'GET', `/api/admin/download/${kind}`, adminToken);
      expect(download.statusCode).toBe(200);
      const encoded = encodeURIComponent(filename).replace('(', '%28').replace(')', '%29');
      expect(download.headers['content-disposition']).toContain(`filename*=UTF-8''${encoded}`);
      expect(download.rawPayload).toEqual(Buffer.from(content));
    }
  });

  it('сохраняет имя и содержимое резервной версии при сбое публикации CSV', async () => {
    const { app, adminToken, forecastPath } = await adminApp();
    /** Отправляет обязательные имя и текст CSV прогноза на тестовый сервер, возвращает ответ применения или ошибку запроса. */
    const upload = (filename: string, content: string) => sendUpload(app, adminToken, {
      kind: 'forecast', filename, content, apply: true,
    });
    expect((await upload('previous.csv', ORIGINAL_FORECAST)).statusCode).toBe(200);
    expect((await upload('current.csv', CHANGED_FORECAST)).statusCode).toBe(200);

    const rename = fs.renameSync;
    const failure = vi.spyOn(fs, 'renameSync').mockImplementation((from, to) => {
      if (to === forecastPath) throw new Error('Проверка сбоя публикации');
      rename(from, to);
    });
    try {
      expect((await upload('failed.csv', ORIGINAL_FORECAST)).statusCode).toBe(500);
    } finally {
      failure.mockRestore();
    }
    const current = await api(app, 'GET', '/api/admin/download/forecast', adminToken);
    expect(current.headers['content-disposition']).toContain('filename="current.csv"');
    expect(current.rawPayload).toEqual(Buffer.from(CHANGED_FORECAST));

    const restored = await sendRestore(app, adminToken, { kind: 'forecast' });
    expect(restored.json().data.source.forecast.name).toBe('previous.csv');
    const previous = await api(app, 'GET', '/api/admin/download/forecast', adminToken);
    expect(previous.headers['content-disposition']).toContain('filename="previous.csv"');
    expect(previous.rawPayload).toEqual(Buffer.from(ORIGINAL_FORECAST));
  });

  it.each([
    ['forecast', 'forecastPath', ORIGINAL_FORECAST, CHANGED_FORECAST],
    ['routes', 'routesPath', ORIGINAL_ROUTES, `${ORIGINAL_ROUTES.trimEnd()}\n\n`],
  ] as const)('повторный запрос не затирает резерв (%s)', async (kind, fileKey, previous, current) => {
    const { app, adminToken, [fileKey]: file } = await adminApp();
    for (const [filename, content] of [['previous.csv', previous], ['current.csv', current], ['current.csv', current]]) {
      const res = await sendUpload(app, adminToken, { kind, filename, content, apply: true });
      expect(res.json()).toMatchObject({ ok: true, applied: true });
    }
    expect(fs.readFileSync(`${file}.bak`, 'utf8')).toBe(previous);
    const restored = await sendRestore(app, adminToken, { kind });
    expect(restored.json()).toMatchObject({ ok: true, data: { source: { [kind]: { name: 'previous.csv' } } } });
    expect(fs.readFileSync(file, 'utf8')).toBe(previous);
    expect(fs.readFileSync(`${file}.bak`, 'utf8')).toBe(current);
  });

  it('после перезапуска завершает запись резерва для уже опубликованного CSV', async () => {
    const files = setupDir();
    const firstApp = await adminApp({}, files);
    const rename = fs.renameSync;
    const failure = vi.spyOn(fs, 'renameSync').mockImplementation((from, to) => {
      if (to === `${files.forecastPath}.bak`) throw new Error('Сбой записи резерва после публикации');
      rename(from, to);
    });
    try {
      const res = await sendUpload(firstApp.app, firstApp.adminToken, {
        kind: 'forecast', filename: 'current.csv', content: CHANGED_FORECAST, apply: true,
      });
      expect(res.json()).toMatchObject({ ok: true, applied: true });
      expect(fs.readFileSync(files.forecastPath, 'utf8')).toBe(CHANGED_FORECAST);
    } finally {
      failure.mockRestore();
    }
    await firstApp.app.close();
    apps.splice(apps.indexOf(firstApp.app), 1);

    const { app, adminToken } = await adminApp({}, files);
    const status = await api(app, 'GET', '/api/admin/data', adminToken);
    expect(status.json()).toMatchObject({ backups: { forecast: true }, data: { source: { forecast: { name: 'current.csv' } } } });
    const restored = await sendRestore(app, adminToken, { kind: 'forecast' });
    expect(restored.json()).toMatchObject({ ok: true, data: { source: { forecast: { name: 'seasonal_forecast.csv' } } } });
    expect(fs.readFileSync(files.forecastPath, 'utf8')).toBe(ORIGINAL_FORECAST);
  });

  it('returns 404 for an unknown kind or a missing CSV', async () => {
    const { app, adminToken, routesPath } = await adminApp();
    const unknown = await api(app, 'GET', '/api/admin/download/other', adminToken);
    expect(unknown.statusCode).toBe(404);
    expect(unknown.json().error).toBe(msg('ru', 'api_not_found'));

    fs.unlinkSync(routesPath);
    const missing = await api(app, 'GET', '/api/admin/download/routes', adminToken);
    expect(missing.statusCode).toBe(404);
    expect(missing.json().error).toBe(msg('ru', 'download_not_found'));
  });
});

describe('POST /api/admin/upload', () => {
  let ctx: Awaited<ReturnType<typeof adminApp>>;
  const upload = (payload: Record<string, unknown>, headers: Record<string, string> = {}) =>
    sendUpload(ctx.app, ctx.adminToken, payload, headers);
  beforeAll(async () => {
    ctx = await adminApp({ uploadMaxMb: 1 });
  });

  it('wrong kind → 400; empty content → 400', async () => {
    for (const kind of [undefined, 'other', 'FORECAST', 1]) {
      const res = await upload({ kind, content: ORIGINAL_FORECAST });
      expect(res.statusCode).toBe(400);
      expect(res.json().error).toBe(msg('ru', 'upload_kind'));
    }
    const empty = await upload({ kind: 'forecast', content: '  \n ' });
    expect(empty.statusCode).toBe(400);
    expect(empty.json().error).toBe(msg('ru', 'upload_empty'));
    const restoreKind = await sendRestore(ctx.app, ctx.adminToken, { kind: 'x' });
    expect(restoreKind.statusCode).toBe(400);
    expect(restoreKind.json().error).toBe(msg('ru', 'upload_kind'));
  });

  it('invalid CSV → {ok:false, error} (localized), nothing written', async () => {
    const res = await upload({ kind: 'forecast', filename: 'bad.csv', content: 'route,date\nMOW-AER,2026-06-01\n', apply: true });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: false, applied: false, error: msg('ru', 'forecast_missing_cols', { cols: 'seats' }) });
    const en = await upload({ kind: 'forecast', content: 'route,date\nMOW-AER,2026-06-01\n' }, { 'x-lang': 'en' });
    expect(en.json().error).toBe(msg('en', 'forecast_missing_cols', { cols: 'seats' }));
    // An error with a line number keeps it.
    const lined = await upload({
      kind: 'forecast',
      content: ORIGINAL_FORECAST.replace(AER_0601, AER_0601.replace('2026-06-01', '2026-02-30')),
    });
    expect(lined.json().error).toBe(msg('ru', 'line_prefix', { line: 2 }) + msg('ru', 'date_invalid', { value: '2026-02-30' }));
    // Invalid routes file.
    const routes = await upload({ kind: 'routes', content: 'route,name\nMOW-AER,x\n' });
    expect(routes.json().ok).toBe(false);
    expect(routes.json().error).toBe(msg('ru', 'routes_missing_cols', { cols: 'base_price, price_sensitivity' }));

    expect(fs.readFileSync(ctx.forecastPath, 'utf8')).toBe(ORIGINAL_FORECAST);
    expect(fs.readFileSync(ctx.routesPath, 'utf8')).toBe(ORIGINAL_ROUTES);
    expect(fs.existsSync(`${ctx.forecastPath}.bak`)).toBe(false);
    expect((await api(ctx.app, 'GET', '/api/admin/data', ctx.adminToken)).json().data.version).toBe(1);
  });

  it('valid preview → summary + diff, no file write, no version bump', async () => {
    const res = await upload({ kind: 'forecast', filename: 'new.csv', content: CHANGED_FORECAST });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.ok).toBe(true);
    expect(body.applied).toBe(false);
    expect(body.warnings).toEqual([]);
    expect(body.summary).toEqual({
      flights: 155,
      routes: ['MOW-AER', 'MOW-LED', 'MOW-KGD', 'MOW-OVB', 'MOW-MRV'],
      dateFrom: '2026-06-01',
      dateTo: '2026-07-01',
      quantileLevels: [0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9],
    });
    const before = avgMedian(ORIGINAL_FORECAST, 'MOW-AER');
    const after = avgMedian(CHANGED_FORECAST, 'MOW-AER');
    expect(body.diff.addedRoutes).toEqual([]);
    expect(body.diff.removedRoutes).toEqual([]);
    expect(body.diff.changedFlights).toBe(1);
    expect(body.diff.removedFlights).toBe(0);
    const aer = body.diff.perRoute.find((r: { route: string }) => r.route === 'MOW-AER');
    expect(aer).toEqual({
      route: 'MOW-AER',
      before: Math.round(before * 10) / 10,
      after: Math.round(after * 10) / 10,
      deltaPct: Math.round(((after - before) / before) * 1000) / 10,
    });
    const led = body.diff.perRoute.find((r: { route: string }) => r.route === 'MOW-LED');
    expect(led.deltaPct).toBe(0);
    expect(body.diff.perRoute.map((r: { route: string }) => r.route)).toEqual([...body.summary.routes].sort());

    expect(body).not.toHaveProperty('data');
    expect(fs.readFileSync(ctx.forecastPath, 'utf8')).toBe(ORIGINAL_FORECAST);
    expect(fs.existsSync(`${ctx.forecastPath}.bak`)).toBe(false);
    expect((await forecast(ctx.app, ctx.adminToken, AER)).json()).toMatchObject({ dataVersion: 1, median: { wants: 704.5 } });
  });

  it('preview reports removed flights and warnings while retaining the catalog route', async () => {
    const header = 'route,date,seats,0.5_base_demand';
    const aer = 'MOW-AER,2026-06-01,900,775';
    const led = 'MOW-LED,2026-06-01,100,75';
    const unknown = 'MOW-XXX,2026-06-01,100,75';
    const { app, adminToken } = await adminApp({}, setupDir([header, aer, led].join('\n')));
    const res = await sendUpload(app, adminToken, { kind: 'forecast', content: [header, aer, unknown].join('\n') });
    const body = res.json();
    expect(body.ok).toBe(true);
    expect(body.summary.flights).toBe(1);
    expect(body.summary.routes).toContain('MOW-LED');
    expect(body.diff.removedRoutes).toEqual([]);
    expect(body.diff.removedFlights).toBe(1);
    expect(body.diff.perRoute).toContainEqual(expect.objectContaining({ route: 'MOW-LED', after: null }));
    expect(body.warnings).toEqual([msg('ru', 'unknown_routes', { list: 'MOW-XXX' })]);
  });

  it('apply → file replaced, .bak created, version bumped, new numbers served', async () => {
    const res = await upload({ kind: 'forecast', filename: 'new.csv', content: CHANGED_FORECAST, apply: true });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.ok).toBe(true);
    expect(body.applied).toBe(true);
    expect(body.data).toMatchObject({ ok: true, error: null, version: 2, flights: 155 });
    expect(fs.readFileSync(ctx.forecastPath, 'utf8')).toBe(CHANGED_FORECAST);
    expect(fs.readFileSync(`${ctx.forecastPath}.bak`, 'utf8')).toBe(ORIGINAL_FORECAST);
    // No temp files are left next to the data file.
    expect(fs.readdirSync(path.dirname(ctx.forecastPath)).filter((f) => f.endsWith('.tmp'))).toEqual([]);

    const r = (await forecast(ctx.app, ctx.userToken, AER)).json();
    expect(r.dataVersion).toBe(2);
    expect(r.median.wants).toBe(709.5); // 780 − 0.141 × 500
    const info = (await api(ctx.app, 'GET', '/api/admin/data', ctx.adminToken)).json();
    expect(info.backups).toEqual({ forecast: true, routes: false });
    expect(info.data.version).toBe(2);
  });

  it('restore → back to the old file and numbers; restore without a backup → 404', async () => {
    const res = await sendRestore(ctx.app, ctx.adminToken, { kind: 'forecast' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ ok: true, data: { ok: true, version: 3 } });
    expect(fs.readFileSync(ctx.forecastPath, 'utf8')).toBe(ORIGINAL_FORECAST);
    const r = (await forecast(ctx.app, ctx.userToken, AER)).json();
    expect(r.median.wants).toBe(704.5);
    expect(r.dataVersion).toBe(3);

    const none = await sendRestore(ctx.app, ctx.adminToken, { kind: 'routes' });
    expect(none.statusCode).toBe(404);
    expect(none.json().error).toBe(msg('ru', 'not_found'));
  });

  it('routes upload: apply changes the numbers; restore brings them back', async () => {
    const changedRoutes = ORIGINAL_ROUTES.replace('9000,4200,0.141,', '9000,4200,0.282,');
    const preview = (await upload({ kind: 'routes', content: changedRoutes })).json();
    expect(preview.ok).toBe(true);
    expect(preview.diff.changedFlights).toBe(0); // forecast rows unchanged
    expect(preview.diff.changedRoutes).toEqual(['MOW-AER']);
    const applied = (await upload({ kind: 'routes', content: changedRoutes, apply: true })).json();
    expect(applied.applied).toBe(true);
    expect((await forecast(ctx.app, ctx.userToken, AER)).json().median.wants).toBe(634);
    expect(fs.readFileSync(`${ctx.routesPath}.bak`, 'utf8')).toBe(ORIGINAL_ROUTES);
    await sendRestore(ctx.app, ctx.adminToken, { kind: 'routes' });
    expect((await forecast(ctx.app, ctx.userToken, AER)).json().median.wants).toBe(704.5);
  });

  it.each([false, true])('при сокращении справочника показывает исключённые рейсы в списке изменений (с дубликатом: %s)', async (hasDuplicate) => {
    const unknownRow = 'MOW-XXX,2026-06-01,900,775';
    const forecastContent = [
      'route,date,seats,0.5_base_demand',
      'MOW-AER,2026-06-01,900,775',
      'MOW-LED,2026-06-01,100,75',
      unknownRow,
    ].join('\n');
    const header = 'route,name,base_price,cost_per_passenger,price_sensitivity,price_min,price_max';
    const aer = 'MOW-AER,Москва — Сочи,9000,4200,0.141,5400,18000';
    const led = 'MOW-LED,Москва — Санкт-Петербург,5500,2600,0.294,3300,11000';
    const { app, adminToken } = await adminApp({}, setupDir(forecastContent, [header, aer, led].join('\n')));
    const routes = [header, aer, ...(hasDuplicate ? [aer] : [])].join('\n');

    const res = await sendUpload(app, adminToken, { kind: 'routes', content: routes });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      ok: true,
      applied: false,
      summary: { flights: 1 },
      diff: { removedRoutes: ['MOW-LED'], removedFlights: 1 },
      warnings: hasDuplicate ? [msg('ru', 'route_duplicate', { line: 3, code: 'MOW-AER' })] : [],
    });
  });

  it('предупреждает об исчезновении рейсов при полной замене маршрутов', async () => {
    const { app, adminToken } = await adminApp({}, setupDir('route,date,seats,0.5_base_demand\nMOW-AER,2026-06-01,900,775\n'));
    const header = ORIGINAL_ROUTES.split(/\r?\n/, 1)[0];
    const content = `${header}\nMOW-XXX,Москва — Новый город,9000,4200,0.141,5400,18000\n`;

    const res = await sendUpload(app, adminToken, { kind: 'routes', content });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      ok: true,
      applied: false,
      summary: { flights: 0 },
      diff: { removedRoutes: expect.arrayContaining(['MOW-AER']), removedFlights: 1 },
      warnings: ['В новом справочнике нет ни одного маршрута из текущего прогноза. После замены рейсы не будут отображаться.'],
    });
  });

  it('Excel RU upload (semicolon, decimal comma, BOM) is accepted', async () => {
    const excel =
      String.fromCharCode(0xfeff) +
      ORIGINAL_ROUTES.trimEnd()
        .split('\n')
        .map((l) => l.split(',').map((c) => c.replace('.', ',')).join(';'))
        .join('\r\n');
    const res = (await upload({ kind: 'routes', content: excel })).json();
    expect(res.ok).toBe(true);
    expect(res.diff.changedFlights).toBe(0);
  });

  it('content larger than uploadMaxMb → 413 (both the app check and the body limit)', async () => {
    const big = ORIGINAL_FORECAST + '#'.repeat(1024 * 1024);
    const res = await upload({ kind: 'forecast', content: big });
    expect(res.statusCode).toBe(413);
    expect(res.json().error).toBe(msg('ru', 'upload_too_large', { mb: 1 }));
    // Over the route bodyLimit (2 × uploadMaxMb + 4 KB) Fastify rejects the body itself.
    const huge = await upload({ kind: 'forecast', content: '#'.repeat(2 * 1024 * 1024 + 8192) });
    expect(huge.statusCode).toBe(413);
    expect(huge.json().error).toBe(msg('ru', 'body_too_large'));
    expect(fs.readFileSync(ctx.forecastPath, 'utf8')).toBe(ORIGINAL_FORECAST);
  });

  it('the normal 16 KB body limit still applies to other endpoints', async () => {
    const res = await api(ctx.app, 'POST', '/api/forecast', ctx.adminToken, { ...AER, pad: 'x'.repeat(20 * 1024) });
    expect(res.statusCode).toBe(413);
  });
});

describe('uploading the route directory before its forecast', () => {
  it.each([
    { name: 'one added route', keepOriginalRoutes: true, routes: 6, flights: 155 },
    { name: 'a replacement with no matching routes', keepOriginalRoutes: false, routes: 1, flights: 0 },
  ])('$name appears in preview and meta immediately', async ({ keepOriginalRoutes, routes, flights }) => {
    const ctx = await adminApp();
    const existingRows = keepOriginalRoutes ? ORIGINAL_ROUTES.trimEnd() : ORIGINAL_ROUTES.split(/\r?\n/, 1)[0];
    const content = `${existingRows}\nAER-MOW,Сочи — Москва,9000,4200,0.141,5400,18000\n`;
    const preview = await sendUpload(ctx.app, ctx.adminToken, { kind: 'routes', content });
    expect(preview.statusCode).toBe(200);
    expect(preview.json()).toMatchObject({
      ok: true,
      applied: false,
      summary: { flights, routes: expect.arrayContaining(['AER-MOW']) },
      diff: { addedRoutes: ['AER-MOW'] },
    });
    expect(preview.json().summary.routes).toHaveLength(routes);
    expect(fs.readFileSync(ctx.routesPath, 'utf8')).toBe(ORIGINAL_ROUTES);

    const applied = await sendUpload(ctx.app, ctx.adminToken, { kind: 'routes', content, apply: true });
    expect(applied.statusCode).toBe(200);
    expect(applied.json()).toMatchObject({ ok: true, applied: true, data: { flights, routes } });
    const afterRoutes = await meta(ctx.app, ctx.userToken);
    expect(afterRoutes.statusCode).toBe(200);
    expect(afterRoutes.json().routes).toContainEqual(expect.objectContaining({ code: 'AER-MOW', dates: [], seats: [] }));

    const forecastRow = ORIGINAL_FORECAST.split(/\r?\n/).find((row) => row.startsWith(AER_0601))!;
    const forecastContent = `${ORIGINAL_FORECAST.trimEnd()}\n${forecastRow.replace('MOW-AER', 'AER-MOW')}\n`;
    const appliedForecast = await sendUpload(ctx.app, ctx.adminToken, {
      kind: 'forecast', content: forecastContent, apply: true,
    });
    expect(appliedForecast.statusCode).toBe(200);
    expect(appliedForecast.json()).toMatchObject({ ok: true, applied: true, data: { flights: flights + 1, routes } });
    const afterForecast = await meta(ctx.app, ctx.userToken);
    expect(afterForecast.json().routes).toContainEqual(expect.objectContaining({ code: 'AER-MOW', dates: ['2026-06-01'], seats: [900] }));
    const prediction = await forecast(ctx.app, ctx.userToken, { ...AER, from: 'AER', to: 'MOW' });
    expect(prediction.statusCode).toBe(200);
    expect(prediction.json().median.wants).toBe(704.5);
  });
});

describe('admin recovery when no data is loaded', () => {
  // При холодном запуске без снимка можно починить один CSV, если второй остаётся исправным.
  it('an admin can upload a valid forecast when the current one failed to load', async () => {
    const files = setupDir('route,date\nMOW-AER,2026-06-01\n', ORIGINAL_ROUTES);
    const ctx = await adminApp({}, files);
    expect((await ctx.app.inject({ method: 'GET', url: '/api/health' })).statusCode).toBe(503);
    const res = await sendUpload(ctx.app, ctx.adminToken, {
      kind: 'forecast',
      content: ORIGINAL_FORECAST,
      apply: true,
    });
    expect(res.json()).toMatchObject({ ok: true, applied: true });
    expect((await forecast(ctx.app, ctx.userToken, AER)).json().median.wants).toBe(704.5);
  });

  it('an admin can upload a missing routes.csv while the forecast file is fine', async () => {
    const files = setupDir();
    fs.rmSync(files.routesPath);
    const ctx = await adminApp({}, files);
    const res = await sendUpload(ctx.app, ctx.adminToken, {
      kind: 'routes',
      content: ORIGINAL_ROUTES,
      apply: true,
    });
    expect(res.json()).toMatchObject({ ok: true, applied: true });
    expect((await forecast(ctx.app, ctx.userToken, AER)).json().median.wants).toBe(704.5);
  });

  it('restore works even when the current data is broken', async () => {
    const files = setupDir();
    const ctx = await adminApp({}, files);
    // Apply a valid change (creates .bak), then break the file on disk by hand.
    await sendUpload(ctx.app, ctx.adminToken, { kind: 'forecast', content: CHANGED_FORECAST, apply: true });
    fs.writeFileSync(`${files.forecastPath}.bak`, ORIGINAL_FORECAST);
    fs.writeFileSync(files.forecastPath, 'garbage');
    const t = new Date(Date.now() + 60_000);
    fs.utimesSync(files.forecastPath, t, t);
    expect((await api(ctx.app, 'GET', '/api/admin/data', ctx.adminToken)).json().data.ok).toBe(false);
    const res = await sendRestore(ctx.app, ctx.adminToken, { kind: 'forecast' });
    expect(res.json()).toMatchObject({ ok: true, data: { ok: true, error: null } });
    expect((await forecast(ctx.app, ctx.userToken, AER)).json().median.wants).toBe(704.5);
    expect(fs.readFileSync(`${files.forecastPath}.bak`, 'utf8')).toBe(ORIGINAL_FORECAST);
  });

  it.each([
    ['forecast', 'forecastPath', ORIGINAL_FORECAST],
    ['routes', 'routesPath', ORIGINAL_ROUTES],
  ] as const)('не восстанавливает повреждённый резерв (%s)', async (kind, fileKey, original) => {
    const { app, adminToken, [fileKey]: file } = await adminApp();
    fs.writeFileSync(`${file}.bak`, 'garbage');
    const res = await sendRestore(app, adminToken, { kind });
    expect(res.statusCode).toBe(422);
    expect(fs.readFileSync(file, 'utf8')).toBe(original);
  });
});

describe('подтверждение замены CSV при конкурентных запросах', () => {
  it('ограничивает суммарное число предпросмотров и применений с одного IP', async () => {
    const { app, adminToken, forecastPath } = await adminApp({ adminUploadRateLimitPerMinute: 1 });
    const candidate = { kind: 'forecast', content: CHANGED_FORECAST };
    const preview = await sendUpload(app, adminToken, candidate);
    expect(preview.json().revision).toMatch(/^[0-9a-f]{64}$/);
    const denied = await api(app, 'POST', '/api/admin/upload', adminToken, {
      ...candidate, apply: true, expectedRevision: preview.json().revision,
    });
    expect(denied.statusCode).toBe(429);
    expect(fs.readFileSync(forecastPath, 'utf8')).toBe(ORIGINAL_FORECAST);
    expect(fs.existsSync(`${forecastPath}.bak`)).toBe(false);
  });

  it.each([
    ['forecast', 'forecastPath', ORIGINAL_FORECAST, CHANGED_FORECAST],
    ['routes', 'routesPath', ORIGINAL_ROUTES, ORIGINAL_ROUTES.replace('9000,4200,0.141,', '9000,4200,0.282,')],
  ] as const)('выполняет один откат из 20 одновременных запросов (%s)', async (kind, fileKey, original, replacement) => {
    const { app, adminToken, [fileKey]: file } = await adminApp();
    const saved = await sendUpload(app, adminToken, { kind, content: replacement, filename: 'changed.csv', apply: true });
    expect(saved.json()).toMatchObject({ applied: true, data: { version: 2 } });
    const revision = await getRestoreRevision(app, adminToken, kind);
    const results = await Promise.all(Array.from({ length: 20 }, () => api(
      app, 'POST', '/api/admin/restore', adminToken, { kind, expectedRevision: revision },
    )));
    const codes = results.map((res) => res.statusCode).sort();
    expect(codes).toEqual([200, ...Array(19).fill(409)]);
    expect(results.find((res) => res.statusCode === 200)?.json().data.version).toBe(3);
    expect(fs.readFileSync(file, 'utf8')).toBe(original);
    expect(fs.readFileSync(`${file}.bak`, 'utf8')).toBe(replacement);

    const replay = await api(app, 'POST', '/api/admin/restore', adminToken, { kind, expectedRevision: revision });
    expect(replay.statusCode).toBe(409);
    expect(fs.readFileSync(file, 'utf8')).toBe(original);
    const deliberateUndo = await sendRestore(app, adminToken, { kind });
    expect(deliberateUndo.json()).toMatchObject({ ok: true, data: { version: 4, source: { [kind]: { name: 'changed.csv' } } } });
    expect(fs.readFileSync(file, 'utf8')).toBe(replacement);
  });

  it('требует предпросмотр именно применяемого имени и содержимого CSV', async () => {
    const { app, adminToken, forecastPath } = await adminApp();
    const candidate = { kind: 'forecast', filename: 'preview.csv', content: CHANGED_FORECAST };
    const missingUpload = await api(app, 'POST', '/api/admin/upload', adminToken, { ...candidate, apply: true });
    const missingRestore = await api(app, 'POST', '/api/admin/restore', adminToken, { kind: 'forecast' });
    expect([missingUpload.statusCode, missingRestore.statusCode]).toEqual([428, 428]);
    const { revision } = (await sendUpload(app, adminToken, candidate)).json();
    const tampered = await Promise.all([
      { ...candidate, filename: 'another.csv' },
      { ...candidate, content: ORIGINAL_FORECAST },
      { ...candidate, kind: 'routes' },
    ].map((payload) => api(app, 'POST', '/api/admin/upload', adminToken, { ...payload, apply: true, expectedRevision: revision })));
    expect(tampered.map((response) => response.statusCode)).toEqual([409, 409, 409]);
    expect(fs.readFileSync(forecastPath, 'utf8')).toBe(ORIGINAL_FORECAST);
    expect(fs.existsSync(`${forecastPath}.bak`)).toBe(false);
  });

  it('запрещает применять предпросмотр после записи второго CSV, даже при исходных размере и mtime', async () => {
    const { app, adminToken, routesPath, forecastPath } = await adminApp();
    const changedRoutes = ORIGINAL_ROUTES.replace('9000,4200,0.141,', '9000,4200,0.282,');
    const fixedTime = new Date('2025-01-02T03:04:05Z');
    fs.utimesSync(routesPath, fixedTime, fixedTime);
    const candidate = { kind: 'forecast', content: CHANGED_FORECAST };
    const { revision } = (await sendUpload(app, adminToken, candidate)).json();
    const before = fs.statSync(routesPath, { bigint: true });
    fs.writeFileSync(routesPath, changedRoutes);
    fs.utimesSync(routesPath, fixedTime, fixedTime);
    const after = fs.statSync(routesPath, { bigint: true });
    expect([after.ino, after.size, after.mtimeNs]).toEqual([before.ino, before.size, before.mtimeNs]);
    const response = await api(app, 'POST', '/api/admin/upload', adminToken, {
      ...candidate, apply: true, expectedRevision: revision,
    });
    expect(response.statusCode).toBe(409);
    expect(fs.readFileSync(forecastPath, 'utf8')).toBe(ORIGINAL_FORECAST);
    expect((await forecast(app, adminToken, AER)).json().median.wants).toBe(634);
  });

  it('сериализует загрузку и откат, подтверждённые для одного состояния', async () => {
    const { app, adminToken, forecastPath } = await adminApp();
    const previous = await sendUpload(app, adminToken, { kind: 'forecast', content: CHANGED_FORECAST, apply: true });
    expect(previous.json().applied).toBe(true);
    const candidate = { kind: 'forecast', content: CHANGED_FORECAST.trimEnd() + '\n\n', filename: 'latest.csv' };
    const { revision } = (await sendUpload(app, adminToken, candidate)).json();
    const rollback = await getRestoreRevision(app, adminToken, 'forecast');
    const [upload, restore] = await Promise.all([
      api(app, 'POST', '/api/admin/upload', adminToken, { ...candidate, apply: true, expectedRevision: revision }),
      api(app, 'POST', '/api/admin/restore', adminToken, { kind: 'forecast', expectedRevision: rollback }),
    ]);
    expect([upload.statusCode, restore.statusCode].sort()).toEqual([200, 409]);
    expect(fs.readFileSync(forecastPath, 'utf8')).toBe(upload.statusCode === 200 ? candidate.content : ORIGINAL_FORECAST);
    expect(fs.readFileSync(`${forecastPath}.bak`, 'utf8')).toBe(CHANGED_FORECAST);
  });

  it('запрещает откат, если оставшийся CSV повреждён, и сохраняет резерв', async () => {
    const { app, adminToken, forecastPath, routesPath } = await adminApp();
    const changed = await sendUpload(app, adminToken, { kind: 'forecast', content: CHANGED_FORECAST, apply: true });
    expect(changed.json().applied).toBe(true);
    fs.writeFileSync(routesPath, 'broken');
    const restore = await sendRestore(app, adminToken, { kind: 'forecast' });
    expect(restore.statusCode).toBe(422);
    expect(fs.readFileSync(forecastPath, 'utf8')).toBe(CHANGED_FORECAST);
    expect(fs.readFileSync(`${forecastPath}.bak`, 'utf8')).toBe(ORIGINAL_FORECAST);
  });

  it('проверяет изменения второго CSV ещё раз после подготовки резерва', async () => {
    const { app, adminToken, forecastPath, routesPath } = await adminApp();
    const seed = await sendUpload(app, adminToken, { kind: 'forecast', content: CHANGED_FORECAST, apply: true });
    expect(seed.json().applied).toBe(true);
    const candidate = { kind: 'forecast', content: ORIGINAL_FORECAST, filename: 'candidate.csv' };
    const { revision } = (await sendUpload(app, adminToken, candidate)).json();
    const rename = fs.renameSync;
    const overwrite = vi.spyOn(fs, 'renameSync').mockImplementation((from, to) => {
      rename(from, to);
      if (to === `${forecastPath}.bak.transaction`) {
        fs.writeFileSync(routesPath, ORIGINAL_ROUTES.replace('9000,4200,0.141,', '9000,4200,0.282,'));
      }
    });
    try {
      const applied = await api(app, 'POST', '/api/admin/upload', adminToken, { ...candidate, apply: true, expectedRevision: revision });
      expect(applied.statusCode).toBe(409);
    } finally {
      overwrite.mockRestore();
    }
    const info = await api(app, 'GET', '/api/admin/data', adminToken);
    expect(info.json().backups.forecast).toBe(true);
    expect(fs.readFileSync(forecastPath, 'utf8')).toBe(CHANGED_FORECAST);
    expect(fs.readFileSync(`${forecastPath}.bak`, 'utf8')).toBe(ORIGINAL_FORECAST);
  });

  it('позволяет восстановить оба повреждённых активных CSV по очереди', async () => {
    const files = setupDir('broken', 'broken');
    fs.writeFileSync(`${files.forecastPath}.bak`, ORIGINAL_FORECAST);
    fs.writeFileSync(`${files.routesPath}.bak`, ORIGINAL_ROUTES);
    const { app, adminToken } = await adminApp({}, files);
    expect((await app.inject('/api/health')).statusCode).toBe(503);
    const first = await sendRestore(app, adminToken, { kind: 'forecast' });
    expect(first.json()).toMatchObject({ ok: true, data: { ok: false } });
    expect(fs.readFileSync(files.forecastPath, 'utf8')).toBe(ORIGINAL_FORECAST);
    expect((await app.inject('/api/health')).statusCode).toBe(503);
    const second = await sendRestore(app, adminToken, { kind: 'routes' });
    expect(second.json()).toMatchObject({ ok: true, data: { ok: true, flights: 155, routes: 5 } });
    expect((await app.inject('/api/health')).statusCode).toBe(200);
  });

  it('не предлагает старый резерв после повреждения журнала и создаёт новый при подтверждённой замене', async () => {
    const { app, adminToken, forecastPath } = await adminApp();
    const seed = await sendUpload(app, adminToken, { kind: 'forecast', content: CHANGED_FORECAST, apply: true });
    expect(seed.json().applied).toBe(true);
    fs.writeFileSync(`${forecastPath}.bak.transaction`, '87:123:');
    const blocked = await api(app, 'GET', '/api/admin/data', adminToken);
    expect(blocked.json().backups.forecast).toBe(false);
    const repaired = await sendUpload(app, adminToken, {
      kind: 'forecast', filename: 'repair.csv', content: ORIGINAL_FORECAST, apply: true,
    });
    expect(repaired.json()).toMatchObject({ ok: true, applied: true, data: { ok: true } });
    expect(fs.readFileSync(`${forecastPath}.bak`, 'utf8')).toBe(CHANGED_FORECAST);
    expect(fs.existsSync(`${forecastPath}.bak.transaction`)).toBe(false);
    const restored = await sendRestore(app, adminToken, { kind: 'forecast' });
    expect(restored.json()).toMatchObject({ ok: true, data: { ok: true } });
    expect(fs.readFileSync(forecastPath, 'utf8')).toBe(CHANGED_FORECAST);
  });
});
