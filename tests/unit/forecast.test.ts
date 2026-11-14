import fs from 'node:fs';
import path from 'node:path';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { parseForecastCsv, parseRoutesCsv, type FlightForecast, type RouteInfo } from '../../src/shared/dataset';
import {
  clean,
  computeForecast,
  normalizeCityQuery,
  resolveCityCode,
  roundTickets,
  salesFromWants,
  sellOutProbability,
  wantsAtPrice,
} from '../../src/shared/forecast';

const ROOT = path.resolve(__dirname, '..', '..');
const { routes: ROUTES } = parseRoutesCsv(fs.readFileSync(path.join(ROOT, 'data', 'routes.csv'), 'utf8'));
const { flights: FLIGHTS } = parseForecastCsv(fs.readFileSync(path.join(ROOT, 'data', 'seasonal_forecast.csv'), 'utf8'));

function real(routeCode: string, date: string): { flight: FlightForecast; route: RouteInfo } {
  const flight = FLIGHTS.find((f) => f.route === routeCode && f.date === date);
  const route = ROUTES.find((r) => r.code === routeCode);
  if (!flight || !route) throw new Error(`no data for ${routeCode} ${date}`);
  return { flight, route };
}

describe('computeForecast: hand-computed examples from the real data', () => {
  // MOW-AER 2026-06-01: 0.5_base_demand 775, price_sensitivity 0.141, base_price 9000, seats 900.
  const aer = real('MOW-AER', '2026-06-01');

  it('input data is what the hand calculations assume', () => {
    expect(aer.route.basePrice).toBe(9000);
    expect(aer.route.priceSensitivity).toBe(0.141);
    expect(aer.flight.seats).toBe(900);
    expect(aer.flight.quantiles.find((q) => q.q === 0.5)!.baseDemand).toBe(775);
  });

  it('price 9500: wants = 775 − 0.141×500 = 704.5 exactly (no float noise)', () => {
    const r = computeForecast(aer.flight, aer.route, 9500);
    expect(r.median.wants).toBe(704.5);
    expect(r.median.sales).toBe(704.5);
    expect(r.median.freeSeats).toBe(195.5);
    expect(r.median.loadFactor).toBe(0.782778);
    expect(r.median.rounded).toEqual({ wants: 705, sales: 705, freeSeats: 195 });
    expect(r.median.baseDemand).toBe(775);
    expect(r.price).toBe(9500);
    expect(r.seats).toBe(900);
    expect(r.date).toBe('2026-06-01');
    expect(r.modelPrice).toBe(9347);
    expect(r.priceOutOfRange).toBe(false);
  });

  it('price 10000: wants = 775 − 141 = 634', () => {
    const r = computeForecast(aer.flight, aer.route, 10000);
    expect(r.median.wants).toBe(634);
    expect(r.median.sales).toBe(634);
  });

  it('price == base_price: wants == base demand for every scenario', () => {
    const r = computeForecast(aer.flight, aer.route, 9000);
    expect(r.median.wants).toBe(775);
    expect(r.scenarios.map((s) => s.wants)).toEqual([656, 694, 723, 742, 775, 802, 835, 863, 923]);
    expect(r.scenarios.map((s) => s.baseDemand)).toEqual([656, 694, 723, 742, 775, 802, 835, 863, 923]);
    // P90 = 923 > 900 seats -> capped with overflow 23.
    const p90 = r.scenarios.find((s) => s.q === 0.9)!;
    expect(p90.sales).toBe(900);
    expect(p90.capped).toBe(true);
    expect(p90.overflow).toBe(23);
    const p80 = r.scenarios.find((s) => s.q === 0.8)!;
    expect(p80.capped).toBe(false);
    expect(p80.overflow).toBe(0);
  });

  it('scenarios at 9500 use their own base demand shifted by the same 70.5', () => {
    const r = computeForecast(aer.flight, aer.route, 9500);
    expect(r.scenarios.map((s) => s.q)).toEqual([0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9]);
    expect(r.scenarios.map((s) => s.wants)).toEqual([585.5, 623.5, 652.5, 671.5, 704.5, 731.5, 764.5, 792.5, 852.5]);
    expect(r.scenarios.find((s) => s.q === 0.5)!.wants).toBe(r.median.wants);
  });

  it('very high price clamps sales to 0 (wants negative)', () => {
    // 775 − 0.141 × (18000 − 9000) = 775 − 1269 = −494
    const r = computeForecast(aer.flight, aer.route, 18000);
    expect(r.median.wants).toBe(-494);
    expect(r.median.sales).toBe(0);
    expect(r.median.freeSeats).toBe(900);
    expect(r.median.loadFactor).toBe(0);
    expect(r.median.rounded).toEqual({ wants: -494, sales: 0, freeSeats: 900 });
    expect(r.scenarios.every((s) => s.sales >= 0)).toBe(true);
  });

  it('low price clamps sales to seats', () => {
    // 775 + 0.141 × 9000 = 2044
    const r = computeForecast(aer.flight, aer.route, 0);
    expect(r.median.wants).toBe(2044);
    expect(r.median.sales).toBe(900);
    expect(r.median.freeSeats).toBe(0);
    expect(r.median.loadFactor).toBe(1);
    expect(r.scenarios.every((s) => s.capped && s.sales === 900)).toBe(true);
    expect(r.scenarios.find((s) => s.q === 0.5)!.overflow).toBe(1144);
    expect(r.priceOutOfRange).toBe(true);
  });

  it('MOW-LED 2026-06-15: 927 − 0.294×500 = 780; at 3300 demand exceeds 1440 seats', () => {
    const led = real('MOW-LED', '2026-06-15');
    expect(computeForecast(led.flight, led.route, 6000).median.wants).toBe(780);
    const low = computeForecast(led.flight, led.route, 3300);
    expect(low.median.wants).toBe(1573.8); // 927 + 646.8
    expect(low.median.sales).toBe(1440);
    expect(low.priceOutOfRange).toBe(false); // price_min is inclusive
  });

  it('MOW-KGD 2026-06-20: 306 − 0.0957×777 = 231.6411', () => {
    const kgd = real('MOW-KGD', '2026-06-20');
    const r = computeForecast(kgd.flight, kgd.route, 8277);
    expect(r.median.wants).toBe(231.6411);
    expect(r.median.sales).toBe(231.6411);
    expect(r.median.rounded.sales).toBe(232);
  });

  it('MOW-OVB 2026-07-01 at price_max 24000: 229 − 0.0312×12000 = −145.4 → 0 sold', () => {
    const ovb = real('MOW-OVB', '2026-07-01');
    const r = computeForecast(ovb.flight, ovb.route, 24000);
    expect(r.median.wants).toBe(-145.4);
    expect(r.median.sales).toBe(0);
    expect(r.priceOutOfRange).toBe(false); // price_max is inclusive
    expect(computeForecast(ovb.flight, ovb.route, 24000.01).priceOutOfRange).toBe(true);
  });

  it('MOW-MRV 2026-06-10 at base price: 366 wanted, 360 seats → capped with overflow 6', () => {
    const mrv = real('MOW-MRV', '2026-06-10');
    const r = computeForecast(mrv.flight, mrv.route, 8000);
    expect(r.median.wants).toBe(366);
    expect(r.median.sales).toBe(360);
    expect(r.median.rounded.sales).toBe(360);
    const med = r.scenarios.find((s) => s.q === 0.5)!;
    expect(med.capped).toBe(true);
    expect(med.overflow).toBe(6);
  });

  it('priceOutOfRange respects price_min / price_max and null bounds', () => {
    expect(computeForecast(aer.flight, aer.route, 5399).priceOutOfRange).toBe(true);
    expect(computeForecast(aer.flight, aer.route, 5400).priceOutOfRange).toBe(false);
    expect(computeForecast(aer.flight, aer.route, 18000).priceOutOfRange).toBe(false);
    expect(computeForecast(aer.flight, aer.route, 18001).priceOutOfRange).toBe(true);
    const unbounded = { ...aer.route, priceMin: null, priceMax: null };
    expect(computeForecast(aer.flight, unbounded, 1e6).priceOutOfRange).toBe(false);
  });

  it('modelPrice is null when the file has no 0.5_price', () => {
    const flight: FlightForecast = {
      ...aer.flight,
      quantiles: aer.flight.quantiles.map((q) => ({ ...q, price: null })),
    };
    expect(computeForecast(flight, aer.route, 9500).modelPrice).toBeNull();
  });

  it('throws when the flight has no median quantile', () => {
    const flight: FlightForecast = { ...aer.flight, quantiles: aer.flight.quantiles.filter((q) => q.q !== 0.5) };
    expect(() => computeForecast(flight, aer.route, 9500)).toThrow(/медиан/);
  });

  it('works with a single-quantile (median-only) forecast', () => {
    const flight: FlightForecast = {
      route: 'MOW-AER',
      date: '2026-06-01',
      seats: 100,
      quantiles: [{ q: 0.5, baseDemand: 80, price: null, priceDemand: null }],
    };
    const r = computeForecast(flight, aer.route, 9000);
    expect(r.median.wants).toBe(80);
    expect(r.sellOut).toEqual({ value: 0.5, bound: 'atMost' });
  });

  it('fractional price is used as is', () => {
    expect(computeForecast(aer.flight, aer.route, 9500.5).median.wants).toBe(704.4295); // 775 − 0.141×500.5
  });
});

