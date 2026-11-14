/**
 * Кривая «выручка и доход от цены» (дополнение 1).
 * Одна ось в рублях: обе линии в одних единицах. Доход — акцентная линия,
 * выручка — приглушённая. Перекрестие с подсказкой, клик выбирает цену.
 */
import type { CurveResponse } from './api';
import { clear, h, s, observeWidth } from './dom';
import { fmtInt, fmtMoneyShort, fmtNum, fmtPrice } from './format';
import { t } from './i18n';

const M = { top: 30, right: 20, bottom: 44, left: 64 };
const PLOT_H = 220;

function niceStep(range: number, target = 5): number {
  const raw = range / target;
  const pow = 10 ** Math.floor(Math.log10(raw));
  const n = raw / pow;
  return (n <= 1 ? 1 : n <= 2 ? 2 : n <= 2.5 ? 2.5 : n <= 5 ? 5 : 10) * pow;
}

export class ProfitCurveChart {
  readonly root: HTMLDivElement;
  private readonly tooltip: HTMLDivElement;
  private data: CurveResponse | null = null;
  private price = 0;
  private width = 720;
  private hover: number | null = null;
  private readonly stopObserving: () => void;

  constructor(private readonly onPick: (price: number) => void) {
    this.tooltip = h('div', { class: 'tooltip', role: 'presentation', hidden: true });
    this.root = h('div', { class: 'chart chart--curve', 'data-testid': 'profit-curve' });
    this.stopObserving = observeWidth(this.root, (width) => {
      if (width > 0 && Math.abs(width - this.width) > 1) {
        this.width = width;
        this.render();
      }
    });
  }

  update(data: CurveResponse, price: number) {
    this.data = data;
    this.price = price;
    const w = this.root.clientWidth;
    if (w > 0) this.width = w;
    this.render();
  }

  setLoading(v: boolean) {
    this.root.classList.toggle('is-loading', v);
  }

  destroy() {
    this.stopObserving();
  }

