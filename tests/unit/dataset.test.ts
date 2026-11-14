import fs from 'node:fs';
import path from 'node:path';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { CsvError } from '../../src/shared/csv';
import { msg, render } from '../../src/shared/messages';
import {
  enforceMonotone,
  normalizeDate,
  normalizeRouteCode,
  parseForecastCsv,
  parseRoutesCsv,
} from '../../src/shared/dataset';

const ROOT = path.resolve(__dirname, '..', '..');
const ROUTES_TEXT = fs.readFileSync(path.join(ROOT, 'data', 'routes.csv'), 'utf8');
const FORECAST_TEXT = fs.readFileSync(path.join(ROOT, 'data', 'seasonal_forecast.csv'), 'utf8');

const QS = [0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9];

/** Builds a forecast CSV with base_demand columns only. */
function forecastCsv(rows: Array<[string, string, number | string, ...Array<number | string>]>, qs = QS): string {
  const header = ['route', 'date', 'seats', ...qs.map((q) => `${q}_base_demand`)].join(',');
  return [header, ...rows.map((r) => r.join(','))].join('\n') + '\n';
}

function catchErr(fn: () => unknown): Error {
  try {
    fn();
  } catch (e) {
    return e as Error;
  }
  throw new Error('expected function to throw');
}

describe('normalizeRouteCode', () => {
  it.each([
    ['MOW-AER', 'MOW-AER'],
    [' mow-aer ', 'MOW-AER'],
    ['MOW — AER', 'MOW-AER'],
    ['MOW–AER', 'MOW-AER'],
    ['MOW_AER', 'MOW-AER'],
    ['MOW/AER', 'MOW-AER'],
    ['MOW→AER', 'MOW-AER'],
    ['MOW>AER', 'MOW-AER'],
  ])('%j -> %j', (raw, expected) => {
    expect(normalizeRouteCode(raw)).toBe(expected);
  });
});

describe('normalizeDate', () => {
  it.each([
    ['2026-06-01', '2026-06-01'],
    ['2026-6-1', '2026-06-01'],
    ['2026-06-01 00:00:00', '2026-06-01'], // pandas to_csv with datetime64
    ['2026-06-01T00:00:00', '2026-06-01'],
    ['2026-06-01T00:00:00.000Z', '2026-06-01'],
    ['  2026-06-01  ', '2026-06-01'],
    ['01.06.2026', '2026-06-01'],
    ['1.6.2026', '2026-06-01'],
    ['01/06/2026', '2026-06-01'], // DD/MM/YYYY
    ['29.02.2028', '2028-02-29'], // leap year
    ['2026-12-31', '2026-12-31'],
    ['2026/06/01', '2026-06-01'], // YYYY/MM/DD
    ['2026.06.01', '2026-06-01'], // YYYY.MM.DD
    ['2026/6/1 00:00', '2026-06-01'],
  ])('%j -> %j', (raw, expected) => {
    expect(normalizeDate(raw)).toBe(expected);
  });

  it.each([
    '2026-02-30',
    '2026-02-29', // not a leap year
    '2026-13-01',
    '2026-00-10',
    '2026-06-00',
    '2026-06-32',
    '31.04.2026',
    '06/01/26',
    '2026/02/30',
    '2026.13.01',
    'June 1, 2026',
    '',
    'nan',
    '20260601',
  ])('%j -> null', (raw) => {
    expect(normalizeDate(raw)).toBeNull();
  });
});