describe('helpers', () => {
  it('clean removes binary float tails', () => {
    // MOW-OVB at 24000: raw float arithmetic gives −145.39999999999998.
    expect(229 - 0.0312 * (24000 - 12000)).not.toBe(-145.4);
    expect(clean(229 - 0.0312 * (24000 - 12000))).toBe(-145.4);
    expect(clean(775 - 0.141 * 500)).toBe(704.5);
    expect(clean(0.1 + 0.2)).toBe(0.3);
  });

  it.each([
    [704.5, 705],
    [704.4999999, 705],
    [704.49, 704],
    [0, 0],
    [0.5, 1],
    [2.4, 2],
    [899.6, 900],
  ])('roundTickets(%d) = %d', (x, expected) => {
    expect(roundTickets(x)).toBe(expected);
  });

  it('negative wants are rounded symmetrically (−494.5 → −495)', () => {
    const route = { basePrice: 1000, priceSensitivity: 1 };
    const flight: FlightForecast = {
      route: 'A-B',
      date: '2026-06-01',
      seats: 10,
      quantiles: [{ q: 0.5, baseDemand: 5.5, price: null, priceDemand: null }],
    };
    const r = computeForecast(flight, { ...ROUTES[0]!, ...route }, 1500);
    expect(r.median.wants).toBe(-494.5);
    expect(r.median.rounded.wants).toBe(-495);
  });

  it('wantsAtPrice / salesFromWants follow the formula', () => {
    const route = { basePrice: 9000, priceSensitivity: 0.141 };
    expect(wantsAtPrice(775, route, 9500)).toBe(704.5);
    expect(salesFromWants(704.5, 900)).toBe(704.5);
    expect(salesFromWants(-3, 900)).toBe(0);
    expect(salesFromWants(1000, 900)).toBe(900);
  });
});