  private render() {
    const d = this.data;
    this.hover = null;
    this.tooltip.hidden = true;
    clear(this.root);
    if (!d || d.points.length < 2) return;
    const W = Math.max(320, this.width);
    const compact = W < 520;
    const m = { ...M, left: compact ? 52 : M.left };
    const plotW = W - m.left - m.right;
    const H = m.top + PLOT_H + m.bottom;
    const hasMargin = d.points.every((p) => p.margin !== null);

    const { min: x0, max: x1 } = d.bounds;
    const x = (p: number) => m.left + ((p - x0) / Math.max(1, x1 - x0)) * plotW;
    const values = d.points.flatMap((p) => [p.revenue, p.margin ?? 0]);
    const vMax = Math.max(1, ...values);
    const vMin = Math.min(0, ...values);
    const step = niceStep((vMax - vMin) * 1.08, 4);
    const yMax = Math.ceil((vMax * 1.08) / step) * step;
    const yMin = Math.floor(vMin / step) * step;
    const y = (v: number) => m.top + PLOT_H - ((v - yMin) / (yMax - yMin)) * PLOT_H;

    const svg = s('svg', {
      viewBox: `0 0 ${W} ${H}`,
      width: W,
      height: H,
      role: 'group',
      'aria-label': t('pc.aria', { from: fmtPrice(x0), to: fmtPrice(x1) }),
    });

    for (let v = yMin; v <= yMax + 1e-6; v += step) {
      const yy = Math.round(y(v)) + 0.5;
      svg.append(
        s('line', { class: v === 0 ? 'axis' : 'grid', x1: m.left, x2: m.left + plotW, y1: yy, y2: yy }),
        s('text', { class: 'tick-y', x: m.left - 8, y: yy + 4, 'text-anchor': 'end' }, fmtMoneyShort(v)),
      );
    }
    const xStep = niceStep(x1 - x0, compact ? 3 : 6);
    for (let p = Math.ceil(x0 / xStep) * xStep; p <= x1 + 1e-6; p += xStep) {
      svg.append(s('text', { class: 'tick-y', x: x(p), y: m.top + PLOT_H + 18, 'text-anchor': 'middle' }, fmtInt(p)));
    }
    svg.append(
      s('text', { x: m.left + plotW, y: m.top + PLOT_H + 38, 'text-anchor': 'end' }, t('pc.priceAxis')),
    );

    const path = (sel: (i: number) => number) =>
      d.points.map((p, i) => `${i === 0 ? 'M' : 'L'}${x(p.price).toFixed(1)},${y(sel(i)).toFixed(1)}`).join(' ');

    // Выручка — приглушённая линия
    svg.append(s('path', { class: 'line-muted', d: path((i) => d.points[i]!.revenue) }));
    // Доход — акцентная линия с лёгкой заливкой
    if (hasMargin) {
      const line = path((i) => d.points[i]!.margin!);
      const area = `${line} L${x(x1).toFixed(1)},${y(Math.max(0, yMin)).toFixed(1)} L${x(x0).toFixed(1)},${y(Math.max(0, yMin)).toFixed(1)} Z`;
      svg.append(s('path', { class: 'area-accent', d: area }), s('path', { class: 'line-accent', d: line }));
    }

    // Отметки: текущая цена, цена модели, максимум
    // Подписи отметок — в легенде над графиком, на самом графике только линии.
    const marker = (p: number, cls: string) => {
      if (p < x0 || p > x1) return;
      const xx = Math.round(x(p)) + 0.5;
      svg.append(s('line', { class: cls, x1: xx, x2: xx, y1: m.top, y2: m.top + PLOT_H }));
    };
    if (d.modelPrice !== null) marker(d.modelPrice, 'marker-model');
    marker(this.price, 'marker-current');

    const best = d.optimum;
    const bestVal = best.margin ?? best.revenue;
    svg.append(
      s('circle', { class: 'dot-accent', cx: x(best.price), cy: y(bestVal), r: 5 }),
    );

    // Перекрестие
    const cross = s('line', { class: 'crosshair', x1: 0, x2: 0, y1: m.top, y2: m.top + PLOT_H, visibility: 'hidden' });
    const dotA = s('circle', { class: 'dot-accent', r: 4, visibility: 'hidden' });
    const dotM = s('circle', { class: 'dot-muted', r: 4, visibility: 'hidden' });
    svg.append(cross, dotM, dotA);

    const hit = s('rect', {
      class: 'hit',
      x: m.left,
      y: m.top,
      width: plotW,
      height: PLOT_H,
      tabindex: 0,
      role: 'slider',
      'aria-label': t('pc.title'),
      'aria-valuemin': x0,
      'aria-valuemax': x1,
      'aria-valuenow': this.price,
    });
    const nearest = (clientX: number) => {
      const rect = svg.getBoundingClientRect();
      const scale = rect.width / W;
      const px = (clientX - rect.left) / scale;
      let bi = 0;
      let bd = Infinity;
      d.points.forEach((p, i) => {
        const dist = Math.abs(x(p.price) - px);
        if (dist < bd) {
          bd = dist;
          bi = i;
        }
      });
      return bi;
    };
    const show = (i: number | null) => {
      this.hover = i;
      if (i === null) {
        cross.setAttribute('visibility', 'hidden');
        dotA.setAttribute('visibility', 'hidden');
        dotM.setAttribute('visibility', 'hidden');
        this.tooltip.hidden = true;
        return;
      }
      const p = d.points[i]!;
      const xx = x(p.price);
      cross.setAttribute('x1', String(xx));
      cross.setAttribute('x2', String(xx));
      cross.setAttribute('visibility', 'visible');
      dotM.setAttribute('cx', String(xx));
      dotM.setAttribute('cy', String(y(p.revenue)));
      dotM.setAttribute('visibility', 'visible');
      if (p.margin !== null) {
        dotA.setAttribute('cx', String(xx));
        dotA.setAttribute('cy', String(y(p.margin)));
        dotA.setAttribute('visibility', 'visible');
      }
      clear(this.tooltip);
      const row = (key: string, label: string, value: string) =>
        h('div', { class: 'tooltip__row' }, h('span', { class: `tooltip__key tooltip__key--${key}` }), h('span', null, label), h('strong', null, value));
      this.tooltip.append(h('div', { class: 'tooltip__title' }, fmtPrice(p.price)));
      if (p.margin !== null) this.tooltip.append(row('sold', t('pc.margin'), fmtMoneyShort(p.margin)));
      this.tooltip.append(row('muted', t('pc.revenue'), fmtMoneyShort(p.revenue)), row('none', t('pc.tipSales'), fmtNum(p.sales)));
      this.tooltip.hidden = false;
      const rect = svg.getBoundingClientRect();
      const scale = rect.width / W;
      const tipW = this.tooltip.offsetWidth || 200;
      let left = xx * scale + 12;
      if (left + tipW > this.root.clientWidth - 4) left = xx * scale - 12 - tipW;
      this.tooltip.style.left = `${Math.max(4, left)}px`;
      this.tooltip.style.top = `${m.top * scale}px`;
    };
    hit.addEventListener('pointermove', (e) => show(nearest((e as PointerEvent).clientX)));
    hit.addEventListener('pointerleave', () => show(null));
    hit.addEventListener('click', (e) => {
      const i = nearest((e as MouseEvent).clientX);
      this.onPick(d.points[i]!.price);
    });
    hit.addEventListener('focus', () => {
      const idx = d.points.findIndex((p) => p.price >= this.price);
      show(idx === -1 ? d.points.length - 1 : idx);
    });
    hit.addEventListener('blur', () => show(null));
    hit.addEventListener('keydown', (e) => {
      const ke = e as KeyboardEvent;
      const cur = this.hover ?? 0;
      if (ke.key === 'ArrowRight' || ke.key === 'ArrowLeft') {
        e.preventDefault();
        show(Math.min(d.points.length - 1, Math.max(0, cur + (ke.key === 'ArrowRight' ? 1 : -1))));
      } else if (ke.key === 'Enter' || ke.key === ' ') {
        e.preventDefault();
        this.onPick(d.points[cur]!.price);
      }
    });
    svg.append(hit);

    this.root.append(svg, this.tooltip);
  }
}
