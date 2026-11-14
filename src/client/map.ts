/**
 * Схема направлений (дополнение 8): города по реальным координатам в простой
 * равнопромежуточной проекции, дуги из аэропорта вылета. Толщина дуги — сколько
 * человек хотят лететь (медиана). Сетка меридианов и параллелей — как на
 * аэронавигационной карте, без границ и подложки, чтобы не шуметь.
 */
import type { BoardFlight } from './api';
import { clear, h, s, observeWidth } from './dom';
import { fmtInt, fmtNum } from './format';
import { cityName, t } from './i18n';

/** Координаты аэропортов (долгота, широта). Неизвестные города раскладываются по кругу. */
const COORDS: Record<string, [number, number]> = {
  MOW: [37.62, 55.75],
  LED: [30.31, 59.94],
  AER: [39.92, 43.45],
  KGD: [20.51, 54.71],
  OVB: [82.92, 55.03],
  MRV: [43.08, 44.22],
  KZN: [49.12, 55.79],
  SVX: [60.6, 56.84],
  KRR: [38.98, 45.04],
  ROV: [39.72, 47.22],
  UFA: [55.96, 54.73],
  KUF: [50.1, 53.2],
  VVO: [131.88, 43.12],
  KJA: [92.87, 56.01],
  IKT: [104.28, 52.29],
  MMK: [33.08, 68.97],
  AAQ: [37.32, 44.89],
  SIP: [34.1, 44.95],
  GOJ: [44.0, 56.33],
  PEE: [56.25, 58.01],
  TJM: [65.53, 57.15],
  OMS: [73.37, 54.98],
  CEK: [61.4, 55.16],
  KHV: [135.07, 48.48],
};