describe('sellOutProbability', () => {
  const pts = [
    { q: 0.1, wants: 100 },
    { q: 0.5, wants: 200 },
    { q: 0.9, wants: 300 },
  ];

  it('exact interpolation between quantiles', () => {
    // F(150) = 0.1 + (50/100)×0.4 = 0.3 → P(D > 150) = 0.7
    expect(sellOutProbability(pts, 150)).toEqual({ value: 0.7, bound: 'exact' });
    // F(250) = 0.5 + 0.5×0.4 = 0.7 → 0.3
    expect(sellOutProbability(pts, 250)).toEqual({ value: 0.3, bound: 'exact' });
    expect(sellOutProbability(pts, 200)).toEqual({ value: 0.5, bound: 'exact' });
  });

  it('boundaries of the quantile grid are exact', () => {
    expect(sellOutProbability(pts, 100)).toEqual({ value: 0.9, bound: 'exact' });
    expect(sellOutProbability(pts, 300)).toEqual({ value: 0.1, bound: 'exact' });
  });

  it('atLeast when seats < P10 demand', () => {
    expect(sellOutProbability(pts, 99)).toEqual({ value: 0.9, bound: 'atLeast' });
    expect(sellOutProbability(pts, 0)).toEqual({ value: 0.9, bound: 'atLeast' });
  });

  it('atMost when seats > P90 demand', () => {
    expect(sellOutProbability(pts, 301)).toEqual({ value: 0.1, bound: 'atMost' });
  });

  it('does not depend on input order', () => {
    expect(sellOutProbability([...pts].reverse(), 150)).toEqual({ value: 0.7, bound: 'exact' });
  });

  it('plateaus (equal wants) use the right boundary', () => {
    const flat = [
      { q: 0.1, wants: 100 },
      { q: 0.5, wants: 100 },
      { q: 0.9, wants: 300 },
    ];
    expect(sellOutProbability(flat, 100)).toEqual({ value: 0.5, bound: 'exact' });
  });

  it('empty scenarios give 0', () => {
    expect(sellOutProbability([], 100)).toEqual({ value: 0, bound: 'exact' });
  });

  it('real flight MOW-AER 2026-06-01 at base price: 900 seats between P80 (863) and P90 (923)', () => {
    const { flight, route } = real('MOW-AER', '2026-06-01');
    const r = computeForecast(flight, route, 9000);
    // F(900) = 0.8 + (37/60)×0.1 = 0.861666… → 0.138333
    expect(r.sellOut).toEqual({ value: 0.138333, bound: 'exact' });
    expect(computeForecast(flight, route, 9500).sellOut).toEqual({ value: 0.1, bound: 'atMost' });
    expect(computeForecast(flight, route, 0).sellOut).toEqual({ value: 0.9, bound: 'atLeast' });
  });
});

