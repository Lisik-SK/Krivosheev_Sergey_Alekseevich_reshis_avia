/** Строгий разбор и календарная арифметика дат без зависимости от часового пояса. */

/**
 * Преобразует ручной ввод даты в ISO без исправления несуществующих дней.
 * @param raw Обязательная строка: YYYY-MM-DD, DD.MM.YYYY, DD/MM/YYYY или восемь цифр DDMMYYYY;
 * внешние пробелы допустимы, числовой формат предназначен для мобильной клавиатуры без разделителей.
 * @returns ISO YYYY-MM-DD либо null для пустой строки, неверного формата, года вне 1…9999 или несуществующей даты.
 * @remarks Чистая функция; не меняет состояние, не выполняет ввод-вывод и не выбрасывает ожидаемых ошибок.
 */
export function parseDateInput(raw: string): string | null {
  const value = raw.trim();
  const iso = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  const local = /^(\d{1,2})([./])(\d{1,2})\2(\d{4})$/.exec(value);
  const digits = /^(\d{2})(\d{2})(\d{4})$/.exec(value);
  if (!iso && !local && !digits) return null;
  const year = Number(iso ? iso[1] : local ? local[4] : digits![3]);
  const month = Number(iso ? iso[2] : local ? local[3] : digits![2]);
  const day = Number(iso ? iso[3] : local ? local[1] : digits![1]);
  const date = new Date(0);
  date.setUTCFullYear(year, month - 1, day);
  if (year < 1 || year > 9999 || date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) return null;
  return `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

/**
 * Возвращает календарную дату UTC для корректной ISO-строки.
 * @param iso Обязательная дата YYYY-MM-DD; предусловие — успешный parseDateInput.
 * @returns Новый Date в полночь UTC; вызывающий код владеет объектом и может его изменять.
 * @remarks Не меняет внешнее состояние; для неверного аргумента результат не определён, исключения не перехватываются.
 */
export function dateAtUtc(iso: string): Date {
  const [year, month, day] = iso.split('-').map(Number) as [number, number, number];
  const date = new Date(0);
  date.setUTCFullYear(year, month - 1, day);
  return date;
}

/**
 * Сдвигает дату на целое число календарных дней.
 * @param iso Обязательная корректная дата YYYY-MM-DD.
 * @param days Обязательное целое смещение дней; отрицательное перемещает назад, ноль сохраняет дату.
 * @returns Новая ISO-дата либо пустая строка при выходе за годы 1…9999.
 * @remarks Чистая функция; не изменяет аргументы и внешнее состояние. Некорректные аргументы не поддерживаются.
 */
export function moveDate(iso: string, days: number): string {
  const date = dateAtUtc(iso);
  date.setUTCDate(date.getUTCDate() + days);
  return date.getUTCFullYear() < 1 || date.getUTCFullYear() > 9999 ? '' : date.toISOString().slice(0, 10);
}

/**
 * Перемещает дату между месяцами, ограничивая день последним числом целевого месяца.
 * @param iso Обязательная корректная дата YYYY-MM-DD.
 * @param months Обязательное целое смещение месяцев; отрицательное перемещает назад.
 * @returns Новая ISO-дата либо пустая строка при выходе за годы 1…9999.
 * @remarks Чистая функция без ввода-вывода; неверные аргументы не поддерживаются.
 */
export function moveMonth(iso: string, months: number): string {
  const date = dateAtUtc(iso);
  const day = date.getUTCDate();
  date.setUTCDate(1);
  date.setUTCMonth(date.getUTCMonth() + months);
  const end = new Date(date);
  end.setUTCMonth(end.getUTCMonth() + 1, 0);
  date.setUTCDate(Math.min(day, end.getUTCDate()));
  return date.getUTCFullYear() < 1 || date.getUTCFullYear() > 9999 ? '' : date.toISOString().slice(0, 10);
}
