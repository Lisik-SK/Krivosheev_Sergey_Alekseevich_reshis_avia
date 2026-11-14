import fs from 'node:fs';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { parseForecastCsv, parseRoutesCsv } from '../../src/shared/dataset';
import { boardStatus, computeForecast, daySummary, optimalPrice, profitCurve } from '../../src/shared/forecast';
import { msg } from '../../src/shared/messages';
import { api, DATA_FORECAST, DATA_ROUTES, makeApp, registerUser } from './helpers';

const { routes: ROUTES } = parseRoutesCsv(fs.readFileSync(DATA_ROUTES, 'utf8'));
const { flights: FLIGHTS } = parseForecastCsv(fs.readFileSync(DATA_FORECAST, 'utf8'));
const routeOf = (code: string) => ROUTES.find((r) => r.code === code)!;
const flightOf = (code: string, date: string) => FLIGHTS.find((f) => f.route === code && f.date === date)!;
const AER = routeOf('MOW-AER');

let app: FastifyInstance;
let token: string;
let otherToken: string;

beforeAll(async () => {
  app = await makeApp();
  ({ token } = await registerUser(app));
  ({ token: otherToken } = await registerUser(app));
});
afterAll(async () => {
  await app.close();
});

const post = (url: string, payload: unknown, t: string | undefined = token, headers: Record<string, string> = {}) =>
  api(app, 'POST', url, t, payload, headers);

describe('authorization of the new endpoints', () => {
  it.each([
    ['POST', '/api/forecast/curve'],
    ['POST', '/api/forecast/month'],
    ['POST', '/api/forecast/board'],
    ['GET', '/api/history'],
    ['POST', '/api/history'],
    ['PATCH', '/api/history/1'],
    ['DELETE', '/api/history?mode=all'],
    ['DELETE', '/api/history/1'],
  ] as const)('%s %s → 401 without a session', async (method, url) => {
    const res = await api(app, method, url, undefined, method === 'GET' ? undefined : {});
    expect(res.statusCode).toBe(401);
    expect(res.json().error).toBe(msg('ru', 'login_required'));
  });
});

describe('POST /api/forecast/curve', () => {
  it('returns 61 points, bounds, model price and the optimum for the median', async () => {
    const res = await post('/api/forecast/curve', { from: 'Москва', to: 'Сочи', date: '01.06.2026' });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    const flight = flightOf('MOW-AER', '2026-06-01');
    expect(body).toMatchObject({
      route: 'MOW-AER',
      date: '2026-06-01',
      seats: 900,
      bounds: { min: 5400, max: 18000 },
      basePrice: 9000,
      costPerPassenger: 4200,
      modelPrice: 9347,
      dataVersion: 1,
    });
    expect(body.points).toEqual(profitCurve(775, 900, AER, 61));
    expect(body.points).toHaveLength(61);
    expect(body.optimum).toEqual(optimalPrice(775, 900, AER));
    expect(body.optimum.objective).toBe('margin');
    // The optimum is at least as good as every point on the curve.
    for (const p of body.points) expect(body.optimum.margin).toBeGreaterThanOrEqual(p.margin - 1e-6);
    // Points follow the formula.
    const p = body.points[10];
    expect(p.sales).toBe(computeForecast(flight, AER, p.price).median.sales);
  });

  it('validation: date required (no price needed), bad date, out of range, unknown route', async () => {
    const missing = await post('/api/forecast/curve', {});
    expect(missing.statusCode).toBe(400);
    expect(missing.json().fields).toEqual({
      from: msg('ru', 'from_required'),
      to: msg('ru', 'to_required'),
      date: msg('ru', 'date_required'),
    });
    const bad = await post('/api/forecast/curve', { from: 'MOW', to: 'AER', date: '2026-02-30' });
    expect(bad.json().fields).toEqual({ date: msg('ru', 'date_format') });
    const out = await post('/api/forecast/curve', { from: 'MOW', to: 'AER', date: '2026-08-01' });
    expect(out.statusCode).toBe(404);
    expect(Object.keys(out.json().fields)).toEqual(['date']);
    const noRoute = await post('/api/forecast/curve', { from: 'AER', to: 'MOW', date: '2026-06-01' }, token, { 'x-lang': 'en' });
    expect(noRoute.statusCode).toBe(404);
    expect(noRoute.json().error).toBe(msg('en', 'route_missing', { from: 'AER', to: 'MOW', hint: msg('en', 'route_hint_none') }));
  });
});