describe('resolveCityCode', () => {
  it.each([
    ['MOW', 'MOW'],
    ['aer', 'AER'],
    [' Led ', 'LED'],
    ['Москва', 'MOW'],
    ['москва', 'MOW'],
    ['СОЧИ', 'AER'],
    ['Санкт-Петербург', 'LED'],
    ['санкт петербург', 'LED'],
    ['санкт — петербург', 'LED'],
    ['  минеральные   воды ', 'MRV'],
    ['Калининград', 'KGD'],
  ])('%j -> %s', (query, code) => {
    expect(resolveCityCode(query, ROUTES)).toBe(code);
  });

  it.each(['', '   ', 'Лондон', 'MO', 'Москв', 'MOW-AER'])('%j -> null', (query) => {
    expect(resolveCityCode(query, ROUTES)).toBeNull();
  });

  it('treats ё and е as the same letter, in both directions', () => {
    const routes = parseRoutesCsv(
      'route,name,base_price,price_sensitivity\nMOW-OEL,Москва — Орёл,5000,0.1\nMOW-BQS,Москва — Березники,5000,0.1\n',
    ).routes;
    expect(resolveCityCode('Орёл', routes)).toBe('OEL');
    expect(resolveCityCode('орел', routes)).toBe('OEL');
    expect(resolveCityCode('ОРЁЛ', routes)).toBe('OEL');
    expect(resolveCityCode('Берёзники', routes)).toBe('BQS');
  });

  it('normalizeCityQuery', () => {
    expect(normalizeCityQuery('  Ростов-на-Дону ')).toBe('ростов на дону');
    expect(normalizeCityQuery('Ёлки — Палки')).toBe('елки палки');
  });
});

// ---------------------------------------------------------------------------
// Property-based tests
// ---------------------------------------------------------------------------

const QS = [0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9];

const finite = (min: number, max: number) => fc.double({ min, max, noNaN: true, noDefaultInfinity: true });

const routeArb = fc.record({
  basePrice: finite(1, 100_000),
  priceSensitivity: finite(0, 5),
});

const flightArb = fc
  .record({
    seats: fc.integer({ min: 1, max: 3000 }),
    demands: fc.array(finite(-1000, 10_000), { minLength: 9, maxLength: 9 }),
  })
  .map(({ seats, demands }): FlightForecast => {
    const sorted = [...demands].sort((a, b) => a - b);
    return {
      route: 'AAA-BBB',
      date: '2026-06-01',
      seats,
      quantiles: QS.map((q, i) => ({ q, baseDemand: sorted[i]!, price: null, priceDemand: null })),
    };
  });

const priceArb = finite(0, 1_000_000);

function makeRoute(r: { basePrice: number; priceSensitivity: number }): RouteInfo {
  return {
    code: 'AAA-BBB',
    name: 'A — B',
    origin: { code: 'AAA', name: 'A' },
    destination: { code: 'BBB', name: 'B' },
    basePrice: r.basePrice,
    priceSensitivity: r.priceSensitivity,
    costPerPassenger: null,
    priceMin: null,
    priceMax: null,
  };
}

