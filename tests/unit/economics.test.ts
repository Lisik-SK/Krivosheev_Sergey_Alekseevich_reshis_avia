import fs from 'node:fs';
import path from 'node:path';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { parseForecastCsv, parseRoutesCsv, type FlightForecast, type RouteInfo } from '../../src/shared/dataset';
import {
  boardStatus,
  computeForecast,
  daySummary,
  economics,
  optimalPrice,
  priceBounds,
  profitCurve,
} from '../../src/shared/forecast';

const ROOT = path.resolve(__dirname, '..', '..');
const { routes: ROUTES } = parseRoutesCsv(fs.readFileSync(path.join(ROOT, 'data', 'routes.csv'), 'utf8'));
const { flights: FLIGHTS } = parseForecastCsv(fs.readFileSync(path.join(ROOT, 'data', 'seasonal_forecast.csv'), 'utf8'));

const routeOf = (code: string) => ROUTES.find((r) => r.code === code)!;
const medianOf = (f: FlightForecast) => f.quantiles.find((q) => q.q === 0.5)!.baseDemand;
const AER = routeOf('MOW-AER');
const AER_0601 = FLIGHTS.find((f) => f.route === 'MOW-AER' && f.date === '2026-06-01')!;

/** Independent objective: (p − c) · min(S, max(0, B − s·(p − p0))). */
function objective(p: number, B: number, seats: number, route: RouteInfo, useCost: boolean): number {
  const sales = Math.min(seats, Math.max(0, B - route.priceSensitivity * (p - route.basePrice)));
  return (p - (useCost ? route.costPerPassenger ?? 0 : 0)) * sales;
}

function bruteForce(B: number, seats: number, route: RouteInfo, useCost: boolean, min: number, max: number) {
  let best = -Infinity;
  let bestPrice = min;
  for (let p = Math.ceil(min); p <= max; p++) {
    const v = objective(p, B, seats, route, useCost);
    if (v > best) {
      best = v;
      bestPrice = p;
    }
  }
  return { best, bestPrice };
}

/** How much the objective can change by moving the price by one ruble around p. */
function oneRubleSlack(p: number, B: number, seats: number, route: RouteInfo, useCost: boolean) {
  const v = objective(p, B, seats, route, useCost);
  return Math.max(
    Math.abs(objective(p + 1, B, seats, route, useCost) - v),
    Math.abs(objective(p - 1, B, seats, route, useCost) - v),
  );
}

describe('economics', () => {
  it('computeForecast includes revenue, passenger cost and margin for the median', () => {
    const r = computeForecast(AER_0601, AER, 9500);
    // sales 704.5 × 9500 = 6 692 750; cost 4200 × 704.5 = 2 958 900
    expect(r.economics).toEqual({ revenue: 6_692_750, passengerCost: 2_958_900, margin: 3_733_850 });
  });

  it('sales are capped by seats in the economics too', () => {
    const r = computeForecast(AER_0601, AER, 0);
    expect(r.economics).toEqual({ revenue: 0, passengerCost: 900 * 4200, margin: -900 * 4200 });
  });

  it('cost_per_passenger missing → passengerCost and margin are null', () => {
    const r = computeForecast(AER_0601, { ...AER, costPerPassenger: null }, 9500);
    expect(r.economics).toEqual({ revenue: 6_692_750, passengerCost: null, margin: null });
    expect(economics(100, 0, null)).toEqual({ revenue: 0, passengerCost: null, margin: null });
  });

  it('economics() has no float noise', () => {
    expect(economics(9500.1, 704.49, 4200.3)).toEqual({
      revenue: 6_692_725.449,
      passengerCost: 2_959_069.347,
      margin: 3_733_656.102,
    });
  });
});

describe('priceBounds', () => {
  it('uses price_min / price_max', () => {
    expect(priceBounds(AER)).toEqual({ min: 5400, max: 18000 });
  });
  it('falls back to 0.5×–2× base price and orders swapped bounds', () => {
    expect(priceBounds({ ...AER, priceMin: null, priceMax: null })).toEqual({ min: 4500, max: 18000 });
    expect(priceBounds({ ...AER, priceMin: 20000, priceMax: 6000 })).toEqual({ min: 6000, max: 20000 });
  });
});