export function renderRouteMap(flights: BoardFlight[], onPick: (f: BoardFlight) => void, width: number): SVGSVGElement {
  const W = Math.max(320, width);
  const H = Math.round(Math.min(420, Math.max(260, W * 0.42)));
  const pad = 46;

  const codes = new Set<string>();
  for (const f of flights) {
    codes.add(f.origin.code);
    codes.add(f.destination.code);
  }
  const known = [...codes].filter((c) => COORDS[c]);
  const coords = new Map<string, [number, number]>(known.map((c) => [c, COORDS[c]!]));
  // Неизвестные коды — по окружности вокруг центра известных.
  const unknown = [...codes].filter((c) => !COORDS[c]);
  const cx0 = known.length ? known.reduce((a, c) => a + COORDS[c]![0], 0) / known.length : 40;
  const cy0 = known.length ? known.reduce((a, c) => a + COORDS[c]![1], 0) / known.length : 55;
  unknown.forEach((c, i) => {
    const a = (i / Math.max(1, unknown.length)) * Math.PI * 2;
    coords.set(c, [cx0 + Math.cos(a) * 12, cy0 + Math.sin(a) * 6]);
  });

  const lons = [...coords.values()].map((c) => c[0]);
  const lats = [...coords.values()].map((c) => c[1]);
  const minLon = Math.min(...lons) - 2;
  const maxLon = Math.max(...lons) + 2;
  const minLat = Math.min(...lats) - 1.5;
  const maxLat = Math.max(...lats) + 1.5;
  const k = Math.cos((((minLat + maxLat) / 2) * Math.PI) / 180);
  const spanX = (maxLon - minLon) * k;
  const spanY = maxLat - minLat;
  const scale = Math.min((W - pad * 2) / spanX, (H - pad * 2) / spanY);
  const offX = (W - spanX * scale) / 2;
  const offY = (H - spanY * scale) / 2;
  const proj = ([lon, lat]: [number, number]): [number, number] => [
    offX + (lon - minLon) * k * scale,
    offY + (maxLat - lat) * scale,
  ];

  const svg = s('svg', { viewBox: `0 0 ${W} ${H}`, width: W, height: H, class: 'map', 'data-testid': 'route-map' });

  // Сетка: меридианы и параллели каждые 5°
  const g = s('g', { class: 'map__grid', 'aria-hidden': 'true' });
  for (let lon = Math.ceil(minLon / 5) * 5; lon <= maxLon; lon += 5) {
    const [x] = proj([lon, minLat]);
    g.append(s('line', { x1: x, x2: x, y1: 0, y2: H }));
  }
  for (let lat = Math.ceil(minLat / 5) * 5; lat <= maxLat; lat += 5) {
    const [, y] = proj([minLon, lat]);
    g.append(s('line', { x1: 0, x2: W, y1: y, y2: y }));
  }
  svg.append(g);

  const maxWants = Math.max(1, ...flights.map((f) => Math.max(0, f.wants)));
  const arcs = s('g');
  const sorted = [...flights].sort((a, b) => b.wants - a.wants);
  for (const f of sorted) {
    const [x1, y1] = proj(coords.get(f.origin.code)!);
    const [x2, y2] = proj(coords.get(f.destination.code)!);
    const mx = (x1 + x2) / 2;
    const my = (y1 + y2) / 2;
    const dx = x2 - x1;
    const dy = y2 - y1;
    const len = Math.hypot(dx, dy) || 1;
    const bend = Math.min(60, len * 0.18);
    const cx = mx + (-dy / len) * bend;
    const cy = my + (dx / len) * bend;
    const d = `M${x1.toFixed(1)},${y1.toFixed(1)} Q${cx.toFixed(1)},${cy.toFixed(1)} ${x2.toFixed(1)},${y2.toFixed(1)}`;
    const width = 2 + (Math.max(0, f.wants) / maxWants) * 9;
    const label = t('map.aria', { route: `${cityName(f.origin)} → ${cityName(f.destination)}`, wants: fmtNum(f.wants), seats: fmtInt(f.seats) });
    const group = s('g', { class: 'map__route', tabindex: 0, role: 'button', 'aria-label': label, 'data-route': f.route });
    group.append(
      s('path', { class: 'map__hit', d }),
      s('path', { class: 'map__arc', d, 'stroke-width': width.toFixed(1) }),
      s('title', null, label),
    );
    const pick = () => onPick(f);
    group.addEventListener('click', pick);
    group.addEventListener('keydown', (e) => {
      if ((e as KeyboardEvent).key === 'Enter' || (e as KeyboardEvent).key === ' ') {
        e.preventDefault();
        pick();
      }
    });
    arcs.append(group);
  }
  svg.append(arcs);

  // Города
  const origins = new Set(flights.map((f) => f.origin.code));
  const names = new Map<string, string>();
  for (const f of flights) {
    names.set(f.origin.code, cityName(f.origin));
    names.set(f.destination.code, cityName(f.destination));
  }
  const projected = [...coords].map(([code, c]) => ({ code, p: proj(c) }));
  for (const { code, p } of projected) {
    const [x, y] = p;
    const hub = origins.has(code);
    // Если правее близко другой город, подпись ставим слева, чтобы не наезжала.
    const crowded = projected.some((o) => o.code !== code && o.p[0] > x && o.p[0] - x < 90 && Math.abs(o.p[1] - y) < 30);
    const right = x < W - 120 && !crowded;
    svg.append(
      s('circle', { class: hub ? 'map__hub' : 'map__node', cx: x, cy: y, r: hub ? 7 : 5 }),
      s('text', { class: 'map__code', x: x + (right ? 11 : -11), y: y - 2, 'text-anchor': right ? 'start' : 'end' }, code),
      s('text', { class: 'map__name', x: x + (right ? 11 : -11), y: y + 12, 'text-anchor': right ? 'start' : 'end' }, names.get(code) ?? code),
    );
  }
  return svg;
}

/** Обёртка, перерисовывающая карту при изменении ширины. */
export class RouteMap {
  readonly root = h('div', { class: 'map-wrap' });
  private flights: BoardFlight[] = [];
  private width = 720;
  private readonly stopObserving: () => void;

  constructor(private readonly onPick: (f: BoardFlight) => void) {
    this.stopObserving = observeWidth(this.root, (width) => {
      if (width > 0 && Math.abs(width - this.width) > 1) {
        this.width = width;
        this.render();
      }
    });
  }

  update(flights: BoardFlight[]) {
    this.flights = flights;
    const w = this.root.clientWidth;
    if (w > 0) this.width = w;
    this.render();
  }

  destroy() {
    this.stopObserving();
  }

  private render() {
    clear(this.root);
    if (this.flights.length) this.root.append(renderRouteMap(this.flights, this.onPick, this.width));
  }
}
