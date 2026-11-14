import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PRICE_LIMIT } from '../../src/server/routes';
import { msg, type MessageKey } from '../../src/shared/messages';
import { forecast, makeApp, meta, registerUser } from './helpers';

let app: FastifyInstance;
let token: string;

beforeAll(async () => {
  app = await makeApp();
  ({ token } = await registerUser(app));
});
afterAll(async () => {
  await app.close();
});

const valid = { from: 'MOW', to: 'AER', date: '2026-06-01', price: 9500 };

describe('authorization', () => {
  it('/api/meta returns 401 without a session', async () => {
    const res = await meta(app, undefined);
    expect(res.statusCode).toBe(401);
    expect(res.json().error).toBe(msg('ru', 'login_required'));
    expect((await app.inject({ method: 'GET', url: '/api/meta', headers: { 'x-lang': 'en' } })).json().error).toBe(
      msg('en', 'login_required'),
    );
  });

  it('/api/forecast returns 401 without a session or with a forged one', async () => {
    expect((await forecast(app, undefined, valid)).statusCode).toBe(401);
    expect((await forecast(app, 'forged', valid)).statusCode).toBe(401);
  });

  it('401 comes before validation (no data leaks to anonymous users)', async () => {
    const res = await forecast(app, undefined, {});
    expect(res.statusCode).toBe(401);
    expect(res.json().fields).toBeUndefined();
  });
});

describe('GET /api/meta', () => {
  it('lists routes with dates, seats and data info', async () => {
    const res = await meta(app, token);
    expect(res.statusCode).toBe(200);
    expect(res.headers['cache-control']).toBe('no-store');
    const body = res.json();
    expect(body.routes.map((r: { code: string }) => r.code)).toEqual([
      'MOW-AER',
      'MOW-LED',
      'MOW-KGD',
      'MOW-OVB',
      'MOW-MRV',
    ]);
    const aer = body.routes[0];
    expect(aer).toMatchObject({
      code: 'MOW-AER',
      name: 'Москва — Сочи',
      origin: { code: 'MOW', name: 'Москва' },
      destination: { code: 'AER', name: 'Сочи' },
      basePrice: 9000,
      priceSensitivity: 0.141,
      costPerPassenger: 4200,
      priceMin: 5400,
      priceMax: 18000,
      seats: [900],
    });
    expect(aer.dates).toHaveLength(31);
    expect(aer.dates[0]).toBe('2026-06-01');
    expect(aer.dates[30]).toBe('2026-07-01');
    expect(body.data).toMatchObject({
      ok: true,
      error: null,
      version: 1,
      flights: 155,
      routes: 5,
      quantileLevels: [0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9],
      warnings: [],
    });
    expect(body.data.source.forecast.name).toBe('seasonal_forecast.csv');
    expect(body.data.source.routes.name).toBe('routes.csv');
  });
});

