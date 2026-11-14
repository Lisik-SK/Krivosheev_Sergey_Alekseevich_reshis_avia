/**
 * Вариант A из условия: «простое прогнозирование» из командной строки.
 *
 *   npm run forecast -- --from MOW --to AER --date 2026-06-15 --price 9500
 *   npm run forecast -- --from Москва --to Сочи --date 15.06.2026 --price 9500 --chart
 *   node dist/node/cli/forecast.js MOW AER 2026-06-15 9500
 *
 * Файлы берутся из тех же переменных окружения, что и у сервера
 * (FORECAST_PATH, ROUTES_PATH, DATA_DIR), либо из флагов --forecast и --routes.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { loadConfig } from '../server/config.js';
import { normalizeDate, parseForecastCsv, parseRoutesCsv } from '../shared/dataset.js';
import { computeForecast, resolveCityCode, type ForecastResult } from '../shared/forecast.js';

const HELP = `Прогноз продаж билетов «Решись Авиа»

Использование:
  forecast --from <город|код> --to <город|код> --date <дата> --price <цена> [--chart] [--json]
  forecast <откуда> <куда> <дата> <цена>

Параметры:
  --from      пункт отправления: код IATA (MOW) или название (Москва)
  --to        пункт назначения: код IATA (AER) или название (Сочи)
  --date      дата вылета: 2026-06-15 или 15.06.2026
  --price     цена билета, руб.
  --chart     нарисовать распределение спроса по сценариям
  --json      вывести результат в JSON
  --forecast  путь к файлу прогноза (по умолчанию data/seasonal_forecast.csv)
  --routes    путь к справочнику маршрутов (по умолчанию data/routes.csv)
  -h, --help  показать эту справку
`;

export class CliError extends Error {}

export interface CliOptions {
  from: string;
  to: string;
  date: string;
  price: string;
  chart: boolean;
  json: boolean;
  forecastPath: string;
  routesPath: string;
}

export function parseCliArgs(argv: string[], env: NodeJS.ProcessEnv = process.env): CliOptions | 'help' {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      from: { type: 'string' },
      to: { type: 'string' },
      date: { type: 'string' },
      price: { type: 'string' },
      chart: { type: 'boolean', default: false },
      json: { type: 'boolean', default: false },
      forecast: { type: 'string' },
      routes: { type: 'string' },
      help: { type: 'boolean', short: 'h', default: false },
    },
  });
  if (values.help) return 'help';
  const [pFrom, pTo, pDate, pPrice] = positionals;
  const cfg = loadConfig({ ...env, NODE_ENV: 'development' });
  const opts = {
    from: values.from ?? pFrom ?? '',
    to: values.to ?? pTo ?? '',
    date: values.date ?? pDate ?? '',
    price: values.price ?? pPrice ?? '',
    chart: values.chart ?? false,
    json: values.json ?? false,
    forecastPath: values.forecast ? path.resolve(values.forecast) : cfg.forecastPath,
    routesPath: values.routes ? path.resolve(values.routes) : cfg.routesPath,
  };
  const missing = (['from', 'to', 'date', 'price'] as const).filter((k) => !opts[k].trim());
  if (missing.length) throw new CliError(`Не хватает параметров: ${missing.map((m) => '--' + m).join(', ')}`);
  return opts;
}

export function runForecast(opts: CliOptions): ForecastResult {
  const read = (file: string) => {
    try {
      return fs.readFileSync(file, 'utf8');
    } catch {
      throw new CliError(`Не удалось прочитать файл ${file}`);
    }
  };
  const { routes } = parseRoutesCsv(read(opts.routesPath));
  const { flights } = parseForecastCsv(read(opts.forecastPath));

  const from = resolveCityCode(opts.from, routes);
  if (!from) throw new CliError(`Пункт отправления «${opts.from}» не найден в справочнике маршрутов`);
  const to = resolveCityCode(opts.to, routes);
  if (!to) throw new CliError(`Пункт назначения «${opts.to}» не найден в справочнике маршрутов`);
  const route = routes.find((r) => r.code === `${from}-${to}`);
  if (!route) {
    const options = routes.filter((r) => r.origin.code === from).map((r) => `${r.destination.name} (${r.destination.code})`);
    throw new CliError(
      `Направления ${from} → ${to} нет в справочнике.` + (options.length ? ` Из этого города есть направления: ${options.join(', ')}.` : ''),
    );
  }
  const date = normalizeDate(opts.date);
  if (!date) throw new CliError(`Не удалось прочитать дату «${opts.date}». Формат: 2026-06-15 или 15.06.2026`);
  const flight = flights.find((f) => f.route === route.code && f.date === date);
  if (!flight) {
    const dates = flights.filter((f) => f.route === route.code).map((f) => f.date);
    throw new CliError(
      `На ${date} рейса ${route.code} в прогнозе нет.` +
        (dates.length ? ` Доступны даты с ${dates[0]} по ${dates[dates.length - 1]}.` : ''),
    );
  }
  const priceStr = opts.price.replace(/[\s ₽]/g, '').replace(',', '.');
  const price = Number(priceStr);
  if (!/^\d+(\.\d+)?$/.test(priceStr) || !Number.isFinite(price)) {
    throw new CliError(`Цена «${opts.price}» должна быть неотрицательным числом`);
  }
  // Как и сервер, округляем цену до копеек, чтобы результаты совпадали.
  return computeForecast(flight, route, Math.round(price * 100) / 100);
}

const nf = (x: number, digits = 1) => x.toLocaleString('ru-RU', { maximumFractionDigits: digits });

export function formatResult(r: ForecastResult, chart: boolean): string {
  const lines = [
    `${r.route.origin.name} (${r.route.origin.code}) → ${r.route.destination.name} (${r.route.destination.code}), ${r.date}`,
    `Цена билета:        ${nf(r.price, 2)} ₽ (базовая ${nf(r.route.basePrice)} ₽)`,
    `Мест в самолёте:    ${r.seats}`,
    `Хотят купить:       ${nf(r.median.wants)}  = ${nf(r.median.baseDemand)} − ${r.route.priceSensitivity} × (${nf(r.price, 2)} − ${nf(r.route.basePrice)})`,
    `Прогноз продаж:     ${nf(r.median.sales)}  = min(${r.seats}, max(0, ${nf(r.median.wants)}))`,
    `Свободно мест:      ${nf(r.median.freeSeats)}`,
  ];
  if (chart) {
    const max = Math.max(r.seats, ...r.scenarios.map((s) => s.wants), 1);
    const width = 40;
    const seatCol = Math.round((r.seats / max) * width);
    lines.push('', 'Спрос по сценариям при этой цене (| — число мест):');
    for (const s of r.scenarios) {
      const len = Math.max(0, Math.round((Math.max(0, s.wants) / max) * width));
      let bar = '';
      for (let i = 0; i < Math.max(len, seatCol + 1); i++) {
        if (i === seatCol) bar += '|';
        else if (i < len) bar += i < seatCol ? '█' : '░';
        else bar += ' ';
      }
      const tag = s.q === 0.5 ? ' ← медиана' : s.capped ? ' (мест не хватает)' : '';
      lines.push(`  P${String(Math.round(s.q * 100)).padStart(2, '0')} ${bar} ${nf(s.wants)}${tag}`);
    }
  }
  return lines.join('\n');
}

export function main(argv: string[]): number {
  try {
    const opts = parseCliArgs(argv);
    if (opts === 'help') {
      process.stdout.write(HELP);
      return 0;
    }
    const result = runForecast(opts);
    process.stdout.write(
      (opts.json
        ? JSON.stringify(
            {
              route: result.route.code,
              date: result.date,
              price: result.price,
              seats: result.seats,
              wants: result.median.wants,
              sales: result.median.sales,
              freeSeats: result.median.freeSeats,
              scenarios: result.scenarios,
            },
            null,
            2,
          )
        : formatResult(result, opts.chart)) + '\n',
    );
    return 0;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    process.stderr.write(`Ошибка: ${msg}\n\n`);
    if (err instanceof CliError || (err as Error).name === 'TypeError') process.stderr.write('Справка: forecast --help\n');
    return err instanceof CliError || (err as { code?: string }).code?.startsWith('ERR_PARSE_ARGS') ? 2 : 1;
  }
}

const stripExt = (p: string) => p.replace(/\.(ts|js)$/, '');
const isDirectRun =
  process.argv[1] !== undefined && stripExt(path.resolve(process.argv[1])) === stripExt(fileURLToPath(import.meta.url));
if (isDirectRun) process.exitCode = main(process.argv.slice(2));
