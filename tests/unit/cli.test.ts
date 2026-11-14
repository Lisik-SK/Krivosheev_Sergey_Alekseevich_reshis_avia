import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import { CliError, formatResult, main, parseCliArgs, runForecast, type CliOptions } from '../../src/cli/forecast';

const ROOT = path.resolve(__dirname, '..', '..');
const FORECAST = path.join(ROOT, 'data', 'seasonal_forecast.csv');
const ROUTES = path.join(ROOT, 'data', 'routes.csv');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cli-test-'));
afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));

function opts(over: Partial<CliOptions> = {}): CliOptions {
  return {
    from: 'MOW',
    to: 'AER',
    date: '2026-06-01',
    price: '9500',
    chart: false,
    json: false,
    forecastPath: FORECAST,
    routesPath: ROUTES,
    ...over,
  };
}

function cliError(fn: () => unknown): CliError {
  try {
    fn();
  } catch (e) {
    expect(e).toBeInstanceOf(CliError);
    return e as CliError;
  }
  throw new Error('expected CliError');
}

describe('parseCliArgs', () => {
  it('reads flags', () => {
    const o = parseCliArgs(['--from', 'MOW', '--to', 'AER', '--date', '2026-06-15', '--price', '9500', '--chart'], {});
    expect(o).toMatchObject({ from: 'MOW', to: 'AER', date: '2026-06-15', price: '9500', chart: true, json: false });
  });

  it('reads --flag=value form', () => {
    const o = parseCliArgs(['--from=Москва', '--to=Сочи', '--date=15.06.2026', '--price=9500', '--json'], {});
    expect(o).toMatchObject({ from: 'Москва', to: 'Сочи', date: '15.06.2026', price: '9500', json: true });
  });

  it('reads positionals', () => {
    const o = parseCliArgs(['MOW', 'AER', '2026-06-15', '9500'], {});
    expect(o).toMatchObject({ from: 'MOW', to: 'AER', date: '2026-06-15', price: '9500', chart: false });
  });

  it('flags override positionals', () => {
    const o = parseCliArgs(['MOW', 'AER', '2026-06-15', '9500', '--price', '10000'], {}) as CliOptions;
    expect(o.price).toBe('10000');
    expect(o.from).toBe('MOW');
  });

  it('defaults data paths to data/ in the project root', () => {
    const o = parseCliArgs(['MOW', 'AER', '2026-06-15', '9500'], {}) as CliOptions;
    expect(o.forecastPath).toBe(FORECAST);
    expect(o.routesPath).toBe(ROUTES);
  });

  it('takes data paths from env (FORECAST_PATH / ROUTES_PATH / DATA_DIR)', () => {
    const o = parseCliArgs(['MOW', 'AER', '2026-06-15', '9500'], { DATA_DIR: tmp }) as CliOptions;
    expect(o.forecastPath).toBe(path.join(tmp, 'seasonal_forecast.csv'));
    expect(o.routesPath).toBe(path.join(tmp, 'routes.csv'));
    const o2 = parseCliArgs(['MOW', 'AER', '2026-06-15', '9500'], {
      FORECAST_PATH: path.join(tmp, 'f.csv'),
      ROUTES_PATH: path.join(tmp, 'r.csv'),
    }) as CliOptions;
    expect(o2.forecastPath).toBe(path.join(tmp, 'f.csv'));
    expect(o2.routesPath).toBe(path.join(tmp, 'r.csv'));
  });

  it('--forecast / --routes flags win and are resolved to absolute paths', () => {
    const o = parseCliArgs(['MOW', 'AER', '2026-06-15', '9500', '--forecast', 'x.csv', '--routes', 'y.csv'], {
      FORECAST_PATH: '/elsewhere.csv',
    }) as CliOptions;
    expect(o.forecastPath).toBe(path.resolve('x.csv'));
    expect(o.routesPath).toBe(path.resolve('y.csv'));
  });

  it('returns "help" for --help and -h, even with other params missing', () => {
    expect(parseCliArgs(['--help'], {})).toBe('help');
    expect(parseCliArgs(['-h'], {})).toBe('help');
    expect(parseCliArgs(['MOW', '-h'], {})).toBe('help');
  });

  it('throws CliError listing all missing params', () => {
    const e = cliError(() => parseCliArgs(['MOW'], {}));
    expect(e.message).toMatch(/--to/);
    expect(e.message).toMatch(/--date/);
    expect(e.message).toMatch(/--price/);
    expect(e.message).not.toMatch(/--from/);
    expect(cliError(() => parseCliArgs([], {})).message).toMatch(/--from, --to, --date, --price/);
  });

  it('treats whitespace-only values as missing', () => {
    expect(cliError(() => parseCliArgs(['--from', ' ', '--to', 'AER', '--date', '2026-06-01', '--price', '1'], {})).message).toMatch(
      /--from/,
    );
  });

  it('unknown options are rejected by node:util parseArgs', () => {
    expect(() => parseCliArgs(['--frm', 'MOW'], {})).toThrow(expect.objectContaining({ code: 'ERR_PARSE_ARGS_UNKNOWN_OPTION' }));
  });
});

