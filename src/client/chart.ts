/**
 * График распределения спроса при введённой цене.
 *
 * Каждый столбец — сценарий (квантиль прогноза). Нижняя часть — сколько билетов
 * купят, верхняя (другим цветом, через зазор 2px) — сколько желающих не поместится.
 * Пунктир — число мест: сразу видно, упираются ли продажи в вместимость.
 * Медиана подписана и совпадает с числом «хотят купить» из простого прогноза.
 */
import type { ScenarioResult } from '../shared/forecast';
import { bindChartTap } from './chart-tap';
import { h, s, clear, observeWidth } from './dom';
import { fmtInt, fmtNum, fmtPrice, quantileLabel } from './format';
import { t } from './i18n';

export interface ChartData {
  scenarios: ScenarioResult[];
  seats: number;
  price: number;
}

const M = { top: 36, right: 86, bottom: 58, left: 50 };
const PLOT_H = 240;
const BAR_MAX = 24;
const GAP = 2;
const R = 4;

function niceStep(range: number, target = 5): number {
  const raw = range / target;
  const pow = 10 ** Math.floor(Math.log10(raw));
  const n = raw / pow;
  const step = n <= 1 ? 1 : n <= 2 ? 2 : n <= 2.5 ? 2.5 : n <= 5 ? 5 : 10;
  return step * pow;
}

/** Прямоугольник со скруглёнными верхними углами и прямым основанием. */
function topRoundedRect(x: number, y: number, w: number, hgt: number, r: number): string {
  const rr = Math.max(0, Math.min(r, w / 2, hgt));
  return [
    `M${x},${y + hgt}`,
    `V${y + rr}`,
    `Q${x},${y} ${x + rr},${y}`,
    `H${x + w - rr}`,
    `Q${x + w},${y} ${x + w},${y + rr}`,
    `V${y + hgt}`,
    'Z',
  ].join(' ');
}

/**
 * Отображает распределение спроса и подсказку выбранного сценария.
 * Владеет узлами графика, обработчиками ввода и наблюдателем ширины.
 * Владелец добавляет root в DOM, передаёт данные через update и вызывает destroy при удалении.
 */
export class DemandChart {
  readonly root: HTMLDivElement;
  private readonly tooltip: HTMLDivElement;
  private data: ChartData | null = null;
  private width = 720;
  private activeIndex: number | null = null;
  private isTouchActive = false;
  private readonly stopTrackingTouch: () => void;
  private readonly stopObserving: () => void;

  /**
   * Создаёт пустой график и подключает закрытие подсказки касанием снаружи
   * и перерисовку при изменении ширины контейнера.
   * @remarks Аргументов нет. Требуется загруженный DOM. Подписки и наблюдатель
   * принадлежат экземпляру, их освобождает destroy. Ошибки DOM не перехватываются.
   */
  constructor() {
    this.tooltip = h('div', { class: 'tooltip', role: 'presentation', hidden: true });
    this.root = h('div', { class: 'chart chart--demand', 'data-testid': 'demand-chart' });
    this.stopTrackingTouch = bindChartTap(
      this.root,
      (hit) => {
        const index = this.cols.findIndex((col) => col.contains(hit));
        if (index !== -1) this.toggleTouchTooltip(index);
      },
      () => {
        if (this.isTouchActive) this.activate(null);
      },
    );
    this.stopObserving = observeWidth(this.root, (width) => {
      if (width > 0 && Math.abs(width - this.width) > 1) {
        this.width = width;
        this.render();
      }
    });
  }

  setLoading(loading: boolean) {
    this.root.classList.toggle('is-loading', loading);
  }

  update(data: ChartData) {
    this.data = data;
    const w = this.root.clientWidth;
    if (w > 0) this.width = w;
    this.render();
  }

  /**
   * Освобождает подписки на касания и наблюдатель ширины графика.
   * @returns void. Повторный вызов допустим. Узел графика удаляет владелец.
   * @remarks Аргументов нет. Ошибки освобождения ресурсов не перехватываются.
   */
  destroy(): void {
    this.stopTrackingTouch();
    this.stopObserving();
  }

