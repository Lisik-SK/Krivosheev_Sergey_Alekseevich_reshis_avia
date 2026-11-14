/**
 * Независимый от src/ расчёт ожидаемых значений прямо из CSV-файлов.
 * Простой парсер: в файлах нет кавычек, разделитель — запятая.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const DATA_DIR = resolve(process.cwd(), 'data');
const QS = [0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9] as const;

function parseCsv(file: string): Record<string, string>[] {
  const text = readFileSync(resolve(DATA_DIR, file), 'utf8').replace(/^﻿/, '');
  const lines = text.split(/\r?\n/).filter((l) => l.trim() !== '');
  const head = lines[0]!.split(',').map((s) => s.trim());
  return lines.slice(1).map((line) => {
    const cells = line.split(',');
    const row: Record<string, string> = {};
    head.forEach((h, i) => (row[h] = (cells[i] ?? '').trim()));
    return row;
  });
}

export interface RouteRow {
  route: string;
  name: string;
  basePrice: number;
  sensitivity: number;
  priceMin: number;
  priceMax: number;
  cost: number;
}

export interface FlightRow {
  route: string;
  date: string;
  seats: number;
  base: Record<number, number>;
  modelPrice: number;
}

export const routes: RouteRow[] = parseCsv('routes.csv').map((r) => ({
  route: r.route!,
  name: r.name!,
  basePrice: Number(r.base_price),
  sensitivity: Number(r.price_sensitivity),
  priceMin: Number(r.price_min),
  priceMax: Number(r.price_max),
  cost: Number(r.cost_per_passenger),
}));

export const flights: FlightRow[] = parseCsv('seasonal_forecast.csv').map((r) => {
  const base: Record<number, number> = {};
  for (const q of QS) base[q] = Number(r[`${q}_base_demand`]);
  return { route: r.route!, date: r.date!, seats: Number(r.seats), base, modelPrice: Number(r['0.5_price']) };
});

export function route(code: string): RouteRow {
  const r = routes.find((x) => x.route === code);
  if (!r) throw new Error(`route ${code} not in routes.csv`);
  return r;
}

export function flight(code: string, date: string): FlightRow {
  const f = flights.find((x) => x.route === code && x.date === date);
  if (!f) throw new Error(`flight ${code} ${date} not in seasonal_forecast.csv`);
  return f;
}

export function datesOf(code: string): string[] {
  return flights.filter((f) => f.route === code).map((f) => f.date).sort();
}

/** Убираем хвосты плавающей точки. */
const fix = (x: number) => Math.round(x * 1e6) / 1e6;

export interface Scenario {
  q: number;
  base: number;
  wants: number;
  sales: number;
  overflow: number;
  free: number;
}

export interface Expected {
  seats: number;
  wants: number;
  sales: number;
  salesRounded: number;
  freeRounded: number;
  loadPct: number;
  scenarios: Scenario[];
  sellOut: string;
  modelPrice: number;
  outOfRange: boolean;
}

export function expected(code: string, date: string, price: number): Expected {
  const r = route(code);
  const f = flight(code, date);
  const scenarios: Scenario[] = QS.map((q) => {
    const wants = fix(f.base[q]! - r.sensitivity * (price - r.basePrice));
    const sales = Math.min(f.seats, Math.max(0, wants));
    return { q, base: f.base[q]!, wants, sales, overflow: fix(Math.max(0, wants - f.seats)), free: fix(f.seats - sales) };
  });
  const med = scenarios.find((s) => s.q === 0.5)!;
  const salesRounded = Math.min(f.seats, Math.floor(med.sales + 0.5));

  // P(спрос > мест): линейная интерполяция функции распределения между квантилями.
  let sellOut: string;
  const first = scenarios[0]!;
  const last = scenarios[scenarios.length - 1]!;
  if (f.seats < first.wants) sellOut = `≥ ${pct(1 - first.q)}`;
  else if (f.seats > last.wants) sellOut = `< ${pct(1 - last.q)}`;
  else {
    let cdf = last.q;
    for (let i = scenarios.length - 1; i >= 0; i--) {
      const p = scenarios[i]!;
      if (p.wants <= f.seats) {
        const n = scenarios[i + 1];
        cdf = !n || n.wants === p.wants ? p.q : p.q + ((f.seats - p.wants) / (n.wants - p.wants)) * (n.q - p.q);
        break;
      }
    }
    sellOut = `≈ ${pct(1 - cdf)}`;
  }

  return {
    seats: f.seats,
    wants: med.wants,
    sales: med.sales,
    salesRounded,
    freeRounded: f.seats - salesRounded,
    loadPct: Math.round((med.sales / f.seats) * 100),
    scenarios,
    sellOut,
    modelPrice: f.modelPrice,
    outOfRange: price < r.priceMin || price > r.priceMax,
  };
}

function pct(x: number): string {
  return `${Math.round(fix(x) * 100)}%`;
}

/** Формат как в UI (ru-RU, не более 1 знака после запятой), но без пробелов-разделителей. */
export function num1(x: number): string {
  const r = Math.sign(x) * Math.round(Math.abs(x) * 10) / 10;
  return String(r === 0 ? 0 : r).replace('.', ',');
}

export function int(x: number): string {
  const r = Math.sign(x) * Math.round(Math.abs(x));
  return String(r === 0 ? 0 : r);
}

/** Удаляет все виды пробелов (в т.ч. NBSP и узкий NBSP) и приводит минус к ASCII. */
export function norm(s: string | null | undefined): string {
  return (s ?? '').replace(/[\s   ]/g, '').replace(/−/g, '-');
}

/** Доход (выручка минус затраты на пассажиров) при цене p по медианному сценарию. */
export function margin(code: string, date: string, price: number): number {
  const r = route(code);
  const e = expected(code, date, price);
  return fix((price - r.cost) * e.sales);
}

/**
 * Лучшая цена перебором: максимум (p − cost) × min(seats, max(0, B − s(p − p0)))
 * по целым p в [price_min, price_max]; при равенстве — меньшая цена.
 */
export function bruteForceOptimum(code: string, date: string): { price: number; value: number } {
  const r = route(code);
  const f = flight(code, date);
  const B = f.base[0.5]!;
  let best = { price: r.priceMin, value: -Infinity };
  for (let p = r.priceMin; p <= r.priceMax; p++) {
    const sales = Math.min(f.seats, Math.max(0, fix(B - r.sensitivity * (p - r.basePrice))));
    const value = fix((p - r.cost) * sales);
    if (value > best.value) best = { price: p, value };
  }
  return best;
}

export type BoardStatus = 'available' | 'filling' | 'almost' | 'full';

export function boardRow(code: string, date: string, mode: 'base' | 'model') {
  const r = route(code);
  const f = flight(code, date);
  const price = mode === 'model' ? f.modelPrice : r.basePrice;
  const e = expected(code, date, price);
  const load = e.wants / e.seats;
  const status: BoardStatus = e.wants >= e.seats ? 'full' : load >= 0.9 ? 'almost' : load >= 0.7 ? 'filling' : 'available';
  return { price, ...e, status };
}

/** Процент загрузки, как он показан в UI (целое число процентов). */
export function loadPctOf(code: string, date: string, price: number): number {
  return expected(code, date, price).loadPct;
}
