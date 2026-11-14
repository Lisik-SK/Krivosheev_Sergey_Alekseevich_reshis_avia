/**
 * Cross-check against an independent Python/pandas implementation of the formula.
 * The fixture is produced by `python -I scripts/make_golden.py` and committed.
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { parseForecastCsv, parseRoutesCsv } from '../../src/shared/dataset';
import { computeForecast } from '../../src/shared/forecast';

interface GoldenCase {
  route: string;
  date: string;
  seats: number;
  priceLabel: string;
  price: number;
  wants: number[];
  sales: number[];
}
interface Golden {
  quantiles: number[];
  cases: GoldenCase[];
}

const ROOT = path.resolve(__dirname, '..', '..');
const FORECAST = path.join(ROOT, 'data', 'seasonal_forecast.csv');
const ROUTES = path.join(ROOT, 'data', 'routes.csv');
const GOLDEN_PATH = path.join(ROOT, 'tests', 'fixtures', 'golden.json');

const golden = JSON.parse(fs.readFileSync(GOLDEN_PATH, 'utf8')) as Golden;
const { routes } = parseRoutesCsv(fs.readFileSync(ROUTES, 'utf8'));
const { flights, quantileLevels } = parseForecastCsv(fs.readFileSync(FORECAST, 'utf8'));

const TOL = 1e-6;

describe('golden cross-check (Python reference vs TypeScript)', () => {
  it('golden file covers every flight with 7 price points and the same quantile levels', () => {
    expect(golden.quantiles).toEqual(quantileLevels);
    const keys = new Set(golden.cases.map((c) => `${c.route}|${c.date}`));
    expect(keys.size).toBe(flights.length);
    for (const f of flights) expect(keys.has(`${f.route}|${f.date}`)).toBe(true);
    expect(golden.cases.length).toBe(flights.length * 7);
  });

  it('every wants/sales value matches within 1e-6', () => {
    let compared = 0;
    const mismatches: string[] = [];
    for (const c of golden.cases) {
      const flight = flights.find((f) => f.route === c.route && f.date === c.date);
      const route = routes.find((r) => r.code === c.route);
      expect(flight, `${c.route} ${c.date}`).toBeDefined();
      expect(route, c.route).toBeDefined();
      const res = computeForecast(flight!, route!, c.price);
      expect(res.seats).toBe(c.seats);
      expect(res.scenarios.map((s) => s.q)).toEqual(golden.quantiles);
      res.scenarios.forEach((s, i) => {
        const ctx = `${c.route} ${c.date} ${c.priceLabel}=${c.price} q=${s.q}`;
        if (Math.abs(s.wants - c.wants[i]!) > TOL) mismatches.push(`${ctx} wants ${s.wants} != ${c.wants[i]}`);
        if (Math.abs(s.sales - c.sales[i]!) > TOL) mismatches.push(`${ctx} sales ${s.sales} != ${c.sales[i]}`);
        compared += 2;
      });
      const medianIdx = golden.quantiles.indexOf(0.5);
      expect(res.median.wants).toBeCloseTo(c.wants[medianIdx]!, 6);
      expect(res.median.sales).toBeCloseTo(c.sales[medianIdx]!, 6);
    }
    expect(mismatches).toEqual([]);
    expect(compared).toBe(flights.length * 7 * golden.quantiles.length * 2);
  });

  it('golden set exercises both clamps (0 and seats) and the unclamped region', () => {
    const all = golden.cases.flatMap((c) => c.sales.map((s, i) => ({ s, w: c.wants[i]!, seats: c.seats })));
    expect(all.some((x) => x.w < 0 && x.s === 0)).toBe(true);
    expect(all.some((x) => x.w > x.seats && x.s === x.seats)).toBe(true);
    expect(all.some((x) => x.w > 0 && x.w < x.seats && x.s === x.w)).toBe(true);
  });

  describe('fixture is up to date', () => {
    const python = process.platform === 'win32' ? 'python' : 'python3';
    const probe = spawnSync(python, ['-I', '-c', 'import pandas'], { encoding: 'utf8' });
    const hasPandas = probe.status === 0;
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'golden-'));
    afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));

    it.skipIf(!hasPandas)('re-running scripts/make_golden.py reproduces the committed golden.json', () => {
      const out = path.join(tmp, 'golden.json');
      const res = spawnSync(python, ['-I', path.join(ROOT, 'scripts', 'make_golden.py'), FORECAST, ROUTES, out], {
        encoding: 'utf8',
      });
      expect(res.status, res.stderr).toBe(0);
      expect(JSON.parse(fs.readFileSync(out, 'utf8'))).toEqual(golden);
    });
  });
});
