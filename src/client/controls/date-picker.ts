/** Поле ручного ввода и календарь выбора даты, синхронизированные с исходным ISO-полем формы. */
import { h, icon, s } from '../dom';
import { fmtDateLong, fmtDateShort, fmtMonth } from '../format';
import { lang, t } from '../i18n';
import { dateAtUtc, moveDate, moveMonth, parseDateInput } from './date-utils';
import { createPickerPopup } from './picker-popup';

/**
 * Подключает оформленное поле даты к существующему input[type=date].
 * @param source Обязательное подключённое к DOM поле с уникальным id; сохраняет ISO value, name и тестовый идентификатор.
 * @param getDates Обязательная функция без аргументов, возвращающая доступные корректные ISO-даты; пустой массив запрещает выбор в календаре.
 * @param signal Обязательный сигнал времени жизни экрана; отмена снимает подписки и удаляет всплывающую панель.
 * @returns Контроллер синхронизации и проверки неразобранного ручного ввода.
 * @remarks Один вызов на source. Сначала создаёт видимые контролы и скрывает источник, затем
 * подключает панель и события. Выбор даты отправляет один bubbling input, ручной ввод сохраняет
 * текст и отправляет ISO либо пустую строку для штатной валидации. Восемь цифр DDMMYYYY позволяют
 * ввод без разделителей на мобильной клавиатуре; при потере фокуса корректный текст форматируется
 * по языку интерфейса без нового события. Не выполняет запросов или хранения.
 * Ошибки DOM/getDates передаются вызывающему коду без повторов и отката уже созданных контролов.
 */
