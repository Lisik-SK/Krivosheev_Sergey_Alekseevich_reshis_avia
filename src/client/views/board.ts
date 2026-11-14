/**
 * Табло вылетов (дополнение 3) и схема направлений (дополнение 8):
 * все направления на одну дату. Клик по строке или дуге открывает расчёт рейса.
 */
import { api, ApiError, type BoardFlight, type BoardResponse } from '../api';
import { matchesDataVersion, watchDataUpdates } from '../data-updates';
import { h, icon } from '../dom';
import { mountDatePicker } from '../controls/date-picker';
import { fmtDateShort, fmtInt, fmtMoneyShort, fmtNum, fmtPct, fmtPrice } from '../format';
import { cityName, t, type Key } from '../i18n';
import { RouteMap } from '../map';
import type { BoardScreenState, ScreenStateAccess } from './screen-state';
import type { AppCtx } from './shell';

const STATUS_ICON: Record<BoardFlight['status'], string> = {
  available: 'check',
  filling: 'info',
  almost: 'alert',
  full: 'alert',
};

/**
 * Записывает параметры показанного табло в текущую запись истории.
 * @param date Обязательная дата YYYY-MM-DD или пустая строка при отсутствии рейсов.
 * @param mode Обязательный режим: base для базовой цены, model для цены модели.
 * @returns void. Заменяет адрес без новой записи и запросов; ошибки истории распространяются.
 */
function writeBoardQuery(date: string, mode: BoardScreenState['mode']): void {
  history.replaceState(history.state, '', `/board?${new URLSearchParams({ date, mode }).toString()}`);
}

/**
 * Создаёт табло с календарём, затем загружает первый набор рейсов.
 * @param ctx Обязательный AppCtx: signal отменяет запрос и освобождает карту и календарь,
 * navigate открывает рейс, onLogout обрабатывает истечение сессии.
 * @param setMain Обязательный callback (HTMLElement) => void; подключает страницу к DOM перед созданием календаря.
 * @param state Обязательный доступ к снимку навигации; восстанавливает выбранную дату, режим и последний ответ,
 * регистрирует чтение текущего состояния перед уходом.
 * @returns Promise<void> после первой загрузки; последующие запускают обработчики контролов.
 * @remarks Читает снимок или URL, строит DOM и карту, подключает календарь и обработчики,
 * показывает сохранённый ответ при возврате, если он ещё доступен, и запрашивает актуальные данные API.
 * Проверяет метаданные на видимой вкладке и перечитывает табло при обновлении.
 * Повторяет запрос при возвращении на вкладку или восстановлении сети.
 * Список дат из ответа ограничивает ручной ввод и выбор в календаре; стрелки используют тот же список.
 * Меняет DOM и URL; новый запрос отменяет предыдущий, выход отменяет текущий запрос,
 * удаляет календарь и прекращает наблюдение за шириной таблицы.
 * Ошибки запроса показываются в форме, отмена игнорируется, 401 завершает сессию.
 * Ошибки инициализации/callback отклоняют Promise без повторов и отката частичных изменений.
 */
