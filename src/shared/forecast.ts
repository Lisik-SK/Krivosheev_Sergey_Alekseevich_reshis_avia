/**
 * Формула «простого прогнозирования» из условия кейса:
 *
 *   желают = base_demand − price_sensitivity × (цена − base_price)
 *   купят  = min(seats, max(0, желают))
 *
 * Для медианы берётся 0.5_base_demand, для остальных сценариев — base_demand
 * соответствующего квантиля.
 */
import type { FlightForecast, RouteInfo } from './dataset.js';

export interface ScenarioResult {
  q: number;
  /** Спрос при базовой цене (из файла). */
  baseDemand: number;
  /** Сколько человек хотят купить при введённой цене (может быть < 0 и > seats). */
  wants: number;
  /** Сколько купят: ограничено снизу нулём, сверху числом мест. */
  sales: number;
  /** Сколько желающих не поместится в самолёт. */
  overflow: number;
  /** Продажи упёрлись в число мест. */
  capped: boolean;
}

export interface SellOutProbability {
  /** Вероятность того, что спрос превысит число мест, 0..1. */
  value: number;
  /** exact — интерполяция между квантилями; atLeast/atMost — оценка за пределами сетки квантилей. */
  bound: 'exact' | 'atLeast' | 'atMost';
}

export interface ForecastResult {
  route: RouteInfo;
  date: string;
  price: number;
  seats: number;
  /** Медианный сценарий (q = 0.5) — основной ответ. */
  median: {
    baseDemand: number;
    wants: number;
    sales: number;
    freeSeats: number;
    loadFactor: number;
    /** Округлённые до целых билетов значения для показа. */
    rounded: { wants: number; sales: number; freeSeats: number };
  };
  scenarios: ScenarioResult[];
  sellOut: SellOutProbability;
  /** Выручка и доход за вычетом затрат на пассажиров по медианному сценарию. */
  economics: Economics;
  /** Цена, которую ML-модель считает лучшей для медианного сценария (если есть в файле). */
  modelPrice: number | null;
  /** Цена вне рекомендованного диапазона price_min..price_max. */
  priceOutOfRange: boolean;
}

/** Убирает хвосты двоичной арифметики: 775 − 0.141×500 = 704.5, а не 704.4999999. */
export function clean(x: number): number {
  return Math.round(x * 1e6) / 1e6;
}

/** Округление половин вверх для неотрицательных значений (704.5 → 705). */
export function roundTickets(x: number): number {
  return Math.floor(clean(x) + 0.5);
}

export function wantsAtPrice(baseDemand: number, route: Pick<RouteInfo, 'basePrice' | 'priceSensitivity'>, price: number): number {
  return clean(baseDemand - route.priceSensitivity * (price - route.basePrice));
}

export function salesFromWants(wants: number, seats: number): number {
  return Math.min(seats, Math.max(0, wants));
}

/**
 * Вероятность, что спрос (при данной цене) превысит число мест.
 * Квантили задают точки функции распределения F(wants_q) = q; между ними — линейная интерполяция.
 */
export function sellOutProbability(scenarios: Array<Pick<ScenarioResult, 'q' | 'wants'>>, seats: number): SellOutProbability {
  const pts = [...scenarios].sort((a, b) => a.q - b.q);
  const first = pts[0];
  const last = pts[pts.length - 1];
  if (!first || !last) return { value: 0, bound: 'exact' };
  if (seats < first.wants) return { value: clean(1 - first.q), bound: 'atLeast' };
  if (seats > last.wants) return { value: clean(1 - last.q), bound: 'atMost' };
  // Ищем отрезок, в который попадает seats. При равных значениях берём правую границу.
  let cdf = last.q;
  for (let i = pts.length - 1; i >= 0; i--) {
    const p = pts[i]!;
    if (p.wants <= seats) {
      const next = pts[i + 1];
      if (!next || next.wants === p.wants) {
        cdf = p.q;
      } else {
        cdf = p.q + ((seats - p.wants) / (next.wants - p.wants)) * (next.q - p.q);
      }
      break;
    }
  }
  return { value: clean(1 - cdf), bound: 'exact' };
}

export function computeForecast(flight: FlightForecast, route: RouteInfo, price: number): ForecastResult {
  const seats = flight.seats;
  const scenarios: ScenarioResult[] = flight.quantiles.map((qf) => {
    const wants = wantsAtPrice(qf.baseDemand, route, price);
    const sales = salesFromWants(wants, seats);
    return {
      q: qf.q,
      baseDemand: qf.baseDemand,
      wants,
      sales,
      overflow: clean(Math.max(0, wants - seats)),
      capped: wants >= seats,
    };
  });

  const medianScenario = scenarios.find((s) => s.q === 0.5);
  if (!medianScenario) throw new Error('В прогнозе нет медианы (0.5_base_demand)');
  const medianQuantile = flight.quantiles.find((x) => x.q === 0.5);

  const sales = medianScenario.sales;
  const roundedSales = Math.min(seats, roundTickets(sales));
  const roundedWants = Math.sign(medianScenario.wants) * roundTickets(Math.abs(medianScenario.wants));

  return {
    route,
    date: flight.date,
    price,
    seats,
    median: {
      baseDemand: medianScenario.baseDemand,
      wants: medianScenario.wants,
      sales,
      freeSeats: clean(seats - sales),
      loadFactor: clean(sales / seats),
      rounded: { wants: roundedWants, sales: roundedSales, freeSeats: seats - roundedSales },
    },
    scenarios,
    sellOut: sellOutProbability(scenarios, seats),
    economics: economics(price, sales, route.costPerPassenger),
    modelPrice: medianQuantile?.price ?? null,
    priceOutOfRange:
      (route.priceMin !== null && price < route.priceMin) || (route.priceMax !== null && price > route.priceMax),
  };
}