describe('POST /api/forecast/month', () => {
  it('returns a day summary for every date of the route at one price', async () => {
    const res = await post('/api/forecast/month', { from: 'MOW', to: 'LED', price: '6 000' });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.route).toBe('MOW-LED');
    expect(body.price).toBe(6000);
    expect(body.dataVersion).toBe(1);
    expect(body.days).toHaveLength(31);
    expect(body.days.map((d: { date: string }) => d.date)).toEqual(
      FLIGHTS.filter((f) => f.route === 'MOW-LED').map((f) => f.date),
    );
    const led = routeOf('MOW-LED');
    for (const d of body.days) expect(d).toEqual(daySummary(flightOf('MOW-LED', d.date), led, 6000));
    expect(body.days.find((d: { date: string }) => d.date === '2026-06-15').wants).toBe(780); // 927 − 0.294 × 500
  });

  it('rounds the price to kopecks; a date is not required', async () => {
    const res = await post('/api/forecast/month', { from: 'MOW', to: 'AER', price: 9500.555, date: 'garbage is ignored' });
    expect(res.statusCode).toBe(200);
    expect(res.json().price).toBe(9500.56);
  });

  it('validation', async () => {
    const res = await post('/api/forecast/month', { from: 'MOW', to: 'AER' });
    expect(res.statusCode).toBe(400);
    expect(res.json().fields).toEqual({ price: msg('ru', 'price_required') });
    const neg = await post('/api/forecast/month', { from: 'MOW', to: 'MOW', price: -1 });
    expect(neg.json().fields).toEqual({ to: msg('ru', 'same_city'), price: msg('ru', 'price_negative') });
  });
});

describe('POST /api/forecast/board', () => {
  it('without a date shows the first forecast day at base prices', async () => {
    const res = await post('/api/forecast/board', {});
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.date).toBe('2026-06-01');
    expect(body.priceMode).toBe('base');
    expect(body.dates).toHaveLength(31);
    expect(body.dates[0]).toBe('2026-06-01');
    expect(body.dates[30]).toBe('2026-07-01');
    expect(body.flights.map((f: { route: string }) => f.route)).toEqual(['MOW-AER', 'MOW-LED', 'MOW-KGD', 'MOW-OVB', 'MOW-MRV']);
    for (const f of body.flights) {
      const route = routeOf(f.route);
      const r = computeForecast(flightOf(f.route, '2026-06-01'), route, route.basePrice);
      expect(f).toEqual({
        route: route.code,
        origin: route.origin,
        destination: route.destination,
        price: route.basePrice,
        seats: r.seats,
        wants: r.median.wants,
        sales: r.median.sales,
        rounded: r.median.rounded,
        loadFactor: r.median.loadFactor,
        sellOut: r.sellOut,
        status: boardStatus(r.median.wants, r.seats),
        revenue: r.economics.revenue,
      });
    }
    // MOW-AER on 2026-06-01 at 9000: 775 / 900 = 0.86 → filling
    expect(body.flights[0].status).toBe('filling');
  });

  it('priceMode "model" uses the 0.5_price from the file', async () => {
    const body = (await post('/api/forecast/board', { date: '01.06.2026', priceMode: 'model' })).json();
    expect(body.priceMode).toBe('model');
    const aer = body.flights.find((f: { route: string }) => f.route === 'MOW-AER');
    expect(aer.price).toBe(9347);
    expect(aer.wants).toBe(726.073); // 775 − 0.141 × 347
    for (const f of body.flights) {
      expect(f.price).toBe(flightOf(f.route, '2026-06-01').quantiles.find((q) => q.q === 0.5)!.price);
    }
  });

  it('unknown priceMode falls back to base; a specific date is honoured', async () => {
    const body = (await post('/api/forecast/board', { date: '2026-06-15', priceMode: 'hack' })).json();
    expect(body.priceMode).toBe('base');
    expect(body.date).toBe('2026-06-15');
    expect(body.flights).toHaveLength(5);
  });

  it('a date outside the forecast gives an empty board; a malformed date is a 400', async () => {
    const empty = (await post('/api/forecast/board', { date: '2027-01-01' })).json();
    expect(empty.flights).toEqual([]);
    const bad = await post('/api/forecast/board', { date: '2026-13-01' });
    expect(bad.statusCode).toBe(400);
    expect(bad.json().fields).toEqual({ date: msg('ru', 'date_format') });
  });
});