describe('optimalPrice', () => {
  it('matches an exhaustive search over every integer price in [price_min, price_max] for all 155 rows (margin)', () => {
    expect(FLIGHTS).toHaveLength(155);
    const problems: string[] = [];
    for (const f of FLIGHTS) {
      const route = routeOf(f.route);
      const B = medianOf(f);
      const { min, max } = priceBounds(route);
      const opt = optimalPrice(B, f.seats, route);
      expect(opt.objective).toBe('margin');
      expect(opt.price).toBeGreaterThanOrEqual(min);
      expect(opt.price).toBeLessThanOrEqual(max);
      expect(Number.isInteger(opt.price)).toBe(true);

      const { best, bestPrice } = bruteForce(B, f.seats, route, true, min, max);
      const got = objective(opt.price, B, f.seats, route, true);
      const slack = oneRubleSlack(opt.price, B, f.seats, route, true);
      if (got < best - slack - 1e-6) {
        problems.push(`${f.route} ${f.date}: optimum ${opt.price} → ${got}, grid best ${bestPrice} → ${best}`);
      }
      // Reported numbers are consistent with the formula at that price.
      const r = computeForecast(f, route, opt.price);
      expect(opt.sales).toBe(r.median.sales);
      expect(opt.revenue).toBe(r.economics.revenue);
      expect(opt.margin).toBe(r.economics.margin);
      expect(opt.capped).toBe(r.median.wants >= f.seats);
    }
    expect(problems).toEqual([]);
  });

  it('on the real data the optimum is exactly the best integer price', () => {
    for (const f of FLIGHTS) {
      const route = routeOf(f.route);
      const B = medianOf(f);
      const { min, max } = priceBounds(route);
      const opt = optimalPrice(B, f.seats, route);
      const { best } = bruteForce(B, f.seats, route, true, min, max);
      expect(objective(opt.price, B, f.seats, route, true)).toBeGreaterThanOrEqual(best - 1e-6);
    }
  });

  it('without cost_per_passenger maximizes revenue', () => {
    for (const f of FLIGHTS.filter((_, i) => i % 5 === 0)) {
      const route = { ...routeOf(f.route), costPerPassenger: null };
      const B = medianOf(f);
      const { min, max } = priceBounds(route);
      const opt = optimalPrice(B, f.seats, route);
      expect(opt.objective).toBe('revenue');
      expect(opt.margin).toBeNull();
      const { best } = bruteForce(B, f.seats, route, false, min, max);
      const got = objective(opt.price, B, f.seats, route, false);
      expect(got).toBeGreaterThanOrEqual(best - oneRubleSlack(opt.price, B, f.seats, route, false) - 1e-6);
      expect(opt.revenue).toBeCloseTo(got, 6);
    }
  });

  it('hand example: vertex inside the range', () => {
    // B=100, s=0.01, p0=1000, c=0, seats huge → p* = (100 + 10)/(0.02) = 5500
    const route: RouteInfo = { ...AER, basePrice: 1000, priceSensitivity: 0.01, costPerPassenger: 0, priceMin: 1000, priceMax: 10000 };
    const opt = optimalPrice(100, 10_000, route);
    expect(opt.price).toBe(5500);
    expect(opt.sales).toBe(55);
    expect(opt.margin).toBe(302_500);
    expect(opt.capped).toBe(false);
  });

  it('hand example: capacity binds → price where demand equals seats', () => {
    // Same route but only 20 seats: demand = 20 at p = 1000 + 80/0.01 = 9000
    const route: RouteInfo = { ...AER, basePrice: 1000, priceSensitivity: 0.01, costPerPassenger: 0, priceMin: 1000, priceMax: 10000 };
    const opt = optimalPrice(100, 20, route);
    expect(opt.price).toBe(9000);
    expect(opt.sales).toBe(20);
    expect(opt.capped).toBe(true);
  });

  it('s = 0: demand does not depend on price → highest price in range', () => {
    const route: RouteInfo = { ...AER, priceSensitivity: 0 };
    const opt = optimalPrice(500, 900, route);
    expect(opt.price).toBe(18000);
    expect(opt.sales).toBe(500);
    expect(opt.margin).toBe((18000 - 4200) * 500);
  });

  it('s = 0 and no demand: every price gives 0, the lowest price is returned', () => {
    const route: RouteInfo = { ...AER, priceSensitivity: 0 };
    const opt = optimalPrice(-5, 900, route);
    expect(opt.price).toBe(5400);
    expect(opt.sales).toBe(0);
    expect(opt.margin).toBe(0);
  });

  it('property: optimum is within one ruble of the integer grid optimum (random routes)', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: -50, max: 2000 }), // B
        fc.integer({ min: 1, max: 1500 }), // seats
        fc.integer({ min: 1000, max: 20000 }), // base price
        fc.double({ min: 0, max: 0.5, noNaN: true }), // sensitivity
        fc.option(fc.integer({ min: 0, max: 15000 }), { nil: null }), // cost
        fc.integer({ min: 100, max: 1800 }), // range width (keeps price_min > 0)
        (B, seats, basePrice, s, cost, width) => {
          const route: RouteInfo = {
            ...AER,
            basePrice,
            priceSensitivity: s,
            costPerPassenger: cost,
            priceMin: basePrice - Math.floor(width / 2),
            priceMax: basePrice + Math.ceil(width / 2),
          };
          const useCost = cost !== null;
          const opt = optimalPrice(B, seats, route);
          const { min, max } = priceBounds(route);
          expect(opt.price).toBeGreaterThanOrEqual(min);
          expect(opt.price).toBeLessThanOrEqual(max);
          const { best } = bruteForce(B, seats, route, useCost, min, max);
          const got = objective(opt.price, B, seats, route, useCost);
          expect(got).toBeGreaterThanOrEqual(best - oneRubleSlack(opt.price, B, seats, route, useCost) - 1e-6 * Math.max(1, Math.abs(best)));
        },
      ),
      { numRuns: 300 },
    );
  });

  // Было (исправлено): optimalPrice rounds the clamped candidate to an integer AFTER clamping
  // (src/shared/forecast.ts:238: Math.round(Math.min(max, Math.max(min, raw)))), so with fractional
  // price_min/price_max (e.g. 15999.6 in an uploaded routes.csv) the recommended "optimal" price lies
  // outside the allowed range and is itself flagged priceOutOfRange. Repro: route with
  // priceSensitivity 0, priceMin 100.4, priceMax 200.6 → optimalPrice(...).price === 201 > 200.6.
  it('stays within fractional price bounds', () => {
    const route: RouteInfo = { ...AER, basePrice: 150, priceSensitivity: 0, costPerPassenger: 10, priceMin: 100.4, priceMax: 200.6 };
    const opt = optimalPrice(50, 100, route);
    expect(opt.price).toBeLessThanOrEqual(200.6);
    expect(opt.price).toBeGreaterThanOrEqual(100.4);
  });
});