describe('POST /api/forecast: results', () => {
  it('MOW-AER 2026-06-01 @ 9500: wants = 775 − 0.141×500 = 704.5', async () => {
    const res = await forecast(app, token, valid);
    expect(res.statusCode).toBe(200);
    expect(res.headers['cache-control']).toBe('no-store');
    const r = res.json();
    expect(r.route.code).toBe('MOW-AER');
    expect(r.date).toBe('2026-06-01');
    expect(r.price).toBe(9500);
    expect(r.seats).toBe(900);
    expect(r.median).toEqual({
      baseDemand: 775,
      wants: 704.5,
      sales: 704.5,
      freeSeats: 195.5,
      loadFactor: 0.782778,
      rounded: { wants: 705, sales: 705, freeSeats: 195 },
    });
    expect(r.scenarios).toHaveLength(9);
    expect(r.scenarios.map((s: { wants: number }) => s.wants)).toEqual([
      585.5, 623.5, 652.5, 671.5, 704.5, 731.5, 764.5, 792.5, 852.5,
    ]);
    expect(r.sellOut).toEqual({ value: 0.1, bound: 'atMost' });
    expect(r.modelPrice).toBe(9347);
    expect(r.priceOutOfRange).toBe(false);
    expect(r.dataVersion).toBe(1);
  });

  it('price 10000 → 634; base price → 775; 18000 → 0 sold; 0 → capped at 900', async () => {
    const at = async (price: number) => (await forecast(app, token, { ...valid, price })).json().median;
    expect((await at(10000)).wants).toBe(634);
    expect((await at(9000)).wants).toBe(775);
    const high = await at(18000);
    expect(high.wants).toBe(-494);
    expect(high.sales).toBe(0);
    const low = await at(0);
    expect(low.wants).toBe(2044);
    expect(low.sales).toBe(900);
  });

  it('every route/date matches the formula at a few prices', async () => {
    const m = (await meta(app, token)).json();
    for (const route of m.routes) {
      for (const date of [route.dates[0], route.dates[15], route.dates[30]]) {
        for (const price of [route.priceMin, route.basePrice + 123, route.priceMax]) {
          const r = (await forecast(app, token, { from: route.origin.code, to: route.destination.code, date, price })).json();
          const med = app.data.get()!.flights.get(`${route.code}|${date}`)!.quantiles.find((q) => q.q === 0.5)!;
          const wants = med.baseDemand - route.priceSensitivity * (price - route.basePrice);
          expect(r.median.wants).toBeCloseTo(wants, 6);
          expect(r.median.sales).toBeCloseTo(Math.min(r.seats, Math.max(0, wants)), 6);
        }
      }
    }
  });

  it.each([
    [{ from: 'Москва', to: 'сочи' }, 'MOW-AER'],
    [{ from: 'москва', to: 'САНКТ-ПЕТЕРБУРГ' }, 'MOW-LED'],
    [{ from: 'mow', to: 'Минеральные Воды' }, 'MOW-MRV'],
  ])('accepts city names %j', async (cities, code) => {
    const res = await forecast(app, token, { ...valid, ...cities });
    expect(res.statusCode).toBe(200);
    expect(res.json().route.code).toBe(code);
  });

  it('accepts DD.MM.YYYY and ISO-with-time dates', async () => {
    expect((await forecast(app, token, { ...valid, date: '01.06.2026' })).json().date).toBe('2026-06-01');
    expect((await forecast(app, token, { ...valid, date: '2026-06-01T00:00:00' })).json().date).toBe('2026-06-01');
  });

  it.each([
    ['9 500,5', 9500.5, 704.4295],
    ['9500', 9500, 704.5],
    ['9\u00a0500 ₽', 9500, 704.5],
    ['+9500', 9500, 704.5],
  ])('accepts price as string %j', async (price, parsed, wants) => {
    const res = await forecast(app, token, { ...valid, price });
    expect(res.statusCode).toBe(200);
    expect(res.json().price).toBe(parsed);
    expect(res.json().median.wants).toBe(wants);
  });

  it('rounds the price to kopecks', async () => {
    const r = (await forecast(app, token, { ...valid, price: 9500.555 })).json();
    expect(r.price).toBe(9500.56);
  });

  it('accepts the price limit itself (1 000 000)', async () => {
    const res = await forecast(app, token, { ...valid, price: 1_000_000 });
    expect(res.statusCode).toBe(200);
    expect(res.json().median.sales).toBe(0);
    expect(res.json().priceOutOfRange).toBe(true);
  });
});

