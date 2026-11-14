import { lang, locale, ruPlural, t } from './i18n';

const cache = new Map<string, Intl.NumberFormat>();
function nf(digits: number): Intl.NumberFormat {
  const key = `${locale()}|${digits}`;
  let f = cache.get(key);
  if (!f) {
    f = new Intl.NumberFormat(locale(), { maximumFractionDigits: digits });
    cache.set(key, f);
  }
  return f;
}

export const fmtInt = (x: number) => nf(0).format(x);
/** До одного знака после запятой: 704,5 или 634. */
export const fmtNum = (x: number) => nf(1).format(x);
export const fmtPrice = (x: number) => `${nf(2).format(x)} ₽`;
export const fmtPct = (x: number) =>
  lang() === 'en' ? `${fmtInt(Math.round(x * 100))}%` : `${fmtInt(Math.round(x * 100))} %`;

/** Деньги крупно: 6 345 000 ₽ → «6,35 млн ₽». */
export function fmtMoneyShort(x: number): string {
  const abs = Math.abs(x);
  if (abs >= 1e6) return `${nf(2).format(x / 1e6)} ${lang() === 'en' ? 'M' : 'млн'} ₽`;
  if (abs >= 1e4) return `${nf(0).format(x / 1e3)} ${lang() === 'en' ? 'k' : 'тыс.'} ₽`;
  return fmtPrice(Math.round(x));
}

const MONTHS_RU = ['января', 'февраля', 'марта', 'апреля', 'мая', 'июня', 'июля', 'августа', 'сентября', 'октября', 'ноября', 'декабря'];
const MONTHS_RU_NOM = ['Январь', 'Февраль', 'Март', 'Апрель', 'Май', 'Июнь', 'Июль', 'Август', 'Сентябрь', 'Октябрь', 'Ноябрь', 'Декабрь'];
const MONTHS_EN = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const WD_RU = ['вс', 'пн', 'вт', 'ср', 'чт', 'пт', 'сб'];
const WD_EN = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

export function parseIso(iso: string): Date {
  const [y, m, d] = iso.split('-').map(Number) as [number, number, number];
  return new Date(Date.UTC(y, m - 1, d));
}

export function fmtDateLong(iso: string): string {
  const d = parseIso(iso);
  if (lang() === 'en') return `${WD_EN[d.getUTCDay()]}, ${d.getUTCDate()} ${MONTHS_EN[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
  return `${WD_RU[d.getUTCDay()]}, ${d.getUTCDate()} ${MONTHS_RU[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
}

export function fmtMonth(year: number, month: number): string {
  return lang() === 'en' ? `${MONTHS_EN[month]} ${year}` : `${MONTHS_RU_NOM[month]} ${year}`;
}

export function fmtDateShort(iso: string): string {
  const [y, m, d] = iso.split('-');
  return lang() === 'en' ? `${d}/${m}/${y}` : `${d}.${m}.${y}`;
}

export function fmtDayMonth(iso: string): string {
  const d = parseIso(iso);
  return lang() === 'en'
    ? `${d.getUTCDate()} ${MONTHS_EN[d.getUTCMonth()]!.slice(0, 3)}`
    : `${d.getUTCDate()} ${MONTHS_RU[d.getUTCMonth()]}`;
}

export function fmtDateTime(isoTs: string): string {
  const d = new Date(isoTs);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleString(locale(), { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
}

export function tickets(n: number): string {
  return `${fmtInt(n)} ${t('r.tickets', { n })}`;
}

export { ruPlural };

export function quantileLabel(q: number): string {
  return `P${Math.round(q * 100)}`;
}