export async function renderBoard(ctx: AppCtx, setMain: (main: HTMLElement) => void, state: ScreenStateAccess<BoardScreenState>) {
  const params = new URLSearchParams(location.search);
  let date = state.restored?.date ?? params.get('date') ?? '';
  let mode = state.restored?.mode ?? (params.get('mode') === 'model' ? 'model' : 'base');
  let last = state.restored?.result ?? null;
  let dates: readonly string[] = last?.dates ?? [];

  const dateInput = h('input', {
    type: 'date', class: 'input input--mono', id: 'b-date', 'data-testid': 'board-date',
    disabled: true, required: true, 'aria-describedby': 'b-date-error',
  });
  const dateError = h('div', { class: 'field__error', id: 'b-date-error', hidden: true });
  const modeBase = h('button', { type: 'button', class: 'seg__btn', 'data-testid': 'mode-base' }, t('b.modeBase'));
  const modeModel = h('button', { type: 'button', class: 'seg__btn', 'data-testid': 'mode-model' }, t('b.modeModel'));
  const prev = h('button', { type: 'button', class: 'icon-btn', 'aria-label': t('q.prevDay'), disabled: true }, icon('chevronLeft'));
  const next = h('button', { type: 'button', class: 'icon-btn', 'aria-label': t('q.nextDay'), disabled: true }, icon('chevronRight'));
  const boardSlot = h('div', { class: 'board-wrap', 'data-testid': 'board' });
  const tableWrap = h('div', { class: 'table-wrap board-scroll', role: 'region', 'aria-label': t('t.scrollable') });
  const tableObserver = new ResizeObserver(syncTableFocus);
  ctx.signal.addEventListener('abort', () => tableObserver.disconnect(), { once: true });
  const totals = h('p', { class: 'board__totals', 'data-testid': 'board-totals' });
  const errorSlot = h('div');
  const map = new RouteMap((f) => openFlight(f));
  ctx.signal.addEventListener('abort', () => map.destroy());

  const page = h(
    'main',
    { class: 'page', id: 'main' },
    h('div', { class: 'page__head' }, h('div', null, h('h1', { class: 'page__title' }, t('b.title')), h('p', { class: 'page__lead' }, t('b.lead')))),
    h(
      'div',
      { class: 'stack' },
      h(
        'div',
        { class: 'card board-controls' },
        h(
          'div',
          { class: 'field board-controls__date' },
          h('label', { class: 'label', for: 'b-date' }, t('b.date')),
          h('div', { class: 'query__date' }, prev, dateInput, next),
          dateError,
        ),
        h('div', { class: 'field' }, h('span', { class: 'label', id: 'b-mode' }, t('b.priceMode')), h('div', { class: 'seg', role: 'group', 'aria-labelledby': 'b-mode' }, modeBase, modeModel)),
      ),
      errorSlot,
      h('section', { class: 'card board-card', 'aria-labelledby': 'board-title' }, h('h2', { class: 'sr-only', id: 'board-title' }, t('b.title')), boardSlot, totals),
      h(
        'section',
        { class: 'card', 'aria-labelledby': 'map-title' },
        h('div', { class: 'card__head' }, h('div', null, h('h2', { class: 'card__title', id: 'map-title' }, t('map.title')), h('p', { class: 'card__sub' }, t('map.sub')))),
        h('div', { class: 'card__body' }, map.root),
      ),
    ),
  );
  setMain(page);
  const datePicker = mountDatePicker(dateInput, () => dates, ctx.signal);

  /**
   * Открывает расчёт рейса, показанного в текущей таблице или на карте.
   * @param f Обязательный рейс из отрисованного ответа с маршрутом FROM-TO и ценой в рублях.
   * @returns void. Запускает переход в калькулятор с датой отрисованного ответа;
   * ошибки навигации распространяются.
   */
  function openFlight(f: BoardFlight) {
    const [from, to] = f.route.split('-');
    ctx.navigate(`/?${new URLSearchParams({ from: from!, to: to!, date: last?.date ?? '', price: String(f.price) }).toString()}`);
  }

  function syncMode() {
    modeBase.setAttribute('aria-pressed', String(mode === 'base'));
    modeModel.setAttribute('aria-pressed', String(mode === 'model'));
  }

  let inflight: AbortController | null = null;
  let checkingVersion = false;
  ctx.signal.addEventListener('abort', () => inflight?.abort(), { once: true });

  /**
   * Без аргументов загружает табло для текущей даты/режима; возвращает Promise<void>.
   * Отменяет предыдущий запрос, затем обновляет даты, календарь, URL, таблицу и карту.
   * Сохраняет ручной ввод и открытый месяц, если ответ не меняет состояние календаря.
   * Ошибочный ввод сохраняется, пока список дней не опустеет или пользователь не выберет дату.
   * Меняет DOM и историю браузера, выполняет запрос API. Отмена игнорируется, 401 завершает сессию,
   * прочие ошибки отображаются в форме; finally снимает загрузку только у актуального запроса.
   */
  async function load() {
    inflight?.abort();
    const ac = new AbortController();
    inflight = ac;
    boardSlot.classList.add('is-loading');
    try {
      const res = await api.board(date, mode, ac.signal);
      if (ac.signal.aborted) return;
      date = res.date ?? '';
      const datesChanged = dates.length !== res.dates.length || dates.some((day, index) => day !== res.dates[index]);
      dates = res.dates;
      dateInput.disabled = dates.length === 0;
      if (dateInput.disabled) setDateError('');
      if (dateError.hidden && (datesChanged || dateInput.value !== date)) {
        dateInput.value = date;
        datePicker.sync();
      }
      updateDayButtons();
      writeBoardQuery(date, mode);
      errorSlot.replaceChildren();
      last = res;
      renderTable(res);
      map.update(res.flights);
    } catch (err) {
      if (ac.signal.aborted || (err as Error).name === 'AbortError') return;
      if (err instanceof ApiError && err.status === 401) return ctx.onLogout(t('session.expired'));
      errorSlot.replaceChildren(h('div', { class: 'alert alert--error', role: 'alert' }, icon('alert'), h('p', null, err instanceof Error ? err.message : t('error.generic'))));
    } finally {
      if (inflight === ac) {
        inflight = null;
        boardSlot.classList.remove('is-loading');
      }
    }
  }

  /**
   * Сверяет отрисованный снимок с текущими метаданными. Аргументов нет.
   * @returns Promise<void> после проверки и возможной загрузки табло для выбранной даты и режима.
   * @remarks Не прерывает запрос пользователя и пропускает параллельные проверки.
   * После смены снимка или ошибки табло повторяет загрузку. При 401 завершает сеанс;
   * остальные сбои фоновой проверки оставляют таблицу до следующей попытки.
   */
  async function checkVersion(): Promise<void> {
    if (checkingVersion || inflight) return;
    checkingVersion = true;
    const displayed = last;
    try {
      const meta = await api.meta(ctx.signal);
      if (ctx.signal.aborted || inflight || displayed !== last) return;
      if (!displayed || !matchesDataVersion(displayed, meta.data) || errorSlot.hasChildNodes()) await load();
    } catch (err) {
      if (!ctx.signal.aborted && err instanceof ApiError && err.status === 401) ctx.onLogout(t('session.expired'));
    } finally {
      checkingVersion = false;
    }
  }

  /**
   * Включает остановку Tab только для таблицы с горизонтальной прокруткой.
   * Аргументов нет. Возвращает void. Измеряет контейнер и меняет tabindex;
   * текущий фокус не переносит, запросов не выполняет. Ошибки DOM распространяются.
   */
  function syncTableFocus(): void {
    tableWrap.tabIndex = tableWrap.scrollWidth > tableWrap.clientWidth ? 0 : -1;
  }

  /**
   * Показывает строки и итоги табло или сообщение об отсутствии рейсов.
   * @param res Обязательный ответ табло с датой и списком рейсов, который может быть пустым.
   * @returns void. Заменяет содержимое таблицы и обновляет итоги.
   * @remarks Переподключает наблюдение за шириной контейнера и новой таблицы после вставки в DOM.
   * При пустом ответе отключает наблюдение. Запросов не выполняет, ошибки DOM распространяются.
   */
  function renderTable(res: BoardResponse): void {
    tableObserver.disconnect();
    if (!res.date || !res.flights.length) {
      boardSlot.replaceChildren(h('p', { class: 'empty' }, t(res.date ? 'b.empty' : 'b.noFlights')));
      totals.textContent = '';
      return;
    }
    const tbody = h('tbody');
    for (const f of res.flights) {
      const status = h('span', { class: `board__status board__status--${f.status}` }, icon(STATUS_ICON[f.status]!), t(`b.st.${f.status}` as Key));
      const load = h('span', { class: 'board__load' }, h('span', { class: 'board__bar', 'aria-hidden': 'true' }, h('span', { class: 'board__bar-fill' })), fmtPct(f.loadFactor));
      (load.querySelector('.board__bar-fill') as HTMLElement).style.width = `${Math.min(100, f.loadFactor * 100).toFixed(1)}%`;
      const open = h('a', { href: '#', class: 'board__open', 'data-testid': 'board-open' }, t('b.open'));
      open.addEventListener('click', (e) => {
        e.preventDefault();
        openFlight(f);
      });
      const row = h(
        'tr',
        { 'data-route': f.route },
        h('td', { class: 'board__flight' }, h('span', { class: 'board__code' }, f.origin.code), h('span', { class: 'board__arrow', 'aria-hidden': 'true' }, '→'), h('span', { class: 'board__code' }, f.destination.code)),
        h('td', null, cityName(f.destination)),
        h('td', { class: 'num' }, fmtPrice(f.price)),
        h('td', { class: 'num' }, fmtInt(f.rounded.sales)),
        h('td', { class: 'num' }, fmtInt(f.seats)),
        h('td', { class: 'num' }, load),
        h('td', null, status),
        h('td', { class: 'num' }, open),
      );
      tbody.append(row);
    }
    const table = h(
      'table',
      { class: 'board', 'data-testid': 'board-table' },
      h('caption', { class: 'sr-only' }, `${t('b.title')}, ${fmtDateShort(res.date)}`),
      h(
        'thead',
        null,
        h(
          'tr',
          null,
          ...(['b.flight', 'b.dest', 'b.price', 'b.sales', 'b.seats', 'b.load', 'b.status'] as Key[]).map((k, i) =>
            h('th', { scope: 'col', class: i >= 2 && i <= 5 ? 'num' : '' }, t(k)),
          ),
          h('th', { scope: 'col' }, h('span', { class: 'sr-only' }, t('b.open'))),
        ),
      ),
      tbody,
    );
    tableWrap.replaceChildren(table);
    if (tableWrap.parentElement !== boardSlot) boardSlot.replaceChildren(tableWrap);
    syncTableFocus();
    tableObserver.observe(tableWrap);
    tableObserver.observe(table);
    const sum = res.flights.reduce((a, f) => ({ sales: a.sales + f.sales, seats: a.seats + f.seats, revenue: a.revenue + f.revenue }), { sales: 0, seats: 0, revenue: 0 });
    totals.textContent = t('b.total', { sales: fmtNum(sum.sales), seats: fmtInt(sum.seats), revenue: fmtMoneyShort(sum.revenue) });
  }

  /**
   * Показывает или очищает ошибку ввода даты.
   * @param message Обязательный локализованный текст; пустая строка снимает ошибку.
   * @returns void. Меняет сообщение и aria-invalid исходного поля; ошибки DOM распространяются.
   */
  function setDateError(message: string): void {
    dateError.textContent = message;
    dateError.hidden = message === '';
    if (message) dateInput.setAttribute('aria-invalid', 'true');
    else dateInput.removeAttribute('aria-invalid');
  }

  /**
   * Обновляет доступность стрелок по списку дней; вне списка отключает обе стрелки.
   * Аргументов нет; возвращает void. Меняет disabled кнопок; ошибки DOM распространяются.
   */
  function updateDayButtons(): void {
    const index = dates.indexOf(date);
    prev.disabled = index <= 0;
    next.disabled = index === -1 || index + 1 >= dates.length;
  }

  /**
   * Применяет ввод или выбор из календаря, если день присутствует в списке дат табло.
   * Аргументов нет; возвращает void. При ошибке показывает сообщение и сохраняет предыдущий выбор,
   * при смене даты обновляет стрелки и запускает загрузку. Повторный выбор той же даты
   * повторяет завершившийся ошибкой запрос; ошибки загрузки обрабатывает load.
   */
  function applyDateInput(): void {
    const selected = dateInput.value;
    if (!dates.includes(selected)) {
      setDateError(t(selected ? 'b.empty' : 'q.err.date'));
      return;
    }
    setDateError('');
    if (date === selected && (inflight || !errorSlot.hasChildNodes())) return;
    date = selected;
    updateDayButtons();
    void load();
  }

  /**
   * Выбирает соседний доступный день и синхронизирует поле перед загрузкой.
   * @param offset Обязательное направление: -1 назад, 1 вперёд.
   * @returns void. Если дата вне списка или соседнего дня нет, ничего не меняет. Ошибки DOM распространяются,
   * ошибки загрузки обрабатывает load; ранее введённая ошибка очищается при выборе.
   */
  function shift(offset: -1 | 1): void {
    const index = dates.indexOf(date);
    if (index === -1) return;
    const selected = dates[index + offset];
    if (!selected) return;
    dateInput.value = selected;
    applyDateInput();
    datePicker.sync();
  }

  dateInput.addEventListener('input', applyDateInput, { signal: ctx.signal });
  watchDataUpdates(ctx.signal, (resumed) => {
    if (resumed) void load();
    else void checkVersion();
  });
  prev.addEventListener('click', () => shift(-1));
  next.addEventListener('click', () => shift(1));
  modeBase.addEventListener('click', () => {
    mode = 'base';
    syncMode();
    void load();
  });
  modeModel.addEventListener('click', () => {
    mode = 'model';
    syncMode();
    void load();
  });
  syncMode();
  state.capture(() => ({ date, mode, result: last }));
  if (last) {
    dateInput.value = date;
    dateInput.disabled = dates.length === 0;
    datePicker.sync();
    updateDayButtons();
    if ((last.date ?? '') === date && last.priceMode === mode) {
      writeBoardQuery(date, mode);
      renderTable(last);
      map.update(last.flights);
    }
  }
  await load();
}