export function mountDatePicker(source: HTMLInputElement, getDates: () => readonly string[], signal: AbortSignal): {
  /** Обновляет поле; preserveInvalidText оставляет неразобранный текст, по умолчанию false. Без результата; ошибки DOM распространяются. */
  sync(preserveInvalidText?: boolean): void;
  /** Возвращает true при непустом тексте, который не удалось разобрать. Без аргументов, записей и ожидаемых ошибок. */
  hasInvalidText(): boolean;
} {
  const display = h('input', {
    type: 'text', class: 'input input--mono date-field__input', id: `${source.id}-display`,
    'data-testid': `${source.dataset.testid}-display`, autocomplete: 'off', inputmode: 'numeric',
    placeholder: lang() === 'en' ? 'DD/MM/YYYY' : 'ДД.ММ.ГГГГ', maxlength: 10,
  });
  const calendarIcon = s('svg', { viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', 'stroke-width': 1.8, 'stroke-linecap': 'round', 'stroke-linejoin': 'round', 'aria-hidden': 'true' },
    s('rect', { x: 3, y: 5, width: 18, height: 16, rx: 2 }), s('path', { d: 'M16 3v4M8 3v4M3 11h18' }));
  const trigger = h('button', {
    type: 'button', class: 'icon-btn date-field__trigger', id: `${source.id}-trigger`,
    'data-testid': `${source.dataset.testid}-trigger`, 'aria-label': lang() === 'en' ? 'Choose date' : 'Выбрать дату',
    'aria-haspopup': 'dialog', 'aria-expanded': 'false',
  }, calendarIcon);
  const field = h('div', { class: 'picker-field date-field' });
  source.before(field);
  field.append(source, display, trigger);
  source.hidden = true;
  source.tabIndex = -1;
  source.setAttribute('aria-hidden', 'true');
  for (const label of Array.from(source.labels ?? [])) label.htmlFor = display.id;
  const popup = createPickerPopup(trigger, signal);
  popup.panel.id = `${source.id}-calendar`;
  popup.panel.classList.add('date-picker');
  popup.panel.setAttribute('role', 'dialog');
  popup.panel.setAttribute('aria-label', t('q.date'));
  trigger.setAttribute('aria-controls', popup.panel.id);
  let focusedDate = '';
  let shownMonth = '';
  let writing = false;

  /**
   * Читает доступные дни и применяет границы исходного поля.
   * Аргументов нет; возвращает новый отсортированный массив уникальных ISO-дат.
   * Некорректные даты отбрасываются; ошибки getDates распространяются. Внешнее состояние не меняется.
   */
  function availableDates(): string[] {
    return [...new Set(getDates())].filter(date => parseDateInput(date) === date && (!source.min || date >= source.min) && (!source.max || date <= source.max)).sort();
  }

  /**
   * Переносит доступность и сообщения валидации на видимые контролы без замены введённого текста.
   * Аргументов нет; возвращает void. Меняет DOM, закрывает панель при блокировке поля; ошибок не перехватывает.
   */
  function syncState(): void {
    display.disabled = source.disabled;
    display.readOnly = source.readOnly;
    display.required = source.required;
    trigger.disabled = source.disabled || source.readOnly || availableDates().length === 0;
    for (const attribute of ['aria-invalid', 'aria-describedby'] as const) {
      const value = source.getAttribute(attribute);
      if (value === null) display.removeAttribute(attribute);
      else display.setAttribute(attribute, value);
    }
    if (trigger.disabled) popup.close(false);
  }

  /**
   * Переносит программно установленное ISO-значение и состояние source в интерфейс.
   * @param preserveInvalidText Если true, сохраняет неразобранный текст; по умолчанию false.
   * @returns void. Обновляет поле и открытую панель без событий и запросов.
   * Ошибки чтения дат и DOM распространяются.
   */
  function sync(preserveInvalidText = false): void {
    if (!preserveInvalidText || !hasInvalidText()) display.value = source.value ? fmtDateShort(source.value) : '';
    syncState();
    if (popup.isOpen()) openCalendar();
  }

  /** Проверяет наличие неразобранного ручного ввода. Без аргументов; возвращает boolean, читает DOM без записи и запросов. */
  function hasInvalidText(): boolean {
    return source.value === '' && display.value.trim() !== '';
  }

  /**
   * Принимает выбор существующего доступного дня.
   * @param date Обязательная ISO-дата; недоступная дата или заблокированное поле игнорируются.
   * @returns void. Меняет source, видимый текст, фокус и отправляет ровно один bubbling input.
   * @remarks Закрывает панель перед отправкой события; исключения DOM/данных не перехватываются.
   */
  function choose(date: string): void {
    if (source.disabled || source.readOnly || !availableDates().includes(date)) return;
    source.value = date;
    popup.close(false);
    sync();
    display.focus({ preventScroll: true });
    writing = true;
    try { source.dispatchEvent(new Event('input', { bubbles: true })); }
    finally { writing = false; }
  }

  /**
   * Переносит фокус на доступный день, при необходимости меняя отображаемый месяц.
   * @param date Обязательная доступная ISO-дата; отсутствующая в данных дата игнорируется.
   * @returns void. Перестраивает календарь и фокусирует кнопку без выбора значения; ошибки распространяются.
   */
  function focusDate(date: string): void {
    if (!availableDates().includes(date)) return;
    focusedDate = date;
    shownMonth = date.slice(0, 7);
    renderMonth();
    popup.panel.querySelector<HTMLButtonElement>(`[data-date="${date}"]`)?.focus({ preventScroll: true });
  }

  /**
   * Переключает на соседний месяц, содержащий доступные даты.
   * @param delta Обязательное направление -1 или 1; другие значения не предусмотрены.
   * @returns void. Меняет календарь и фокус; на краю диапазона ничего не делает. Ошибки данных/DOM распространяются.
   */
  function changeMonth(delta: -1 | 1): void {
    const months = [...new Set(availableDates().map(date => date.slice(0, 7)))];
    const next = months[months.indexOf(shownMonth) + delta];
    const date = next && availableDates().find(value => value.startsWith(next));
    if (date) focusDate(date);
  }

  /**
   * Строит один месяц, выбранное состояние и навигацию без обращения к серверу.
   * Аргументов нет; возвращает void. Требует shownMonth YYYY-MM и доступные даты.
   * Заменяет дочерние узлы панели; фокус переносит вызывающий метод. Ошибки DOM/данных распространяются.
   */
  function renderMonth(): void {
    const dates = availableDates();
    const allowed = new Set(dates);
    const months = [...new Set(dates.map(date => date.slice(0, 7)))];
    const monthIndex = months.indexOf(shownMonth);
    const first = dateAtUtc(`${shownMonth}-01`);
    const year = first.getUTCFullYear();
    const month = first.getUTCMonth();
    const prev = h('button', { type: 'button', class: 'icon-btn', 'data-testid': 'date-prev-month', disabled: monthIndex <= 0, 'aria-label': lang() === 'en' ? 'Previous month' : 'Предыдущий месяц' }, icon('chevronLeft'));
    const next = h('button', { type: 'button', class: 'icon-btn', 'data-testid': 'date-next-month', disabled: monthIndex < 0 || monthIndex >= months.length - 1, 'aria-label': lang() === 'en' ? 'Next month' : 'Следующий месяц' }, icon('chevronRight'));
    prev.addEventListener('click', () => changeMonth(-1));
    next.addEventListener('click', () => changeMonth(1));
    const title = h('div', { class: 'date-picker__title', 'aria-live': 'polite' }, fmtMonth(year, month));
    const grid = h('div', { class: 'date-picker__grid', role: 'group', 'aria-label': fmtMonth(year, month) });
    for (const weekday of t('cal.weekdays').split(',')) grid.append(h('span', { class: 'date-picker__weekday', 'aria-hidden': 'true' }, weekday));
    const offset = (first.getUTCDay() + 6) % 7;
    for (let index = 0; index < offset; index++) grid.append(h('span', { class: 'date-picker__empty', 'aria-hidden': 'true' }));
    const end = dateAtUtc(`${shownMonth}-01`);
    end.setUTCMonth(end.getUTCMonth() + 1, 0);
    for (let day = 1; day <= end.getUTCDate(); day++) {
      const date = `${shownMonth}-${String(day).padStart(2, '0')}`;
      const selected = source.value === date;
      const button = h('button', {
        type: 'button', class: 'date-picker__day' + (selected ? ' is-selected' : ''),
        'data-date': date, disabled: !allowed.has(date), tabindex: date === focusedDate ? 0 : -1,
        'aria-label': fmtDateLong(date), 'aria-pressed': String(selected),
      }, String(day));
      button.addEventListener('click', () => choose(date));
      grid.append(button);
    }
    popup.panel.replaceChildren(h('div', { class: 'date-picker__head' }, prev, title, next), grid);
  }

  /**
   * Выбирает начальный день и открытый месяц по текущей дате или первому доступному дню.
   * Аргументов нет; возвращает void. При отсутствии дат закрывает панель; иначе строит её и переносит фокус.
   * Не меняет значение source. Ошибки чтения дат/DOM не перехватываются.
   */
  function openCalendar(): void {
    const dates = availableDates();
    const initial = dates.includes(source.value) ? source.value : dates[0];
    if (!initial || source.disabled || source.readOnly) { popup.close(false); return; }
    focusDate(initial);
  }

  /**
   * Обрабатывает календарную навигацию, сохраняя стандартные Enter/Space для выбора кнопки.
   * @param event Обязательное KeyboardEvent панели; стрелки перемещают на 1/7 дней,
   * Home/End — к краю недели, PageUp/PageDown — на месяц, пропуски обходятся по направлению.
   * @returns void. Для распознанной навигации отменяет стандартную прокрутку и переносит фокус.
   * @remarks Значение формы не меняет; на границе остаётся на текущем дне, ошибки DOM/дат распространяются.
   */
  function navigate(event: KeyboardEvent): void {
    const target = event.target;
    if (!(target instanceof HTMLElement) || !target.dataset.date || event.ctrlKey || event.metaKey || event.altKey) return;
    const current = target.dataset.date;
    const weekday = (dateAtUtc(current).getUTCDay() + 6) % 7;
    const offsets: Record<string, number> = { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -7, ArrowDown: 7, Home: -weekday, End: 6 - weekday };
    const offset = offsets[event.key];
    const next = offset !== undefined ? moveDate(current, offset) : event.key === 'PageUp' ? moveMonth(current, -1) : event.key === 'PageDown' ? moveMonth(current, 1) : null;
    if (next === null) return;
    event.preventDefault();
    const dates = availableDates();
    const forward = next >= current;
    const candidate = forward ? dates.find(date => date >= next) : dates.filter(date => date <= next).at(-1);
    if (candidate) focusDate(candidate);
  }

  /**
   * Передаёт ручной текст в штатную валидацию без переформатирования во время набора.
   * Аргументов нет; возвращает void. Некорректный ввод превращает source.value в пустую строку;
   * отправляет один bubbling input и сохраняет набранный текст. Ошибки DOM распространяются,
   * флаг собственной записи снимается даже при частичном отказе.
   */
  function editDate(): void {
    source.value = parseDateInput(display.value) ?? '';
    writing = true;
    try { source.dispatchEvent(new Event('input', { bubbles: true })); }
    finally { writing = false; }
  }

  /**
   * Форматирует завершённый корректный ввод после потери фокуса.
   * Аргументов нет; возвращает void. Меняет только текст видимого поля, не отправляет событий
   * и не меняет source; пустой или некорректный текст сохраняет для исправления.
   * Ошибки DOM не перехватываются; требуется доступный display.
   */
  function normalizeDisplay(): void {
    const parsed = parseDateInput(display.value);
    if (parsed) display.value = fmtDateShort(parsed);
  }

  /** Переносит внешнее input/change в интерфейс; без аргументов, возвращает void, собственные события игнорирует. Ошибки sync распространяются. */
  function syncExternal(): void { if (!writing) sync(); }

  trigger.addEventListener('click', () => popup.toggle(), { signal });
  display.addEventListener('input', editDate, { signal });
  display.addEventListener('blur', normalizeDisplay, { signal });
  display.addEventListener('keydown', event => {
    if (event.key === 'ArrowDown' && event.altKey) { event.preventDefault(); popup.open(); }
  }, { signal });
  source.addEventListener('input', syncExternal, { signal });
  source.addEventListener('change', syncExternal, { signal });
  popup.panel.addEventListener('pickeropen', openCalendar, { signal });
  popup.panel.addEventListener('keydown', navigate, { signal });
  const observer = new MutationObserver(syncState);
  observer.observe(source, { attributes: true, attributeFilter: ['disabled', 'readonly', 'required', 'min', 'max', 'aria-invalid', 'aria-describedby'] });
  signal.addEventListener('abort', () => observer.disconnect(), { once: true });
  sync();
  return { sync, hasInvalidText };
}