describe('runForecast', () => {
  it('computes the median for codes and ISO date', () => {
    const r = runForecast(opts());
    expect(r.route.code).toBe('MOW-AER');
    expect(r.median.wants).toBe(704.5);
    expect(r.median.sales).toBe(704.5);
  });

  it('accepts city names in any case and DD.MM.YYYY', () => {
    const r = runForecast(opts({ from: 'москва', to: 'Санкт-Петербург', date: '15.06.2026', price: '6000' }));
    expect(r.route.code).toBe('MOW-LED');
    expect(r.date).toBe('2026-06-15');
    expect(r.median.wants).toBe(780); // 927 − 0.294 × 500
  });

  it.each([
    ['9 500', 9500],
    ['9500,5', 9500.5],
    ['9500.5', 9500.5],
    ['9500₽', 9500],
    ['0', 0],
    ['9500.555', 9500.56], // rounded to kopecks like the server
    ['9500,004', 9500],
  ])('accepts price %j', (price, value) => {
    expect(runForecast(opts({ price })).price).toBe(value);
  });

  it.each(['-100', 'abc', '1e4', '', '9500 рублей', '.5'])('rejects price %j', (price) => {
    expect(cliError(() => runForecast(opts({ price }))).message).toMatch(/Цена/);
  });

  it('unknown origin / destination', () => {
    expect(cliError(() => runForecast(opts({ from: 'Лондон' }))).message).toMatch(/отправления «Лондон»/);
    expect(cliError(() => runForecast(opts({ to: 'Париж' }))).message).toMatch(/назначения «Париж»/);
  });

  it('missing route lists available destinations from the origin', () => {
    const e = cliError(() => runForecast(opts({ from: 'MOW', to: 'MOW' })));
    expect(e.message).toMatch(/MOW → MOW/);
    expect(e.message).toMatch(/Сочи \(AER\)/);
    const e2 = cliError(() => runForecast(opts({ from: 'AER', to: 'MOW' })));
    expect(e2.message).toMatch(/AER → MOW/);
    expect(e2.message).not.toMatch(/есть направления/);
    expect(e.message).toMatch(/Из этого города есть направления: Сочи \(AER\)/);
  });

  it('bad date', () => {
    expect(cliError(() => runForecast(opts({ date: '2026-02-30' }))).message).toMatch(/дату/);
    expect(cliError(() => runForecast(opts({ date: 'завтра' }))).message).toMatch(/дату/);
  });

  it('date out of range shows the available range', () => {
    const e = cliError(() => runForecast(opts({ date: '2026-08-01' })));
    expect(e.message).toMatch(/2026-08-01/);
    expect(e.message).toMatch(/с 2026-06-01 по 2026-07-01/);
  });

  it('unreadable file → CliError', () => {
    expect(cliError(() => runForecast(opts({ forecastPath: path.join(tmp, 'nope.csv') }))).message).toMatch(
      /Не удалось прочитать файл/,
    );
  });
});