describe('profitCurve', () => {
  it('61 evenly spaced integer prices from min to max, each following the formula', () => {
    const B = medianOf(AER_0601);
    const pts = profitCurve(B, AER_0601.seats, AER);
    expect(pts).toHaveLength(61);
    expect(pts[0]!.price).toBe(5400);
    expect(pts[60]!.price).toBe(18000);
    expect(pts[30]!.price).toBe(11700);
    for (let i = 0; i < pts.length; i++) {
      const p = pts[i]!;
      if (i > 0) expect(p.price).toBeGreaterThan(pts[i - 1]!.price);
      const r = computeForecast(AER_0601, AER, p.price);
      expect(p.sales).toBe(r.median.sales);
      expect(p.revenue).toBe(r.economics.revenue);
      expect(p.margin).toBe(r.economics.margin);
    }
  });

  it('sales on the curve are non-increasing in price', () => {
    const pts = profitCurve(medianOf(AER_0601), AER_0601.seats, AER, 200);
    for (let i = 1; i < pts.length; i++) expect(pts[i]!.sales).toBeLessThanOrEqual(pts[i - 1]!.sales);
  });

  it('at least 2 points; margin is null without cost', () => {
    const pts = profitCurve(100, 50, { ...AER, costPerPassenger: null }, 1);
    expect(pts.map((p) => p.price)).toEqual([5400, 18000]);
    expect(pts.every((p) => p.margin === null)).toBe(true);
  });

  it('the optimum is at least as good as every curve point', () => {
    for (const f of FLIGHTS) {
      const route = routeOf(f.route);
      const B = medianOf(f);
      const opt = optimalPrice(B, f.seats, route);
      for (const p of profitCurve(B, f.seats, route)) expect(opt.margin!).toBeGreaterThanOrEqual(p.margin! - 1e-6);
    }
  });
});

describe('daySummary', () => {
  it('mirrors computeForecast for the median', () => {
    const d = daySummary(AER_0601, AER, 9000);
    const r = computeForecast(AER_0601, AER, 9000);
    expect(d).toEqual({
      date: '2026-06-01',
      seats: 900,
      wants: 775,
      sales: 775,
      loadFactor: r.median.loadFactor,
      sellOut: r.sellOut,
    });
  });
});

describe('boardStatus', () => {
  it.each<[number, number, string]>([
    [900, 900, 'full'],
    [1000, 900, 'full'],
    [810, 900, 'almost'], // 0.9 exactly
    [809.99, 900, 'filling'],
    [630, 900, 'filling'], // 0.7 exactly
    [629.99, 900, 'available'],
    [0, 900, 'available'],
    [-50, 900, 'available'],
  ])('wants %d / seats %d → %s', (wants, seats, status) => {
    expect(boardStatus(wants, seats)).toBe(status);
  });
});