describe('properties', () => {
  it('sales are always within [0, seats] for every scenario', () => {
    fc.assert(
      fc.property(flightArb, routeArb, priceArb, (flight, r, price) => {
        const res = computeForecast(flight, makeRoute(r), price);
        for (const s of res.scenarios) {
          expect(s.sales).toBeGreaterThanOrEqual(0);
          expect(s.sales).toBeLessThanOrEqual(flight.seats);
          expect(s.overflow).toBeGreaterThanOrEqual(0);
        }
        expect(res.median.rounded.sales).toBeGreaterThanOrEqual(0);
        expect(res.median.rounded.sales).toBeLessThanOrEqual(flight.seats);
        expect(res.median.freeSeats).toBeGreaterThanOrEqual(0);
        expect(res.median.loadFactor).toBeGreaterThanOrEqual(0);
        expect(res.median.loadFactor).toBeLessThanOrEqual(1);
        expect(res.sellOut.value).toBeGreaterThanOrEqual(0);
        expect(res.sellOut.value).toBeLessThanOrEqual(1);
      }),
      { numRuns: 500 },
    );
  });

  it('sales are non-increasing in price', () => {
    fc.assert(
      fc.property(flightArb, routeArb, priceArb, priceArb, (flight, r, a, b) => {
        const [lo, hi] = a <= b ? [a, b] : [b, a];
        const route = makeRoute(r);
        const rLo = computeForecast(flight, route, lo);
        const rHi = computeForecast(flight, route, hi);
        rLo.scenarios.forEach((s, i) => {
          expect(s.sales).toBeGreaterThanOrEqual(rHi.scenarios[i]!.sales);
          expect(s.wants).toBeGreaterThanOrEqual(rHi.scenarios[i]!.wants);
        });
      }),
      { numRuns: 500 },
    );
  });

  it('scenario wants are non-decreasing in q', () => {
    fc.assert(
      fc.property(flightArb, routeArb, priceArb, (flight, r, price) => {
        const res = computeForecast(flight, makeRoute(r), price);
        for (let i = 1; i < res.scenarios.length; i++) {
          expect(res.scenarios[i]!.q).toBeGreaterThan(res.scenarios[i - 1]!.q);
          expect(res.scenarios[i]!.wants).toBeGreaterThanOrEqual(res.scenarios[i - 1]!.wants);
          expect(res.scenarios[i]!.sales).toBeGreaterThanOrEqual(res.scenarios[i - 1]!.sales);
        }
      }),
      { numRuns: 500 },
    );
  });

  it('median wants equals the spec formula and median sales = min(seats, max(0, wants))', () => {
    fc.assert(
      fc.property(flightArb, routeArb, priceArb, (flight, r, price) => {
        const route = makeRoute(r);
        const res = computeForecast(flight, route, price);
        const base = flight.quantiles.find((q) => q.q === 0.5)!.baseDemand;
        const expected = base - r.priceSensitivity * (price - r.basePrice);
        expect(Math.abs(res.median.wants - expected)).toBeLessThanOrEqual(1e-6 * Math.max(1, Math.abs(expected)));
        expect(res.median.sales).toBe(Math.min(flight.seats, Math.max(0, res.median.wants)));
        expect(res.scenarios.find((s) => s.q === 0.5)!.wants).toBe(res.median.wants);
      }),
      { numRuns: 500 },
    );
  });

  it('sell-out probability is non-increasing in seats', () => {
    fc.assert(
      fc.property(
        fc.array(finite(0, 5000), { minLength: 9, maxLength: 9 }),
        finite(0, 6000),
        finite(0, 6000),
        (demands, a, b) => {
          const sorted = [...demands].sort((x, y) => x - y);
          const pts = QS.map((q, i) => ({ q, wants: sorted[i]! }));
          const [lo, hi] = a <= b ? [a, b] : [b, a];
          expect(sellOutProbability(pts, lo).value).toBeGreaterThanOrEqual(sellOutProbability(pts, hi).value);
        },
      ),
      { numRuns: 500 },
    );
  });
});