  /**
   * Перестраивает SVG из текущих данных и ширины, связывает столбцы с вводом
   * и восстанавливает активный сценарий, если он ещё существует.
   * @returns void. При отсутствии данных очищает контейнер.
   * @remarks Аргументов нет. Заменяет дочерние узлы контейнера и геометрию графика.
   * Слушатели столбцов принадлежат новым узлам. Ошибки построения не перехватываются.
   */
  private render() {
    const d = this.data;
    clear(this.root);
    if (!d) return;

    const W = Math.max(320, this.width);
    const compact = W < 520;
    const m = { ...M, right: compact ? 64 : M.right, left: compact ? 42 : M.left };
    const plotW = W - m.left - m.right;
    const H = m.top + PLOT_H + m.bottom;

    const maxVal = Math.max(d.seats, ...d.scenarios.map((x) => x.wants), 1);
    const step = niceStep(maxVal * 1.08, 5);
    const yMax = Math.ceil((maxVal * 1.08) / step) * step;
    const y = (v: number) => m.top + PLOT_H - (Math.max(0, v) / yMax) * PLOT_H;
    const n = d.scenarios.length;
    const band = plotW / n;
    const barW = Math.min(BAR_MAX, band * 0.6);

    const svg = s('svg', {
      viewBox: `0 0 ${W} ${H}`,
      width: W,
      height: H,
      role: 'group',
      'aria-label': t('c.aria', { n, price: fmtPrice(d.price), seats: fmtInt(d.seats) }),
    });

    // Сетка и подписи оси Y
    for (let v = 0; v <= yMax + 1e-9; v += step) {
      const yy = Math.round(y(v)) + 0.5;
      svg.append(s('line', { class: v === 0 ? 'axis' : 'grid', x1: m.left, x2: m.left + plotW, y1: yy, y2: yy }));
      svg.append(
        s('text', { class: 'tick-y', x: m.left - 10, y: yy + 4, 'text-anchor': 'end' }, fmtInt(v)),
      );
    }

    // Столбцы
    const cols: SVGGElement[] = [];
    d.scenarios.forEach((sc, i) => {
      const cx = m.left + band * i + band / 2;
      const x = cx - barW / 2;
      const isMedian = sc.q === 0.5;
      const g = s('g', { class: 'col' + (isMedian ? ' col--median' : '') });

      g.append(s('rect', { class: 'hit-bg', x: m.left + band * i + 1, y: m.top, width: band - 2, height: PLOT_H, rx: 4 }));

      const base = y(0);
      const soldTop = y(sc.sales);
      const soldH = base - soldTop;
      const hasOver = sc.overflow > 0;
      if (soldH > 0.5) {
        g.append(
          s('path', {
            class: 'bar-sold',
            d: hasOver ? `M${x},${base} V${soldTop} H${x + barW} V${base} Z` : topRoundedRect(x, soldTop, barW, soldH, R),
          }),
        );
      }
      if (hasOver) {
        const overTop = y(sc.wants);
        const overBottom = soldTop - GAP;
        const overH = overBottom - overTop;
        if (overH > 0.5) g.append(s('path', { class: 'bar-over', d: topRoundedRect(x, overTop, barW, overH, R) }));
      }

      // Подпись медианы — единственное число на графике (остальные — в подсказке и таблице).
      if (isMedian) {
        const top = y(Math.max(sc.wants, 0));
        g.append(
          s('text', { class: 'value-label', x: cx, y: top - 18, 'text-anchor': 'middle' }, fmtNum(sc.wants)),
          s('text', { class: 'value-label-sub', x: cx, y: top - 5, 'text-anchor': 'middle' }, t('c.wantsLabel')),
        );
      }

      g.append(
        s(
          'text',
          { class: 'tick-x' + (isMedian ? ' tick-x--median' : ''), x: cx, y: m.top + PLOT_H + 20, 'text-anchor': 'middle' },
          quantileLabel(sc.q),
        ),
      );

      const ring = s('rect', { class: 'hit-ring', x: m.left + band * i + 1, y: m.top, width: band - 2, height: PLOT_H, rx: 4 });
      g.append(ring);
      const hit = s('rect', {
        class: 'hit',
        x: m.left + band * i,
        y: m.top,
        width: band,
        height: PLOT_H + 28,
        tabindex: 0,
        role: 'img',
        'aria-label': this.describe(sc, d.seats),
        'data-q': sc.q,
      });
      hit.addEventListener('pointerenter', (event) => {
        if (event.pointerType !== 'touch') this.activate(i);
      });
      hit.addEventListener('pointermove', (event) => {
        if (event.pointerType !== 'touch') this.activate(i);
      });
      hit.addEventListener('pointerleave', (event) => {
        if (event.pointerType !== 'touch' && !this.isTouchActive) this.activate(null);
      });
      hit.addEventListener('focus', () => {
        g.classList.add('is-focus');
        this.activate(i);
      });
      hit.addEventListener('blur', () => {
        g.classList.remove('is-focus');
        if (!this.isTouchActive) this.activate(null);
      });
      hit.addEventListener('keydown', (e) => {
        const ke = e as KeyboardEvent;
        const next = ke.key === 'ArrowRight' ? i + 1 : ke.key === 'ArrowLeft' ? i - 1 : null;
        if (next !== null && next >= 0 && next < n) {
          e.preventDefault();
          (cols[next]?.querySelector('.hit') as SVGElement | null)?.focus();
        }
      });
      g.append(hit);
      svg.append(g);
      cols.push(g);
    });

    // Линия числа мест поверх столбцов
    const ys = Math.round(y(d.seats)) + 0.5;
    svg.append(s('line', { class: 'seats-line', x1: m.left, x2: m.left + plotW + 6, y1: ys, y2: ys }));
    const label = t('c.seats', { n: fmtInt(d.seats), raw: d.seats });
    svg.append(
      s('rect', { class: 'seats-label-bg', x: m.left + plotW + 8, y: ys - 9, width: m.right - 10, height: 18, rx: 3 }),
      s('text', { class: 'seats-label', x: m.left + plotW + 12, y: ys + 4 }, label),
    );

    // Подпись оси X
    const axisY = m.top + PLOT_H + 44;
    svg.append(
      s('text', { x: m.left, y: axisY, 'text-anchor': 'start' }, compact ? t('c.pessShort') : t('c.pess')),
      s('text', { x: m.left + plotW, y: axisY, 'text-anchor': 'end' }, compact ? t('c.optShort') : t('c.opt')),
    );

    this.root.append(svg, this.tooltip);
    this.root.dataset.cols = String(n);
    this.cols = cols;
    this.geom = { m, band, yMax };
    if (this.activeIndex !== null) this.activate(this.activeIndex, this.isTouchActive);
  }