describe('POST /api/forecast: validation', () => {
  it('missing fields → 400 with every field', async () => {
    const res = await forecast(app, token, {});
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe(msg('ru', 'check_form'));
    expect(res.json().fields).toEqual({
      from: msg('ru', 'from_required'),
      to: msg('ru', 'to_required'),
      date: msg('ru', 'date_required'),
      price: msg('ru', 'price_required'),
    });
  });

  it('field errors are English with X-Lang: en', async () => {
    const res = await forecast(app, token, {}, { 'x-lang': 'en' });
    expect(res.json().error).toBe(msg('en', 'check_form'));
    expect(res.json().fields).toEqual({
      from: msg('en', 'from_required'),
      to: msg('en', 'to_required'),
      date: msg('en', 'date_required'),
      price: msg('en', 'price_required'),
    });
  });

  it('non-string city/date are treated as missing', async () => {
    const res = await forecast(app, token, { from: 1, to: ['AER'], date: 20260601, price: 9500 });
    expect(res.statusCode).toBe(400);
    expect(res.json().fields).toEqual({
      from: msg('ru', 'from_required'),
      to: msg('ru', 'to_required'),
      date: msg('ru', 'date_required'),
    });
  });

  it('unknown city', async () => {
    const res = await forecast(app, token, { ...valid, from: 'Лондон', to: 'Париж' });
    expect(res.statusCode).toBe(400);
    expect(res.json().fields).toEqual({
      from: msg('ru', 'city_not_found', { city: 'Лондон' }),
      to: msg('ru', 'city_not_found', { city: 'Париж' }),
    });
  });

  it('long unknown city name is truncated to 40 characters in the message', async () => {
    const res = await forecast(app, token, { ...valid, from: 'Я'.repeat(500) });
    expect(res.json().fields.from).toBe(msg('ru', 'city_not_found', { city: 'Я'.repeat(40) }));
  });

  it('same origin and destination', async () => {
    const res = await forecast(app, token, { ...valid, from: 'MOW', to: 'Москва' });
    expect(res.statusCode).toBe(400);
    expect(res.json().fields).toEqual({ to: msg('ru', 'same_city') });
  });

  it('route that does not exist → 404 with fields.to and a hint (none from AER)', async () => {
    const res = await forecast(app, token, { ...valid, from: 'AER', to: 'MOW' });
    expect(res.statusCode).toBe(404);
    expect(res.json().fields).toEqual({ to: msg('ru', 'route_field') });
    expect(res.json().error).toBe(
      msg('ru', 'route_missing', { from: 'AER', to: 'MOW', hint: msg('ru', 'route_hint_none') }),
    );
    const res2 = await forecast(app, token, { ...valid, from: 'AER', to: 'LED' });
    expect(res2.statusCode).toBe(404);
  });

  it('route_missing is translated, including the hint, with X-Lang: en', async () => {
    const res = await forecast(app, token, { ...valid, from: 'AER', to: 'MOW' }, { 'x-lang': 'en' });
    expect(res.json().error).toBe(msg('en', 'route_missing', { from: 'AER', to: 'MOW', hint: msg('en', 'route_hint_none') }));
    expect(res.json().fields).toEqual({ to: msg('en', 'route_field') });
  });

  it.each(['2026-02-30', '31.06.2026', 'завтра', '2026-06', '20260601'])('bad date %j → 400', async (date) => {
    const res = await forecast(app, token, { ...valid, date });
    expect(res.statusCode).toBe(400);
    expect(res.json().fields).toEqual({ date: msg('ru', 'date_format') });
  });

  it.each(['2026/06/01', '2026.06.01'])('date %j (YYYY/MM/DD, YYYY.MM.DD) is accepted', async (date) => {
    const res = await forecast(app, token, { ...valid, date });
    expect(res.statusCode).toBe(200);
    expect(res.json().date).toBe('2026-06-01');
  });

  it.each(['2026-05-31', '2026-07-02', '2025-06-01'])('date out of range %j → 404 with fields.date', async (date) => {
    const res = await forecast(app, token, { ...valid, date });
    expect(res.statusCode).toBe(404);
    const range = msg('ru', 'dates_range', { from: '01.06.2026', to: '01.07.2026' });
    expect(res.json().fields).toEqual({ date: msg('ru', 'dates_available', { range }) });
    const [y, m, d] = date.split('-');
    expect(res.json().error).toBe(msg('ru', 'flight_missing', { date: `${d}.${m}.${y}`, route: 'MOW-AER', range }));
  });

  it('date out of range in English uses ISO dates', async () => {
    const res = await forecast(app, token, { ...valid, date: '2026-07-02' }, { 'x-lang': 'en' });
    const range = msg('en', 'dates_range', { from: '2026-06-01', to: '2026-07-01' });
    expect(res.json().fields).toEqual({ date: msg('en', 'dates_available', { range }) });
    expect(res.json().error).toBe(msg('en', 'flight_missing', { date: '2026-07-02', route: 'MOW-AER', range }));
  });

  it.each<[unknown, MessageKey]>([
    [-1, 'price_negative'],
    ['-1', 'price_negative'],
    [-0.01, 'price_negative'],
    ['abc', 'price_nan'],
    ['NaN', 'price_nan'],
    ['Infinity', 'price_nan'],
    ['1e4', 'price_nan'],
    ['9,500,5', 'price_nan'],
    [1_000_001, 'price_too_high'],
    ['1 000 001', 'price_too_high'],
    [1e300, 'price_too_high'],
    [null, 'price_required'],
    ['', 'price_required'],
    ['   ', 'price_required'],
    [true, 'price_required'],
    [{}, 'price_required'],
  ])('price %j is rejected', async (price, key) => {
    const res = await forecast(app, token, { ...valid, price });
    expect(res.statusCode).toBe(400);
    expect(res.json().fields).toEqual({ price: msg('ru', key, key === 'price_too_high' ? { max: PRICE_LIMIT } : {}) });
  });

  it('price_too_high shows the limit formatted per language', async () => {
    const ru = (await forecast(app, token, { ...valid, price: 2_000_000 })).json().fields.price;
    const en = (await forecast(app, token, { ...valid, price: 2_000_000 }, { 'x-lang': 'en' })).json().fields.price;
    expect(ru).toBe(msg('ru', 'price_too_high', { max: PRICE_LIMIT }));
    expect(ru.replace(/\s/g, '')).toContain('1000000');
    expect(en).toBe(msg('en', 'price_too_high', { max: PRICE_LIMIT }));
    expect(en).toContain('1,000,000');
  });

  it('price that overflows to Infinity in JSON (1e400) is rejected as not a number', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/forecast',
      headers: { 'content-type': 'application/json' },
      payload: '{"from":"MOW","to":"AER","date":"2026-06-01","price":1e400}',
      cookies: { ra_session: token },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().fields).toEqual({ price: msg('ru', 'price_nan') });
  });
});