/** Нормализация названия города для поиска: регистр, ё/е, лишние пробелы и дефисы. */
export function normalizeCityQuery(s: string): string {
  return s
    .trim()
    .toLowerCase()
    .replace(/ё/g, 'е')
    .replace(/[\s\-–—]+/g, ' ');
}

/** Находит код города по коду IATA или названию (в любом регистре). */
export function resolveCityCode(query: string, routes: RouteInfo[]): string | null {
  const q = normalizeCityQuery(query);
  if (!q) return null;
  for (const r of routes) {
    for (const c of [r.origin, r.destination]) {
      if (c.code.toLowerCase() === q || normalizeCityQuery(c.name) === q) return c.code;
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Экономика рейса, кривая прибыли, месяц и табло (дополнения)
// ---------------------------------------------------------------------------

export interface Economics {
  /** Выручка = цена × продажи. */
  revenue: number;
  /** Затраты на пассажиров = cost_per_passenger × продажи (если затраты известны). */
  passengerCost: number | null;
  /** Выручка минус затраты на пассажиров. Затраты на сам рейс в данных не заданы. */
  margin: number | null;
}

export function economics(price: number, sales: number, costPerPassenger: number | null): Economics {
  const revenue = clean(price * sales);
  if (costPerPassenger === null) return { revenue, passengerCost: null, margin: null };
  const passengerCost = clean(costPerPassenger * sales);
  return { revenue, passengerCost, margin: clean(revenue - passengerCost) };
}

export function priceBounds(route: RouteInfo): { min: number; max: number } {
  const min = route.priceMin ?? Math.round(route.basePrice * 0.5);
  const max = route.priceMax ?? Math.round(route.basePrice * 2);
  return { min: Math.min(min, max), max: Math.max(min, max) };
}

export interface CurvePoint {
  price: number;
  sales: number;
  revenue: number;
  margin: number | null;
}

export interface OptimumResult {
  price: number;
  sales: number;
  revenue: number;
  margin: number | null;
  /** По какому показателю искали максимум. */
  objective: 'margin' | 'revenue';
  /** Продажи упираются в число мест при этой цене. */
  capped: boolean;
}

/**
 * Лучшая цена для медианного сценария в диапазоне [min, max].
 * Прибыль f(p) = (p − c) · min(S, max(0, B − s·(p − p0))) кусочно-квадратичная,
 * поэтому максимум лежит в одной из точек: границы диапазона, вершина параболы
 * p* = (B + s·p0 + s·c) / (2s) или цена, при которой спрос ровно равен числу мест.
 */
export function optimalPrice(
  baseDemand: number,
  seats: number,
  route: RouteInfo,
  bounds = priceBounds(route),
): OptimumResult {
  const c = route.costPerPassenger;
  const objective: OptimumResult['objective'] = c === null ? 'revenue' : 'margin';
  const cost = c ?? 0;
  const s = route.priceSensitivity;
  const p0 = route.basePrice;
  const candidates = [bounds.min, bounds.max];
  if (s > 0) {
    candidates.push((baseDemand + s * p0 + s * cost) / (2 * s));
    candidates.push(p0 + (baseDemand - seats) / s);
  }
  let best: OptimumResult | null = null;
  for (const raw of candidates) {
    // Сначала округляем до рубля, потом ограничиваем диапазоном: цена не выйдет за границы.
    const price = Math.min(bounds.max, Math.max(bounds.min, Math.round(raw)));
    const wants = wantsAtPrice(baseDemand, route, price);
    const sales = salesFromWants(wants, seats);
    const value = clean((price - cost) * sales);
    if (!best || value > clean((best.price - cost) * best.sales) || (value === clean((best.price - cost) * best.sales) && price < best.price)) {
      const e = economics(price, sales, c);
      best = { price, sales, revenue: e.revenue, margin: e.margin, objective, capped: wants >= seats };
    }
  }
  return best!;
}

export function profitCurve(baseDemand: number, seats: number, route: RouteInfo, points = 61, bounds = priceBounds(route)): CurvePoint[] {
  const out: CurvePoint[] = [];
  const n = Math.max(2, points);
  for (let i = 0; i < n; i++) {
    const price = Math.min(bounds.max, Math.max(bounds.min, Math.round(bounds.min + ((bounds.max - bounds.min) * i) / (n - 1))));
    const sales = salesFromWants(wantsAtPrice(baseDemand, route, price), seats);
    const e = economics(price, sales, route.costPerPassenger);
    out.push({ price, sales, revenue: e.revenue, margin: e.margin });
  }
  return out;
}

export interface DaySummary {
  date: string;
  seats: number;
  wants: number;
  sales: number;
  loadFactor: number;
  sellOut: SellOutProbability;
}

export function daySummary(flight: FlightForecast, route: RouteInfo, price: number): DaySummary {
  const r = computeForecast(flight, route, price);
  return {
    date: flight.date,
    seats: r.seats,
    wants: r.median.wants,
    sales: r.median.sales,
    loadFactor: r.median.loadFactor,
    sellOut: r.sellOut,
  };
}

export type BoardStatus = 'available' | 'filling' | 'almost' | 'full';

/** Статус рейса для табло по медианному спросу. */
export function boardStatus(wants: number, seats: number): BoardStatus {
  if (wants >= seats) return 'full';
  const load = wants / seats;
  if (load >= 0.9) return 'almost';
  if (load >= 0.7) return 'filling';
  return 'available';
}