describe('formatResult', () => {
  it('contains the route, inputs and computed numbers', () => {
    const out = formatResult(runForecast(opts()), false);
    expect(out).toContain('Москва (MOW) → Сочи (AER), 2026-06-01');
    expect(out).toMatch(/Цена билета:\s+9\s500 ₽ \(базовая 9\s000 ₽\)/);
    expect(out).toMatch(/Мест в самолёте:\s+900/);
    expect(out).toMatch(/Хотят купить:\s+704,5 {2}= 775 − 0\.141 × \(9\s500 − 9\s000\)/);
    expect(out).not.toContain('Желают');
    expect(out).toMatch(/Прогноз продаж:\s+704,5 {2}= min\(900, max\(0, 704,5\)\)/);
    expect(out).toMatch(/Свободно мест:\s+195,5/);
    expect(out).not.toContain('P50');
  });

  it('chart lists every scenario and marks the median and capped scenarios', () => {
    const out = formatResult(runForecast(opts({ price: '9000' })), true);
    for (const p of ['P10', 'P20', 'P30', 'P40', 'P50', 'P60', 'P70', 'P80', 'P90']) expect(out).toContain(p);
    expect(out).toMatch(/P50 .*775 ← медиана/);
    expect(out).toMatch(/P90 .*923 \(мест не хватает\)/);
    expect(out).not.toMatch(/P80 .*\(мест не хватает\)/); // 863 < 900
    expect(out).toContain('|');
  });

  it('chart handles negative demand (all bars empty)', () => {
    const out = formatResult(runForecast(opts({ price: '50000' })), true);
    expect(out).toMatch(/P50 .*-5\s006 ← медиана/); // 775 − 0.141 × 41000 = −5006
  });
});

describe('main', () => {
  let out = '';
  let err = '';
  const spyOut = () => vi.spyOn(process.stdout, 'write').mockImplementation((s) => ((out += String(s)), true));
  const spyErr = () => vi.spyOn(process.stderr, 'write').mockImplementation((s) => ((err += String(s)), true));
  afterEach(() => {
    vi.restoreAllMocks();
    out = '';
    err = '';
  });

  it('prints the forecast and returns 0', () => {
    spyOut();
    expect(main(['MOW', 'AER', '2026-06-01', '9500', '--routes', ROUTES, '--forecast', FORECAST])).toBe(0);
    expect(out).toContain('704,5');
  });

  it('--json prints machine-readable output', () => {
    spyOut();
    expect(main(['MOW', 'AER', '2026-06-01', '9500', '--json', '--routes', ROUTES, '--forecast', FORECAST])).toBe(0);
    const j = JSON.parse(out);
    expect(j).toMatchObject({ route: 'MOW-AER', date: '2026-06-01', price: 9500, seats: 900, wants: 704.5, sales: 704.5, freeSeats: 195.5 });
    expect(j.scenarios).toHaveLength(9);
  });

  it('--help returns 0', () => {
    spyOut();
    expect(main(['--help'])).toBe(0);
    expect(out).toMatch(/Использование/);
  });

  it('usage errors return 2 and print a hint', () => {
    spyErr();
    expect(main(['MOW'])).toBe(2);
    expect(err).toMatch(/Не хватает параметров/);
    expect(err).toMatch(/--help/);
    err = '';
    expect(main(['--bogus'])).toBe(2);
    expect(err).toMatch(/--help/);
    expect(main(['MOW', 'AER', '2026-06-01', 'дорого', '--routes', ROUTES, '--forecast', FORECAST])).toBe(2);
  });

  it('a broken data file returns 1', () => {
    const bad = path.join(tmp, 'bad.csv');
    fs.writeFileSync(bad, 'route,date\nMOW-AER,2026-06-01\n');
    spyErr();
    expect(main(['MOW', 'AER', '2026-06-01', '9500', '--forecast', bad, '--routes', ROUTES])).toBe(1);
    expect(err).toMatch(/seats/);
  });
});

describe('CLI process (npx tsx)', () => {
  const run = (args: string[]) =>
    // Arguments here are plain ASCII tokens, so joining them into one shell command is safe.
    spawnSync(['npx', 'tsx', 'src/cli/forecast.ts', ...args].join(' '), {
      cwd: ROOT,
      encoding: 'utf8',
      shell: true,
      env: { ...process.env, FORECAST_PATH: '', ROUTES_PATH: '', DATA_DIR: '' },
      timeout: 60_000,
    });

  it('exits 0 with the forecast on stdout', () => {
    const res = run(['MOW', 'AER', '2026-06-01', '9500', '--json']);
    expect(res.status, res.stderr).toBe(0);
    const j = JSON.parse(res.stdout);
    expect(j.wants).toBe(704.5);
    expect(j.sales).toBe(704.5);
  });

  it('exits 2 on missing params', () => {
    const res = run(['MOW']);
    expect(res.status).toBe(2);
    expect(res.stderr).toMatch(/Не хватает параметров/);
    expect(res.stdout).toBe('');
  });
});