describe('history', () => {
  const calc = (price: number | string, t = token, date = '2026-06-01') =>
    post('/api/history', { from: 'MOW', to: 'AER', date, price }, t);
  const list = async (t = token) => (await api(app, 'GET', '/api/history', t)).json().items as Array<Record<string, unknown>>;

  it('starts empty and stores a calculation with its result', async () => {
    expect(await list()).toEqual([]);
    const res = await calc(9500);
    expect(res.statusCode).toBe(200);
    const items = res.json().items;
    expect(items).toHaveLength(1);
    expect(items[0]).toEqual({
      id: expect.any(Number),
      route: 'MOW-AER',
      from: AER.origin,
      to: AER.destination,
      date: '2026-06-01',
      price: 9500,
      seats: 900,
      sales: 704.5,
      wants: 704.5,
      pinned: false,
      createdAt: expect.any(String),
    });
    expect(Number.isNaN(Date.parse(items[0].createdAt))).toBe(false);
    const get = await api(app, 'GET', '/api/history', token);
    expect(get.headers['cache-control']).toBe('no-store');
  });

  it('consecutive identical calculations are de-duplicated; a different one is added on top', async () => {
    await calc(9500);
    await calc('9 500');
    expect(await list()).toHaveLength(1);
    await calc(10000);
    let items = await list();
    expect(items.map((i) => i.price)).toEqual([10000, 9500]);
    // Not consecutive any more → a new entry.
    await calc(9500);
    items = await list();
    expect(items.map((i) => i.price)).toEqual([9500, 10000, 9500]);
  });

  it('validates like /api/forecast and does not store invalid calculations', async () => {
    const before = (await list()).length;
    const res = await post('/api/history', { from: 'MOW', to: 'AER', date: '2026-08-01', price: 9500 });
    expect(res.statusCode).toBe(404);
    const res2 = await post('/api/history', { from: 'MOW', to: 'AER', date: '2026-06-01' });
    expect(res2.json().fields).toEqual({ price: msg('ru', 'price_required') });
    expect(await list()).toHaveLength(before);
  });

  it('pin / unpin with PATCH; pinned items come first', async () => {
    const items = await list();
    const oldest = items[items.length - 1]!;
    const res = await api(app, 'PATCH', `/api/history/${oldest.id}`, token, { pinned: true });
    expect(res.statusCode).toBe(200);
    expect(res.json().items[0]).toMatchObject({ id: oldest.id, pinned: true });
    const unpinned = await api(app, 'PATCH', `/api/history/${oldest.id}`, token, { pinned: false });
    expect(unpinned.json().items.find((i: { id: number }) => i.id === oldest.id).pinned).toBe(false);
    // Anything but `true` unpins.
    await api(app, 'PATCH', `/api/history/${oldest.id}`, token, { pinned: true });
    const weird = await api(app, 'PATCH', `/api/history/${oldest.id}`, token, { pinned: 'yes' });
    expect(weird.json().items.find((i: { id: number }) => i.id === oldest.id).pinned).toBe(false);
  });

  it('keeps at most 30 unpinned entries but never drops pinned ones', async () => {
    const first = (await list())[0]!;
    await api(app, 'PATCH', `/api/history/${first.id}`, token, { pinned: true });
    for (let i = 0; i < 35; i++) await calc(6000 + i, token, `2026-06-${String((i % 28) + 1).padStart(2, '0')}`);
    const items = await list();
    const pinned = items.filter((i) => i.pinned);
    const unpinned = items.filter((i) => !i.pinned);
    expect(pinned.map((i) => i.id)).toEqual([first.id]);
    expect(unpinned).toHaveLength(30);
    // The newest 30 are kept, newest first.
    expect(unpinned[0]!.price).toBe(6034);
    expect(unpinned[29]!.price).toBe(6005);
  });

  it('DELETE removes an entry', async () => {
    const items = await list();
    const victim = items[1]!;
    const res = await api(app, 'DELETE', `/api/history/${victim.id}`, token);
    expect(res.statusCode).toBe(200);
    expect(res.json().items.some((i: { id: number }) => i.id === victim.id)).toBe(false);
    const again = await api(app, 'DELETE', `/api/history/${victim.id}`, token);
    expect(again.statusCode).toBe(404);
    expect(again.json().error).toBe(msg('ru', 'history_not_found'));
  });

  it('users cannot see or modify each other’s entries (404)', async () => {
    const mine = await list();
    expect(mine.length).toBeGreaterThan(0);
    expect(await list(otherToken)).toEqual([]);
    const target = mine[0]!;
    const patch = await api(app, 'PATCH', `/api/history/${target.id}`, otherToken, { pinned: false });
    expect(patch.statusCode).toBe(404);
    const del = await api(app, 'DELETE', `/api/history/${target.id}`, otherToken);
    expect(del.statusCode).toBe(404);
    expect(del.json().error).toBe(msg('ru', 'history_not_found'));
    // Still there and unchanged for the owner.
    const after = await list();
    expect(after.find((i) => i.id === target.id)).toEqual(target);
    // The other user's own calculation is stored separately.
    await calc(7777, otherToken);
    expect((await list(otherToken)).map((i) => i.price)).toEqual([7777]);
    expect((await list()).some((i) => i.price === 7777)).toBe(false);
  });

  it('DELETE / PATCH without a JSON content type are rejected by the CSRF check (415)', async () => {
    const id = (await list())[0]!.id;
    const del = await app.inject({ method: 'DELETE', url: `/api/history/${id}`, cookies: { ra_session: token } });
    expect(del.statusCode).toBe(415);
    const patch = await app.inject({
      method: 'PATCH',
      url: `/api/history/${id}`,
      headers: { 'content-type': 'text/plain' },
      payload: '{"pinned":true}',
      cookies: { ra_session: token },
    });
    expect(patch.statusCode).toBe(415);
    expect((await list()).some((i) => i.id === id)).toBe(true);
  });

  it.each(['abc', '0', '-1', '1.5', '999999'])('invalid or unknown id %s → 404', async (id) => {
    const res = await api(app, 'DELETE', `/api/history/${id}`, token);
    expect(res.statusCode).toBe(404);
  });

  it('history is kept across sessions of the same user', async () => {
    const before = await list();
    const relog = await api(app, 'POST', '/api/auth/logout', token, {});
    expect(relog.statusCode).toBe(200);
    const email = (app.db.prepare('SELECT u.email FROM users u ORDER BY id LIMIT 1').get() as { email: string }).email;
    const login = await api(app, 'POST', '/api/auth/login', undefined, { email, password: 'Skyline2026!' });
    const fresh = login.cookies.find((c) => c.name === 'ra_session')!.value;
    expect(await list(fresh)).toEqual(before);
    token = fresh;
  });

  it('clears only the current user’s history and can preserve pinned entries', async () => {
    const { token: owner } = await registerUser(app);
    const otherBefore = await list(otherToken);
    await calc(9500, owner);
    const pinned = (await list(owner))[0]!;
    await api(app, 'PATCH', `/api/history/${pinned.id}`, owner, { pinned: true });
    await calc(10000, owner);

    const unpinned = await api(app, 'DELETE', '/api/history?mode=unpinned', owner);
    expect(unpinned.statusCode).toBe(200);
    expect(unpinned.json().items).toEqual([{ ...pinned, pinned: true }]);
    expect(await list(owner)).toEqual(unpinned.json().items);
    expect(await list(otherToken)).toEqual(otherBefore);

    const all = await api(app, 'DELETE', '/api/history?mode=all', owner);
    expect(all.statusCode).toBe(200);
    expect(all.json().items).toEqual([]);
    expect(await list(owner)).toEqual([]);
    expect(await list(otherToken)).toEqual(otherBefore);
  });

  it.each(['', '?mode=unknown', '?mode=all&mode=unpinned'])('rejects an invalid clear mode (%s) without deleting history', async (query) => {
    const before = await list();
    const res = await api(app, 'DELETE', `/api/history${query}`, token);
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe(msg('ru', 'history_clear_mode'));
    expect(await list()).toEqual(before);
  });
});