describe('parseRoutesCsv', () => {
  it('parses the real routes.csv', () => {
    const { routes, warnings } = parseRoutesCsv(ROUTES_TEXT);
    expect(warnings).toEqual([]);
    expect(routes.map((r) => r.code)).toEqual(['MOW-AER', 'MOW-LED', 'MOW-KGD', 'MOW-OVB', 'MOW-MRV']);
    expect(routes[0]).toEqual({
      code: 'MOW-AER',
      name: 'Москва — Сочи',
      origin: { code: 'MOW', name: 'Москва' },
      destination: { code: 'AER', name: 'Сочи' },
      basePrice: 9000,
      priceSensitivity: 0.141,
      costPerPassenger: 4200,
      priceMin: 5400,
      priceMax: 18000,
    });
    const mrv = routes.find((r) => r.code === 'MOW-MRV')!;
    expect(mrv.destination.name).toBe('Минеральные Воды');
    expect(mrv.priceSensitivity).toBe(0.0653);
  });

  it('splits names with em dash, en dash and hyphen surrounded by spaces', () => {
    const text = [
      'route,name,base_price,price_sensitivity',
      'MOW-AER,Москва — Сочи,9000,0.1',
      'MOW-LED,Москва – Санкт-Петербург,5500,0.2',
      'ROV-KZN,Ростов-на-Дону - Казань,5000,0.3',
    ].join('\n');
    const { routes } = parseRoutesCsv(text);
    expect(routes[0]!.origin.name).toBe('Москва');
    expect(routes[0]!.destination.name).toBe('Сочи');
    expect(routes[1]!.destination.name).toBe('Санкт-Петербург');
    expect(routes[2]!.origin.name).toBe('Ростов-на-Дону');
    expect(routes[2]!.destination.name).toBe('Казань');
  });

  it('falls back to known city names when the name column is missing', () => {
    const { routes } = parseRoutesCsv('route,base_price,price_sensitivity\nMOW-KZN,7000,0.1\n');
    expect(routes[0]!.origin).toEqual({ code: 'MOW', name: 'Москва' });
    expect(routes[0]!.destination).toEqual({ code: 'KZN', name: 'Казань' });
    expect(routes[0]!.name).toBe('Москва — Казань');
    expect(routes[0]!.costPerPassenger).toBeNull();
    expect(routes[0]!.priceMin).toBeNull();
    expect(routes[0]!.priceMax).toBeNull();
  });

  it('falls back to the IATA code for an unknown city and when the name cannot be split', () => {
    const { routes } = parseRoutesCsv(
      'route,name,base_price,price_sensitivity\nXXX-AER,,7000,0.1\nMOW-YYY,МоскваИгрек,7000,0.1\n',
    );
    expect(routes[0]!.origin).toEqual({ code: 'XXX', name: 'XXX' });
    expect(routes[0]!.destination).toEqual({ code: 'AER', name: 'Сочи' });
    expect(routes[0]!.name).toBe('XXX — Сочи');
    // Unsplittable name is kept as the route name, cities fall back to codes/known names.
    expect(routes[1]!.name).toBe('МоскваИгрек');
    expect(routes[1]!.origin.name).toBe('Москва');
    expect(routes[1]!.destination.name).toBe('YYY');
  });

  it('header matching is case-insensitive and column order does not matter', () => {
    const { routes } = parseRoutesCsv('Price_Sensitivity,BASE_PRICE,Route\n0.141,9000,mow-aer\n');
    expect(routes[0]!.code).toBe('MOW-AER');
    expect(routes[0]!.basePrice).toBe(9000);
    expect(routes[0]!.priceSensitivity).toBe(0.141);
  });

  it('reports all missing required columns', () => {
    const err = catchErr(() => parseRoutesCsv('route,name\nMOW-AER,x\n'));
    expect(err).toBeInstanceOf(CsvError);
    expect(err.message).toMatch(/base_price/);
    expect(err.message).toMatch(/price_sensitivity/);
    expect(err.message).not.toMatch(/route,/);
  });

  it('reports bad numbers with the line number', () => {
    const text = 'route,base_price,price_sensitivity\nMOW-AER,9000,0.141\nMOW-LED,abc,0.2\n';
    const err = catchErr(() => parseRoutesCsv(text)) as CsvError;
    expect(err).toBeInstanceOf(CsvError);
    expect(err.line).toBe(3);
    expect(err.message).toBe(msg('ru', 'line_prefix', { line: 3 }) + msg('ru', 'base_price_invalid', { code: 'MOW-LED' }));
    expect(err.message).toMatch(/base_price/);
    expect(err.message).toMatch(/MOW-LED/);
  });

  it.each([
    ['0', 'base_price'],
    ['-100', 'base_price'],
    ['', 'base_price'],
  ])('rejects base_price %j', (value, col) => {
    expect(() => parseRoutesCsv(`route,base_price,price_sensitivity\nMOW-AER,${value},0.1\n`)).toThrow(col);
  });

  it('rejects negative or non-numeric price_sensitivity; accepts zero', () => {
    expect(() => parseRoutesCsv('route,base_price,price_sensitivity\nMOW-AER,9000,-0.1\n')).toThrow(/price_sensitivity/);
    expect(() => parseRoutesCsv('route,base_price,price_sensitivity\nMOW-AER,9000,x\n')).toThrow(/price_sensitivity/);
    expect(parseRoutesCsv('route,base_price,price_sensitivity\nMOW-AER,9000,0\n').routes[0]!.priceSensitivity).toBe(0);
  });

  it('rejects garbage in optional numeric columns but accepts empty', () => {
    const err = catchErr(() =>
      parseRoutesCsv('route,base_price,price_sensitivity,price_min\nMOW-AER,9000,0.1,дёшево\n'),
    ) as CsvError;
    expect(err.line).toBe(2);
    expect(err.message).toMatch(/price_min/);
    expect(
      parseRoutesCsv('route,base_price,price_sensitivity,price_min\nMOW-AER,9000,0.1,\n').routes[0]!.priceMin,
    ).toBeNull();
  });

  it('rejects malformed route codes', () => {
    const key = (k: string) => expect.objectContaining({ key: k, line: 2 });
    expect(() => parseRoutesCsv('route,base_price,price_sensitivity\nMOWAER,9000,0.1\n')).toThrow(key('route_code_format'));
    expect(() => parseRoutesCsv('route,base_price,price_sensitivity\nMOW-AER-LED,9000,0.1\n')).toThrow(key('route_code_format'));
    expect(() => parseRoutesCsv('route,base_price,price_sensitivity\nMOW-,9000,0.1\n')).toThrow(key('route_code_format'));
    expect(() => parseRoutesCsv('route,base_price,price_sensitivity\n,9000,0.1\n')).toThrow(key('route_code_empty'));
    const err = catchErr(() => parseRoutesCsv('route,base_price,price_sensitivity\nMOWAER,9000,0.1\n')) as CsvError;
    expect(err.message).toBe(msg('ru', 'line_prefix', { line: 2 }) + msg('ru', 'route_code_format', { code: 'MOWAER' }));
  });

  it('warns about duplicate routes and keeps the last record', () => {
    const { routes, warnings } = parseRoutesCsv(
      'route,base_price,price_sensitivity\nMOW-AER,9000,0.1\nMOW-LED,5000,0.2\nmow-aer,9500,0.15\n',
    );
    expect(routes).toHaveLength(2);
    expect(routes.find((r) => r.code === 'MOW-AER')!.basePrice).toBe(9500);
    expect(warnings).toEqual([{ key: 'route_duplicate', params: { line: 4, code: 'MOW-AER' } }]);
    for (const lang of ['ru', 'en'] as const) {
      const text = render(lang, warnings[0]!);
      expect(text).toBe(msg(lang, 'route_duplicate', { line: 4, code: 'MOW-AER' }));
      expect(text).toContain('4');
      expect(text).toContain('MOW-AER');
    }
    expect(render('ru', warnings[0]!)).toMatch(/^Справочник маршрутов, строка 4:/);
  });

  it('throws when there are no data rows', () => {
    expect(() => parseRoutesCsv('route,base_price,price_sensitivity\n')).toThrow(msg('ru', 'routes_no_rows'));
    // Delimiter-only rows do not count as data.
    expect(() => parseRoutesCsv('route,base_price,price_sensitivity\n,,\n')).toThrow(msg('ru', 'routes_no_rows'));
  });

  it('ignores unknown extra columns', () => {
    const { routes } = parseRoutesCsv('route,foo,base_price,price_sensitivity,bar\nMOW-AER,x,9000,0.141,y\n');
    expect(routes[0]!.basePrice).toBe(9000);
  });
});

