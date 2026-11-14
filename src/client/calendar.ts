/**
 * Календарь загрузки по дням (дополнение 2).
 * Одна бирюзовая шкала от светлого к тёмному (проверена на различимость),
 * в каждой клетке подписан процент — цвет не единственный носитель смысла.
 */
import type { DaySummary } from '../shared/forecast';
import { h } from './dom';
import { fmtDateLong, fmtInt, fmtMonth, fmtNum, fmtPct, parseIso } from './format';
import { t } from './i18n';

export const LOAD_STEPS = [0.5, 0.7, 0.85, 0.95];

export function loadStep(load: number): number {
  let i = 0;
  while (i < LOAD_STEPS.length && load >= LOAD_STEPS[i]!) i++;
  return i + 1; // 1..5
}

export function renderCalendar(days: DaySummary[], selected: string, onPick: (date: string) => void): HTMLElement {
  const byMonth = new Map<string, DaySummary[]>();
  for (const d of days) {
    const key = d.date.slice(0, 7);
    const list = byMonth.get(key) ?? [];
    list.push(d);
    byMonth.set(key, list);
  }
  const weekdays = t('cal.weekdays').split(',');
  const months = h('div', { class: 'cal', 'data-testid': 'calendar' });

  for (const [key, list] of byMonth) {
    const [y, m] = key.split('-').map(Number) as [number, number];
    const grid = h('div', { class: 'cal__grid', role: 'grid', 'aria-label': fmtMonth(y, m - 1) });
    const head = h('div', { class: 'cal__row cal__row--head', role: 'row' });
    for (const w of weekdays) head.append(h('span', { class: 'cal__wd', role: 'columnheader' }, w));
    grid.append(head);

    const byDay = new Map(list.map((d) => [parseIso(d.date).getUTCDate(), d]));
    const first = new Date(Date.UTC(y, m - 1, 1));
    const daysInMonth = new Date(Date.UTC(y, m, 0)).getUTCDate();
    const offset = (first.getUTCDay() + 6) % 7; // понедельник — первый
    let row = h('div', { class: 'cal__row', role: 'row' });
    let rowHasData = false;
    // Недели без единого дня прогноза не показываем (например, июль, где есть только 1-е число).
    const pushRow = () => {
      if (rowHasData) grid.append(row);
      row = h('div', { class: 'cal__row', role: 'row' });
      rowHasData = false;
    };
    for (let i = 0; i < offset; i++) row.append(h('span', { class: 'cal__cell cal__cell--empty', role: 'gridcell' }));
    for (let day = 1; day <= daysInMonth; day++) {
      const d = byDay.get(day);
      if (!d) {
        row.append(h('span', { class: 'cal__cell cal__cell--none', role: 'gridcell' }, h('span', { class: 'cal__day' }, String(day))));
      } else {
        const step = loadStep(d.loadFactor);
        const full = d.wants >= d.seats;
        const btn = h(
          'button',
          {
            type: 'button',
            class: `cal__cell cal__cell--s${step}` + (d.date === selected ? ' is-selected' : '') + (full ? ' is-full' : ''),
            role: 'gridcell',
            'aria-selected': String(d.date === selected),
            'data-date': d.date,
          },
          h('span', { class: 'cal__day' }, String(day)),
          h('span', { class: 'cal__val' }, fmtPct(d.loadFactor)),
          h('span', { class: 'sr-only' }, `, ${t('cal.day', { date: fmtDateLong(d.date), load: fmtPct(d.loadFactor), sales: fmtNum(d.sales), seats: fmtInt(d.seats) })}`),
          full ? h('span', { class: 'cal__full', 'aria-hidden': 'true' }) : null,
        );
        btn.addEventListener('click', () => onPick(d.date));
        row.append(btn);
        rowHasData = true;
      }
      if ((offset + day) % 7 === 0 && day !== daysInMonth) pushRow();
    }
    pushRow();
    months.append(h('div', { class: 'cal__month' }, h('div', { class: 'cal__title' }, fmtMonth(y, m - 1)), grid));
  }

  // Клавиатура: стрелки двигают фокус по дням.
  months.addEventListener('keydown', (e) => {
    const target = e.target as HTMLElement;
    if (!target.matches('button.cal__cell')) return;
    const buttons = [...months.querySelectorAll<HTMLButtonElement>('button.cal__cell')];
    const i = buttons.indexOf(target as HTMLButtonElement);
    const delta = e.key === 'ArrowRight' ? 1 : e.key === 'ArrowLeft' ? -1 : e.key === 'ArrowDown' ? 7 : e.key === 'ArrowUp' ? -7 : 0;
    if (!delta) return;
    const next = buttons[i + delta];
    if (next) {
      e.preventDefault();
      next.focus();
    }
  });

  const labels = ['< 50 %', '50–70 %', '70–85 %', '85–95 %', '≥ 95 %'];
  const legend = h(
    'div',
    { class: 'cal__legend' },
    h('span', { class: 'label' }, t('cal.legend')),
    h('span', { class: 'cal__scale' }, ...labels.map((l, i) => h('span', { class: `cal__swatch cal__cell--s${i + 1}` }, l))),
    h('span', { class: 'cal__legend-full' }, h('span', { class: 'cal__full cal__full--legend', 'aria-hidden': 'true' }), t('cal.full')),
  );
  return h('div', null, months, legend);
}