  private cols: SVGGElement[] = [];
  private geom: { m: typeof M; band: number; yMax: number } | null = null;

  private describe(sc: ScenarioResult, seats: number): string {
    const pct = Math.round(sc.q * 100);
    let text = t('c.describe', { q: quantileLabel(sc.q), pct, n: fmtNum(sc.wants), sales: fmtNum(sc.sales) });
    if (sc.overflow > 0) text += t('c.describeOver', { n: fmtNum(sc.overflow) });
    else text += t('c.describeFree', { n: fmtNum(seats - sc.sales) });
    return text + '.';
  }

  /**
   * Открывает подсказку касанием столбца и закрывает её повторным касанием того же столбца.
   * @param index Обязательный целочисленный индекс существующего сценария от нуля.
   * @returns void. Обновляет выбранный сценарий, подсветку и подсказку через activate.
   * @remarks Ожидает построенный график. Ошибки отрисовки подсказки не перехватываются.
   */
  private toggleTouchTooltip(index: number): void {
    const isSameColumn = this.isTouchActive && this.activeIndex === index;
    this.activate(isSameColumn ? null : index, true);
  }

  /**
   * Обновляет подсветку столбца и показывает его подсказку в пределах графика.
   * @param i Индекс сценария от нуля или null для закрытия подсказки.
   * @param fromTouch Флаг выбора касанием. По умолчанию false для мыши и фокуса.
   * @returns void. При отсутствии сценария или геометрии скрывает подсказку.
   * @remarks Меняет состояние графика, классы столбцов, содержимое и положение
   * подсказки. Использует построенный SVG для измерений. Ошибки DOM не перехватываются.
   */
  private activate(i: number | null, fromTouch = false): void {
    const d = this.data;
    const sc = i === null ? undefined : d?.scenarios[i];
    this.activeIndex = sc ? i : null;
    this.isTouchActive = this.activeIndex !== null && fromTouch;
    this.cols.forEach((c, idx) => c.classList.toggle('is-active', idx === this.activeIndex));
    if (i === null || !sc || !d || !this.geom) {
      this.tooltip.hidden = true;
      return;
    }
    const { m, band, yMax } = this.geom;
    const svg = this.root.querySelector('svg');
    const scale = svg ? svg.getBoundingClientRect().width / Math.max(320, this.width) : 1;
    const cx = (m.left + band * i + band / 2) * scale;
    const topVal = Math.max(sc.wants, 0);
    const barTop = m.top + PLOT_H - (topVal / yMax) * PLOT_H;

    clear(this.tooltip);
    const pct = Math.round(sc.q * 100);
    const row = (key: string, label: string, value: string) =>
      h('div', { class: 'tooltip__row' }, h('span', { class: `tooltip__key tooltip__key--${key}` }), h('span', null, label), h('strong', null, value));
    this.tooltip.append(
      h('div', { class: 'tooltip__title' }, t('c.tipTitle', { q: quantileLabel(sc.q), pct, n: fmtNum(sc.wants) })),
      row('none', t('c.tipWants'), fmtNum(sc.wants)),
      row('sold', t('c.tipBuy'), fmtNum(sc.sales)),
      sc.overflow > 0
        ? row('over', t('c.tipOver'), fmtNum(sc.overflow))
        : row('none', t('c.tipFree'), fmtNum(d.seats - sc.sales)),
    );
    this.tooltip.hidden = false;
    // Подсказка сбоку от столбца, чтобы не закрывать его; у правого края — слева.
    const tipW = this.tooltip.offsetWidth || 220;
    const tipH = this.tooltip.offsetHeight || 90;
    const rootW = this.root.clientWidth;
    const half = (band / 2) * scale;
    let left = cx + half + 6;
    if (left + tipW > rootW - 4) left = cx - half - 6 - tipW;
    left = Math.max(4, left);
    const chartH = (m.top + PLOT_H) * scale;
    const top = Math.min(Math.max(barTop * scale - 10, 4), chartH - tipH);
    this.tooltip.style.left = `${left}px`;
    this.tooltip.style.top = `${Math.max(0, top)}px`;
  }
}