describe('parseForecastCsv', () => {
  it('отклоняет повторяющиеся заголовки маршрута, вместимости и квантиля', () => {
    expect(() => parseRoutesCsv('route,Route,base_price,price_sensitivity\nMOW-AER,MOW-LED,9000,0.1\n')).toThrow(CsvError);
    expect(() => parseForecastCsv('route,date,seats,SEATS,0.5_base_demand\nMOW-AER,2026-06-01,100,200,40\n')).toThrow(CsvError);
    expect(() => parseForecastCsv('route;date;seats;0.5_base_demand;0,50_base_demand\nMOW-AER;2026-06-01;100;40;60\n')).toThrow(CsvError);
  });

  it('parses the real seasonal_forecast.csv', () => {
    const parsed = parseForecastCsv(FORECAST_TEXT);
    expect(parsed.warnings).toEqual([]);
    expect(parsed.quantileLevels).toEqual(QS);
    expect(parsed.flights).toHaveLength(155);
    const f = parsed.flights.find((x) => x.route === 'MOW-AER' && x.date === '2026-06-01')!;
    expect(f.seats).toBe(900);
    expect(f.quantiles.map((q) => q.q)).toEqual(QS);
    expect(f.quantiles.map((q) => q.baseDemand)).toEqual([656, 694, 723, 742, 775, 802, 835, 863, 923]);
    expect(f.quantiles[4]).toEqual({ q: 0.5, baseDemand: 775, price: 9347, priceDemand: 726 });
    expect(f.quantiles[0]).toEqual({ q: 0.1, baseDemand: 656, price: 8928, priceDemand: 667 });
  });

  it('sorts flights by route then date', () => {
    const { flights } = parseForecastCsv(
      forecastCsv([
        ['MOW-LED', '2026-06-02', 100, 1, 2, 3, 4, 5, 6, 7, 8, 9],
        ['MOW-AER', '2026-06-03', 100, 1, 2, 3, 4, 5, 6, 7, 8, 9],
        ['MOW-AER', '2026-06-01', 100, 1, 2, 3, 4, 5, 6, 7, 8, 9],
      ]),
    );
    expect(flights.map((f) => `${f.route} ${f.date}`)).toEqual([
      'MOW-AER 2026-06-01',
      'MOW-AER 2026-06-03',
      'MOW-LED 2026-06-02',
    ]);
  });

  it('reports missing required columns', () => {
    const err = catchErr(() => parseForecastCsv('route,0.5_base_demand\nMOW-AER,1\n'));
    expect(err).toBeInstanceOf(CsvError);
    expect(err.message).toMatch(/date/);
    expect(err.message).toMatch(/seats/);
  });

  it('requires at least one quantile column', () => {
    expect(() => parseForecastCsv('route,date,seats\nMOW-AER,2026-06-01,100\n')).toThrow(/0\.5_base_demand/);
  });

  it('requires the median (0.5_base_demand) column', () => {
    const text = 'route,date,seats,0.1_base_demand,0.9_base_demand,0.5_price\nMOW-AER,2026-06-01,100,1,2,9000\n';
    const err = catchErr(() => parseForecastCsv(text));
    expect(err).toBeInstanceOf(CsvError);
    expect(err.message).toBe(msg('ru', 'no_median'));
  });

  it('auto-detects arbitrary quantile sets (e.g. only 0.25/0.5/0.75) and ignores _price-only levels', () => {
    const text =
      'route,date,seats,0.75_base_demand,0.25_base_demand,0.5_base_demand,0.95_price\n' +
      'MOW-AER,2026-06-01,100,30,10,20,9999\n';
    const parsed = parseForecastCsv(text);
    expect(parsed.quantileLevels).toEqual([0.25, 0.5, 0.75]);
    expect(parsed.flights[0]!.quantiles.map((q) => [q.q, q.baseDemand, q.price, q.priceDemand])).toEqual([
      [0.25, 10, null, null],
      [0.5, 20, null, null],
      [0.75, 30, null, null],
    ]);
  });

  it('ignores extra unknown columns', () => {
    const text =
      'id,route,comment,date,seats,0.5_base_demand,model_version,1_base_demand,0_base_demand\n' +
      '7,MOW-AER,"привет, мир",2026-06-01,100,50,v2,999,0\n';
    const parsed = parseForecastCsv(text);
    expect(parsed.quantileLevels).toEqual([0.5]);
    expect(parsed.flights[0]).toEqual({
      route: 'MOW-AER',
      date: '2026-06-01',
      seats: 100,
      quantiles: [{ q: 0.5, baseDemand: 50, price: null, priceDemand: null }],
    });
  });

  it('accepts float values (model output) and rounds seats', () => {
    const text = 'route,date,seats,0.5_base_demand,0.5_price,0.5_price_demand\nMOW-AER,2026-06-01,900.0,775.37,9347.5,726.25\n';
    const f = parseForecastCsv(text).flights[0]!;
    expect(f.seats).toBe(900);
    expect(f.quantiles[0]).toEqual({ q: 0.5, baseDemand: 775.37, price: 9347.5, priceDemand: 726.25 });
  });

  it('treats unparsable optional price/price_demand cells as null', () => {
    const text = 'route,date,seats,0.5_base_demand,0.5_price,0.5_price_demand\nMOW-AER,2026-06-01,900,775,,abc\n';
    const q = parseForecastCsv(text).flights[0]!.quantiles[0]!;
    expect(q.price).toBeNull();
    expect(q.priceDemand).toBeNull();
  });

  it.each([
    ['2026-06-01', '2026-06-01'],
    ['2026-06-01 00:00:00', '2026-06-01'],
    ['01.06.2026', '2026-06-01'],
  ])('accepts date %j', (raw, iso) => {
    const parsed = parseForecastCsv(forecastCsv([['MOW-AER', raw, 100, 1, 2, 3, 4, 5, 6, 7, 8, 9]]));
    expect(parsed.flights[0]!.date).toBe(iso);
  });

  it('rejects an invalid date with line number', () => {
    const text = forecastCsv([
      ['MOW-AER', '2026-02-28', 100, 1, 2, 3, 4, 5, 6, 7, 8, 9],
      ['MOW-AER', '2026-02-30', 100, 1, 2, 3, 4, 5, 6, 7, 8, 9],
    ]);
    const err = catchErr(() => parseForecastCsv(text)) as CsvError;
    expect(err).toBeInstanceOf(CsvError);
    expect(err.line).toBe(3);
    expect(err.message).toMatch(/2026-02-30/);
  });

  it('accepts fractional seats that round to at least 1', () => {
    const f = parseForecastCsv(forecastCsv([['MOW-AER', '2026-06-01', '0.6', 1, 2, 3, 4, 5, 6, 7, 8, 9]])).flights[0]!;
    expect(f.seats).toBe(1);
  });

  it('errors are localizable: CsvError.localize("en") keeps the line prefix', () => {
    const err = catchErr(() =>
      parseForecastCsv(forecastCsv([['MOW-AER', '2026-06-01', '0', 1, 2, 3, 4, 5, 6, 7, 8, 9]])),
    ) as CsvError;
    expect(err.key).toBe('seats_invalid');
    expect(err.message).toBe('Строка 2: ' + msg('ru', 'seats_invalid', { value: '0' }));
    expect(err.localize('en')).toBe('Line 2: ' + msg('en', 'seats_invalid', { value: '0' }));
  });

  it.each(['0', '-5', 'abc', '', '0.4', '0.49'])('rejects seats %j with line number', (seats) => {
    const err = catchErr(() =>
      parseForecastCsv(forecastCsv([['MOW-AER', '2026-06-01', seats, 1, 2, 3, 4, 5, 6, 7, 8, 9]])),
    ) as CsvError;
    expect(err).toBeInstanceOf(CsvError);
    expect(err.line).toBe(2);
    expect(err.message).toBe(msg('ru', 'line_prefix', { line: 2 }) + msg('ru', 'seats_invalid', { value: seats }));
  });

  it('rejects a non-numeric base_demand naming the column and line', () => {
    const err = catchErr(() =>
      parseForecastCsv(
        forecastCsv([
          ['MOW-AER', '2026-06-01', 100, 1, 2, 3, 4, 5, 6, 7, 8, 9],
          ['MOW-AER', '2026-06-02', 100, 1, 2, 3, 4, 5, 'x', 7, 8, 9],
        ]),
      ),
    ) as CsvError;
    expect(err.line).toBe(3);
    expect(err.message).toMatch(/0\.6_base_demand/);
    expect(err.message).toMatch(/«x»/);
  });

  it('rejects a missing (NaN) base_demand', () => {
    expect(() =>
      parseForecastCsv(forecastCsv([['MOW-AER', '2026-06-01', 100, 1, 2, 3, 4, 'nan', 6, 7, 8, 9]])),
    ).toThrow(/0\.5_base_demand/);
  });

  it('rejects an empty route', () => {
    expect(() => parseForecastCsv(forecastCsv([['', '2026-06-01', 100, 1, 2, 3, 4, 5, 6, 7, 8, 9]]))).toThrow(
      /маршрут/,
    );
  });

  it('throws when there are no data rows', () => {
    expect(() => parseForecastCsv(forecastCsv([]))).toThrow(msg('ru', 'forecast_no_rows'));
  });

  it('fixes crossing quantiles WITHOUT changing the median and emits one warning with the row count', () => {
    const parsed = parseForecastCsv(
      forecastCsv([
        ['MOW-AER', '2026-06-01', 900, 656, 694, 723, 742, 775, 760, 835, 863, 923], // 0.6 < 0.5
        ['MOW-AER', '2026-06-02', 900, 1, 2, 3, 4, 5, 6, 7, 8, 9],
        ['MOW-AER', '2026-06-03', 900, 9, 8, 7, 6, 5, 4, 3, 2, 1],
        ['MOW-AER', '2026-06-04', 900, 100, 300, 200, 250, 240, 230, 400, 350, 500], // crossing on both sides
      ]),
    );
    const [f1, f2, f3, f4] = parsed.flights;
    // Above the median values are clamped UP to the previous level; the median 775 stays.
    expect(f1!.quantiles.map((q) => q.baseDemand)).toEqual([656, 694, 723, 742, 775, 775, 835, 863, 923]);
    expect(f1!.quantiles.map((q) => q.q)).toEqual(QS);
    expect(f2!.quantiles.map((q) => q.baseDemand)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9]);
    // Fully reversed: everything collapses onto the median 5.
    expect(f3!.quantiles.map((q) => q.baseDemand)).toEqual([5, 5, 5, 5, 5, 5, 5, 5, 5]);
    // Below the median values are clamped DOWN to the next level (walking from the median outwards).
    expect(f4!.quantiles.map((q) => q.baseDemand)).toEqual([100, 200, 200, 240, 240, 240, 400, 400, 500]);
    expect(parsed.warnings).toEqual([{ key: 'quantiles_sorted', params: { count: 3 } }]);
    expect(render('ru', parsed.warnings[0]!)).toBe(msg('ru', 'quantiles_sorted', { count: 3 }));
    expect(render('en', parsed.warnings[0]!)).toBe(msg('en', 'quantiles_sorted', { count: 3 }));
  });

  it('quantiles_sorted pluralizes by count (Russian: 1/21 singular, 11 plural)', () => {
    const ru = (n: number) => msg('ru', 'quantiles_sorted', { count: n });
    // The form for 1 and 21 is the same, and differs from 2 / 11.
    expect(ru(1).replace('1', 'N')).toBe(ru(21).replace('21', 'N'));
    expect(ru(2).replace('2', 'N')).toBe(ru(11).replace('11', 'N'));
    expect(ru(1).replace('1', 'N')).not.toBe(ru(2).replace('2', 'N'));
    expect(msg('en', 'quantiles_sorted', { count: 1 }).replace('1', 'N')).not.toBe(
      msg('en', 'quantiles_sorted', { count: 2 }).replace('2', 'N'),
    );
  });

  it('enforceMonotone keeps the median for any input and makes demand non-decreasing', () => {
    fc.assert(
      fc.property(fc.array(fc.integer({ min: -1000, max: 5000 }), { minLength: 9, maxLength: 9 }), (demands) => {
        const qs = QS.map((q, i) => ({ q, baseDemand: demands[i]!, price: null, priceDemand: null }));
        const changed = enforceMonotone(qs);
        expect(qs[4]!.baseDemand).toBe(demands[4]);
        for (let i = 1; i < qs.length; i++) expect(qs[i]!.baseDemand).toBeGreaterThanOrEqual(qs[i - 1]!.baseDemand);
        const wasSorted = demands.every((d, i) => i === 0 || d >= demands[i - 1]!);
        expect(changed).toBe(!wasSorted);
        if (wasSorted) expect(qs.map((x) => x.baseDemand)).toEqual(demands);
      }),
      { numRuns: 300 },
    );
  });

  it('recognises quantile headers with a decimal comma (Excel RU: "0,5_base_demand")', () => {
    const text = 'route;date;seats;0,1_base_demand;0,5_base_demand;0,5_price;0,9_base_demand\nMOW-AER;01.06.2026;900;656;775;9347;923\n';
    const parsed = parseForecastCsv(text);
    expect(parsed.quantileLevels).toEqual([0.1, 0.5, 0.9]);
    expect(parsed.flights[0]!.quantiles[1]).toEqual({ q: 0.5, baseDemand: 775, price: 9347, priceDemand: null });
  });

  it('warns about duplicate flights and keeps the last row', () => {
    const parsed = parseForecastCsv(
      forecastCsv([
        ['MOW-AER', '2026-06-01', 900, 1, 2, 3, 4, 5, 6, 7, 8, 9],
        ['MOW-AER', '2026-06-02', 900, 1, 2, 3, 4, 5, 6, 7, 8, 9],
        ['mow-aer', '01.06.2026', 800, 10, 20, 30, 40, 50, 60, 70, 80, 90],
      ]),
    );
    expect(parsed.flights).toHaveLength(2);
    const f = parsed.flights.find((x) => x.date === '2026-06-01')!;
    expect(f.seats).toBe(800);
    expect(f.quantiles[4]!.baseDemand).toBe(50);
    expect(parsed.warnings).toEqual([
      { key: 'flight_duplicate', params: { line: 4, route: 'MOW-AER', date: '2026-06-01' } },
    ]);
    expect(render('ru', parsed.warnings[0]!)).toBe(
      msg('ru', 'flight_duplicate', { line: 4, route: 'MOW-AER', date: '2026-06-01' }),
    );
    expect(render('ru', parsed.warnings[0]!)).toMatch(/^Файл прогноза, строка 4:/);
  });

  it('normalizes route codes in the forecast', () => {
    const parsed = parseForecastCsv(forecastCsv([[' mow_aer ', '2026-06-01', 900, 1, 2, 3, 4, 5, 6, 7, 8, 9]]));
    expect(parsed.flights[0]!.route).toBe('MOW-AER');
  });

  // Regression: Excel (RU) appends ";;;" rows; they used to fail the whole file with "пустой маршрут".
  it('ignores delimiter-only rows produced by Excel', () => {
    const text = 'route;date;seats;0.5_base_demand\nMOW-AER;01.06.2026;900;775\n;;;\n;;;\n';
    const parsed = parseForecastCsv(text);
    expect(parsed.flights).toHaveLength(1);
    expect(parsed.warnings).toEqual([]);
  });
});

describe('Excel RU export (semicolon + decimal comma + BOM + CRLF + DD.MM.YYYY)', () => {
  /** Converts a plain comma CSV into what Russian Excel produces on "Save as CSV". */
  function toExcelRu(text: string): string {
    const lines = text.split(/\r?\n/).filter((l) => l !== '');
    const converted = lines.map((line, i) =>
      line
        .split(',')
        .map((cell) => {
          if (i === 0) return cell;
          const iso = /^(\d{4})-(\d{2})-(\d{2})$/.exec(cell);
          if (iso) return `${iso[3]}.${iso[2]}.${iso[1]}`;
          if (/^-?\d+(\.\d+)?$/.test(cell)) {
            const [int, frac] = cell.split('.');
            // Thousands separated by NBSP, decimal comma.
            const grouped = int!.replace(/\B(?=(\d{3})+(?!\d))/g, '\u00a0');
            return frac ? `${grouped},${frac}` : grouped;
          }
          return cell;
        })
        .join(';'),
    );
    return '\uFEFF' + converted.join('\r\n') + '\r\n';
  }

  it('the converted fixture really uses Excel conventions', () => {
    const excel = toExcelRu(ROUTES_TEXT);
    expect(excel).toContain('0,141');
    expect(excel).toContain('9\u00a0000');
    expect(excel).toContain(';');
    expect(toExcelRu(FORECAST_TEXT)).toContain('01.06.2026');
  });

  it('routes parse to the same values as the original', () => {
    expect(parseRoutesCsv(toExcelRu(ROUTES_TEXT))).toEqual(parseRoutesCsv(ROUTES_TEXT));
  });

  it('forecast parses to the same values as the original', () => {
    expect(parseForecastCsv(toExcelRu(FORECAST_TEXT))).toEqual(parseForecastCsv(FORECAST_TEXT));
  });

  it('tab-separated export parses to the same values as the original', () => {
    const tsv = FORECAST_TEXT.replace(/,/g, '\t');
    expect(parseForecastCsv(tsv)).toEqual(parseForecastCsv(FORECAST_TEXT));
  });
});
