import type { SellOutProbability } from '../../shared/forecast';
import { api, ApiError, type CurveResponse, type ForecastResponse, type Meta, type MonthResponse, type RouteMeta } from '../api';
import { renderCalendar } from '../calendar';
import { DemandChart } from '../chart';
import { ProfitCurveChart } from '../curve';
import { matchesDataVersion, watchDataUpdates } from '../data-updates';
import { mountDatePicker } from '../controls/date-picker';
import { flightCities, flightDates } from '../controls/flight-options';
import { mountSelectPicker } from '../controls/select-picker';
import { h, icon } from '../dom';
import {
  fmtDateShort,
  fmtInt,
  fmtMoneyShort,
  fmtNum,
  fmtPct,
  fmtPrice,
  quantileLabel,
  tickets,
} from '../format';
import { cityName, t, type Key } from '../i18n';
import type { FlightResult, FlightScreenState, ScreenStateAccess } from './screen-state';
import { toast, type AppCtx } from './shell';
import { warningDetails } from './warning-details';

/** Параметры основного расчёта; priceB равна null при выключенном сравнении. */
interface Query {
  from: string;
  to: string;
  date: string;
  price: string;
  priceB: string | null;
}

/** Цена и видимость поля сравнения в записи истории текущего пользователя. */
interface ComparisonState {
  price: string;
  enabled: boolean;
  userId: number;
}

/**
 * Читает параметры расчёта из адреса страницы.
 * Аргументов нет; возвращает новый объект с непустыми параметрами длиной до 40 символов.
 * Читает location, не меняет состояние и не выполняет запросов; ошибки чтения распространяются.
 */
function readUrlQuery(): Partial<Query> {
  const p = new URLSearchParams(location.search);
  const q: Partial<Query> = {};
  for (const k of ['from', 'to', 'date', 'price'] as const) {
    const v = p.get(k);
    if (v) q[k] = v.slice(0, 40);
  }
  const b = p.get('b');
  if (b) q.priceB = b.slice(0, 40);
  return q;
}

/**
 * Читает сохранённое поле сравнения для текущей записи истории.
 * @param userId Обязательный числовой идентификатор авторизованного пользователя.
 * @returns Цена и видимость поля либо undefined при отсутствии, неверном формате или другом владельце.
 * @remarks Читает history.state без записи и запросов; ошибки браузера распространяются.
 */
function readComparisonState(userId: number): ComparisonState | undefined {
  const saved = history.state?.flightComparison as Partial<ComparisonState> | undefined;
  if (saved?.userId !== userId || typeof saved.price !== 'string' || typeof saved.enabled !== 'boolean') return;
  return { price: saved.price, enabled: saved.enabled, userId };
}

/**
 * Обновляет адрес и сохраняет состояние сравнения в текущей записи истории.
 * @param q Текущие параметры формы; пустые значения и null исключаются из адреса.
 * @param comparison Обязательное состояние поля второй цены независимо от его видимости.
 * @returns void. Заменяет адрес и состояние записи при изменении без навигации и запросов.
 * При временном отказе браузера принять запись оставляет текущую запись и даёт форме продолжить работу.
 * Остальные ошибки History API распространяются.
 */
function writeUrlQuery(q: Query, comparison: ComparisonState): void {
  const params = new URLSearchParams();
  for (const key of ['from', 'to', 'date', 'price'] as const) {
    if (q[key]) params.set(key, q[key]);
  }
  if (q.priceB) params.set('b', q.priceB);
  const search = params.toString();
  const path = search ? `/?${search}` : '/';
  const previous = readComparisonState(comparison.userId);
  if (location.pathname + location.search + location.hash === path
    && previous?.price === comparison.price && previous.enabled === comparison.enabled) return;
  try {
    history.replaceState({ ...history.state, flightComparison: comparison }, '', path);
  } catch (error) {
    if (!(error instanceof DOMException) || error.name !== 'SecurityError') throw error;
  }
}

function stripDot(s: string) {
  return s.replace(/[.\s]+$/, '');
}

function dataUpdateNotice(before: Meta['data']['source'], after: Meta['data']['source']): Key {
  if (!before || !after) return 'toast.dataUpdated';

  const fileChanged = (kind: 'forecast' | 'routes') => {
    const previous = before[kind];
    const current = after[kind];
    return previous.name !== current.name || previous.size !== current.size || previous.modifiedAt !== current.modifiedAt;
  };
  const forecastChanged = fileChanged('forecast');
  const routesChanged = fileChanged('routes');
  if (forecastChanged === routesChanged) return 'toast.dataUpdated';
  return routesChanged ? 'toast.routesUpdated' : 'toast.newData';
}

/** Текст и уровень риска распродажи с учётом того, точная это оценка или граница. */
export function sellOutView(sell: SellOutProbability): { text: string; high: boolean } {
  const text =
    sell.bound === 'atLeast' ? `≥ ${fmtPct(sell.value)}` : sell.bound === 'atMost' ? `< ${fmtPct(sell.value)}` : `≈ ${fmtPct(sell.value)}`;
  const high = sell.bound === 'atMost' ? sell.value > 0.5 : sell.value >= 0.5;
  return { text, high };
}

/**
 * Загружает справочник и создаёт форму прогноза с оформленными полями и графиками.
 * @param ctx Обязательный AppCtx авторизованного экрана; signal управляет жизненным циклом,
 * history сохраняет расчёты, onLogout завершает сессию при 401.
 * @param setMain Обязательный callback (HTMLElement) => void, подключающий основной блок к DOM до создания picker.
 * @param state Обязательный доступ к снимку навигации: читает сохранённое состояние при возврате
 * из шапки и регистрирует чтение актуальных полей и последнего результата перед уходом.
 * @returns Promise<void> после подключения формы и показа сохранённого результата
 * или обработки текущего выбора. Новый расчёт запускает только для полной допустимой формы и не ждёт его завершения.
 * @remarks Берёт метаданные из снимка или загружает их, затем строит DOM/контролы, связывает события,
 * восстанавливает поля из снимка, записи истории браузера или URL. При чистом входе поля пусты.
 * Состояние сравнения
 * переживает обновление страницы в той же записи. Показывает сохранённый расчёт при совпадении маршрута,
 * даты и версии данных; проверяет свежесть метаданных в фоне, если экран восстановлен.
 * Запускает расчёт, если его нет или изменились цены. Ошибка первичной загрузки метаданных отображается вместо формы,
 * отмена прекращает работу; ошибки инициализации DOM/callback отклоняют Promise без отката.
 * Меняет DOM, URL, фокус, прокрутку; запросы расчёта и сохранение истории выполняются далее
 * обработчиками. AbortSignal отменяет запросы, таймеры, наблюдатели и удаляет внешние панели.
 */
export async function renderCalculator(ctx: AppCtx, setMain: (main: HTMLElement) => void, state: ScreenStateAccess<FlightScreenState>) {
  let meta: Meta;
  try {
    meta = state.restored?.meta ?? await api.meta(ctx.signal);
  } catch (err) {
    if ((err as Error).name === 'AbortError') return;
    if (err instanceof ApiError && err.status === 401) return ctx.onLogout();
    setMain(
      h('main', { class: 'page', id: 'main' }, h('div', { class: 'card' }, h('div', { class: 'empty' }, icon('alert', 'empty__icon'), h('p', null, err instanceof Error ? err.message : t('error.generic'))))),
    );
    return;
  }
  if (ctx.signal.aborted) return;

  // ---------- элементы формы ----------
  const fromSel = h('select', { class: 'select', id: 'q-from', name: 'from', 'data-testid': 'from' });
  const toSel = h('select', { class: 'select', id: 'q-to', name: 'to', 'data-testid': 'to', 'aria-describedby': 'err-to' });
  const clearFields = h('button', { type: 'button', class: 'btn btn--link query__clear' }, t('q.clear'));
  const forwardArrow = icon('arrowRight');
  const swapRoute = h(
    'button',
    { type: 'button', class: 'icon-btn query__swap', 'aria-label': t('q.swapRoute'), title: t('q.swapRoute'), 'data-testid': 'swap-route', hidden: true },
    icon('swapRoute'),
  );
  const routeArrow = h('div', { class: 'query__arrow' }, forwardArrow, swapRoute);
  const dateInput = h('input', { class: 'input input--mono', id: 'q-date', name: 'date', type: 'date', required: true, 'data-testid': 'date', 'aria-describedby': 'err-date' });
  const prevDay = h('button', { type: 'button', class: 'icon-btn', 'aria-label': t('q.prevDay') }, icon('chevronLeft'));
  const nextDay = h('button', { type: 'button', class: 'icon-btn', 'aria-label': t('q.nextDay') }, icon('chevronRight'));
  const priceAttrs = { class: 'input input--mono', type: 'number', inputmode: 'decimal', min: 0, step: 'any' };
  const priceInput = h('input', { ...priceAttrs, id: 'q-price', name: 'price', required: true, 'data-testid': 'price', 'aria-describedby': 'err-price' });
  const priceBInput = h('input', { ...priceAttrs, id: 'q-price-b', name: 'priceB', 'data-testid': 'price-b', 'aria-describedby': 'err-price-b' });
  const priceLabel = h('label', { class: 'label', id: 'q-price-label', for: 'q-price' }, t('q.price'));
  const sliderAttrs = { class: 'price-slider', type: 'range' };
  const priceSlider = h('input', { ...sliderAttrs, 'aria-label': t('q.slider'), 'data-testid': 'price-slider-1' });
  const priceBSlider = h('input', { ...sliderAttrs, 'aria-label': t('q.slider2'), 'data-testid': 'price-slider-2' });
  const priceScale = h('div', { class: 'price-scale' });
  const priceBScale = h('div', { class: 'price-scale' });
  const basePriceButton = h('button', {
    type: 'button', class: 'btn btn--link', 'aria-describedby': priceLabel.id,
  });
  const basePriceBButton = h('button', {
    type: 'button', class: 'btn btn--link', 'aria-describedby': 'q-price-b-label',
  });
  const modelPriceButton = h('button', {
    type: 'button', class: 'btn btn--link', 'aria-describedby': priceLabel.id, 'data-testid': 'model-price-1', hidden: true,
  });
  const modelPriceBButton = h('button', {
    type: 'button', class: 'btn btn--link', 'aria-describedby': 'q-price-b-label', 'data-testid': 'model-price-2', hidden: true,
  });
  const priceControls = [
    { input: priceInput, slider: priceSlider, scale: priceScale, baseButton: basePriceButton, modelButton: modelPriceButton },
    { input: priceBInput, slider: priceBSlider, scale: priceBScale, baseButton: basePriceBButton, modelButton: modelPriceBButton },
  ];
  const compareToggle = h('input', { type: 'checkbox', id: 'q-compare', class: 'switch__input', 'data-testid': 'compare-toggle' });
  const errDate = h('div', { class: 'field__error', id: 'err-date' });
  const errPrice = h('div', { class: 'field__error', id: 'err-price' });
  const errPriceB = h('div', { class: 'field__error', id: 'err-price-b' });
  const errTo = h('div', { class: 'field__error', id: 'err-to' });
  const formAlert = h('div', { class: 'query__feedback', hidden: true });
  const priceBField = h(
    'div',
    { class: 'field query__priceb-field', hidden: true },
    h('label', { class: 'label', id: 'q-price-b-label', for: 'q-price-b' }, t('q.priceB')),
    priceRow(priceBInput, priceBSlider, priceBScale),
    errPriceB,
  );

  const form = h(
    'form',
    { class: 'card query', novalidate: true, 'aria-label': t('q.form'), 'data-testid': 'query-form' },
    h('div', { class: 'field' }, h('label', { class: 'label', for: 'q-from' }, t('q.from')), fromSel, clearFields),
    routeArrow,
    h('div', { class: 'field' }, h('label', { class: 'label', for: 'q-to' }, t('q.to')), toSel, errTo),
    h(
      'div',
      { class: 'field query__date-field' },
      h('label', { class: 'label', for: 'q-date' }, t('q.date')),
      h('div', { class: 'query__date' }, prevDay, dateInput, nextDay),
      errDate,
    ),
    h(
      'div',
      { class: 'field query__price-field' },
      priceLabel,
      priceRow(priceInput, priceSlider, priceScale),
      errPrice,
    ),
    h(
      'div',
      { class: 'query__extra' },
      h('label', { class: 'switch', for: 'q-compare' }, compareToggle, h('span', { class: 'switch__track', 'aria-hidden': 'true' }), t('q.compare')),
      priceBField,
    ),
    formAlert,
  );

  const dataAlert = h('div', { hidden: true });
  const unavailableText = h('p');
  const unavailable = h(
    'div',
    { class: 'card', role: 'status', hidden: true, 'data-testid': 'forecast-unavailable' },
    h('div', { class: 'empty' }, icon('radar', 'empty__icon'), unavailableText),
  );
  const results = h('div', { class: 'stack', 'data-testid': 'results' });
  const liveSummary = h('div', { class: 'sr-only', role: 'status', 'aria-live': 'polite', 'data-testid': 'live-summary' });

  const page = h(
    'main',
    { class: 'page', id: 'main' },
    h(
      'div',
      { class: 'page__head' },
      h('div', null, h('h1', { class: 'page__title' }, t('q.title')), h('p', { class: 'page__lead' }, t('q.lead'))),
    ),
    h('div', { class: 'stack' }, dataAlert, form, liveSummary, unavailable, results),
  );
  setMain(page);

  const chart = new DemandChart();
  const curveChart = new ProfitCurveChart(applyCurvePrice);
  let chartMode = state.restored?.chartMode ?? 'chart';
  let inflight: AbortController | null = null;
  let debounce: ReturnType<typeof setTimeout> | null = null;
  let last: FlightResult | null = null;
  let metaRefresh: Promise<boolean> | null = null;
  let refreshCalculation = false;
  const editedPrices = new Set<HTMLInputElement>();
  const curveCache = new Map<string, CurveResponse>();
  const monthCache = new Map<string, MonthResponse>();

  ctx.signal.addEventListener('abort', () => {
    inflight?.abort();
    if (debounce) clearTimeout(debounce);
    ctx.history.cancelPendingSave();
    chart.destroy();
    curveChart.destroy();
  });

  // ---------- состояние ----------
  let availableDates: string[] = [];
  /** Возвращает выбранный маршрут или undefined для неполной либо отсутствующей пары. Без аргументов, записи и запросов. */
  const currentRoute = (): RouteMeta | undefined =>
    meta.routes.find((r) => r.origin.code === fromSel.value && r.destination.code === toSel.value);
  /**
   * Ищет обратное направление с хотя бы одним днём прогноза.
   * Аргументов нет; возвращает маршрут из справочника или undefined, если прогноза нет.
   * Читает выбранные города и метаданные, не меняет состояние и не выполняет запросов.
   * Ошибки чтения DOM распространяются.
   */
  function reverseRoute(): RouteMeta | undefined {
    const from = fromSel.value;
    const to = toSel.value;
    if (from === to) return undefined;
    return meta.routes.find((route) => route.origin.code === to && route.destination.code === from && route.dates.length > 0);
  }
  const fromPicker = mountSelectPicker(fromSel, ctx.signal);
  const toPicker = mountSelectPicker(toSel, ctx.signal);
  const datePicker = mountDatePicker(dateInput, () => availableDates, ctx.signal);

  function setPrice(v: number | string) {
    priceInput.value = String(v);
    priceSlider.value = String(v);
  }

  /**
   * Подставляет выбранную справочную цену в соответствующее поле.
   * @param input Обязательное числовое поле первой или второй цены.
   * @param slider Обязательный ползунок того же поля; его значение ограничено диапазоном шкалы.
   * @param price Базовая цена или допустимая цена модели; undefined означает отсутствие цены.
   * @returns void. При наличии цены обновляет поле и ползунок, сохраняет выбор в записи истории
   * браузера и планирует пересчёт. Числовое поле получает цену без округления ползунком.
   * @remarks Ошибки DOM и истории распространяются; валидацию и ошибки запроса обрабатывает расчёт.
   */
  function applyPresetPrice(input: HTMLInputElement, slider: HTMLInputElement, price: number | undefined): void {
    if (price === undefined) return;
    input.value = String(price);
    slider.value = input.value;
    schedule(0);
  }

  function applyCurvePrice(price: number) {
    setPrice(price);
    void run(true);
  }

  function syncCompareControls() {
    const comparing = compareToggle.checked;
    priceBField.hidden = !comparing;
    priceLabel.textContent = t(comparing ? 'q.price1' : 'q.price');
    priceSlider.setAttribute('aria-label', t(comparing ? 'q.slider1' : 'q.slider'));
  }

  /**
   * Снимает текущее состояние поля второй цены, включая скрытое значение.
   * Аргументов нет; возвращает новый объект с ценой, видимостью и владельцем.
   * Читает DOM без записи и запросов; ошибки чтения распространяются.
   */
  function comparisonState(): ComparisonState {
    return { price: priceBInput.value, enabled: compareToggle.checked, userId: ctx.user.id };
  }

  /**
   * Показывает ошибку загрузки или список замечаний к текущим данным прогноза.
   * Аргументов нет; возвращает void. Ошибка имеет приоритет над замечаниями.
   * При отсутствии проблем скрывает и очищает предупреждение. Меняет только DOM,
   * не выполняет запросов и не сохраняет данные; ошибки DOM распространяются.
   */
  function renderDataAlert(): void {
    const d = meta.data;
    if (d.error) {
      dataAlert.hidden = false;
      dataAlert.replaceChildren(
        h('div', { class: 'alert alert--warn', role: 'status' }, icon('info'), h('p', null, t('data.failed', { error: stripDot(d.error) }))),
      );
    } else if (d.warnings.length) {
      dataAlert.hidden = false;
      const warning = warningDetails(t('data.warnings', { n: d.warnings.length }), d.warnings);
      warning.setAttribute('role', 'status');
      dataAlert.replaceChildren(warning);
    } else {
      dataAlert.hidden = true;
      dataAlert.replaceChildren();
    }
  }

  /**
   * Заполняет список городов справочника для одной стороны маршрута.
   * @param select Обязательный список отправления или назначения.
   * @param side Обязательная сторона маршрута, по которой собираются уникальные города.
   * @param preferred Код выбранного города; пустой или неизвестный код оставляет поле пустым.
   * @returns void. Заменяет варианты, восстанавливает выбор и отключает пустой список без событий и запросов.
   * Скрытый вариант представляет пустое значение, чтобы браузер не выбирал город при изменении доступности вариантов.
   * Ошибки DOM распространяются.
   */
  function fillCities(select: HTMLSelectElement, side: 'origin' | 'destination', preferred: string): void {
    const cities = new Map<string, string>();
    for (const route of meta.routes) {
      const city = route[side];
      cities.set(city.code, cityName(city));
    }
    select.replaceChildren(
      h('option', { value: '', hidden: true, disabled: true }),
      ...[...cities].map(([code, name]) => h('option', { value: code }, `${name} · ${code}`)),
    );
    select.value = cities.has(preferred) ? preferred : '';
    select.disabled = cities.size === 0;
  }

  /**
   * Обновляет элементы формы после смены городов или справочника.
   * @param preserveInvalidDate Если true, сохраняет неразобранный текст даты; по умолчанию true.
   * @returns void. Сначала пересчитывает доступные даты и обновляет календарь,
   * затем обновляет городские списки, навигацию по датам, уведомление и шкалы цен.
   * Выбранные даты и цены сохраняет. Запросов и событий нет; ошибки DOM распространяются.
   */
  function syncRouteControls(preserveInvalidDate = true): void {
    const r = currentRoute();
    availableDates = flightDates(meta.routes, fromSel.value, toSel.value);
    dateInput.min = availableDates[0] ?? '';
    dateInput.max = availableDates.at(-1) ?? '';
    dateInput.disabled = availableDates.length === 0;
    datePicker.sync(preserveInvalidDate);
    updateDateControls();
    unavailable.hidden = !dateInput.disabled || (!r && meta.routes.length > 0);
    if (!unavailable.hidden) unavailableText.textContent = t(r ? 'q.routeNoForecast' : 'q.noRoutes');
    syncPriceControls(r);
  }

  /**
   * Обновляет шкалы и размещает кнопки цен для выбранного направления.
   * @param r Маршрут со справочными ценами или undefined до выбора направления.
   * @returns void. Меняет оформление цен, сохраняя введённые значения; ошибки DOM распространяются.
   */
  function syncPriceControls(r: RouteMeta | undefined): void {
    for (const { slider } of priceControls) {
      slider.hidden = !r;
      slider.disabled = !r;
    }
    if (!r) {
      for (const { scale } of priceControls) scale.replaceChildren();
      return;
    }

    const lo = r.priceMin ?? Math.round(r.basePrice * 0.5);
    const hi = r.priceMax ?? Math.round(r.basePrice * 2);
    const step = hi - lo > 5000 ? 100 : 50;
    const sliderStep = (r.basePrice - lo) % step === 0 ? String(step) : 'any';
    const baseLabel = t('q.base', { price: Number.isInteger(r.basePrice) ? fmtInt(r.basePrice) : fmtPrice(r.basePrice) });
    for (const { input, slider, scale, baseButton, modelButton } of priceControls) {
      slider.min = String(lo);
      slider.max = String(hi);
      slider.step = sliderStep;
      slider.value = input.value;
      baseButton.textContent = baseLabel;
      scale.replaceChildren(
        h('span', { 'aria-hidden': 'true' }, fmtInt(lo)),
        h('div', { class: 'price-scale__presets' }, baseButton, modelButton),
        h('span', { 'aria-hidden': 'true' }, fmtInt(hi)),
      );
    }
  }

  /**
   * Читает цену модели для выбранного маршрута и даты. Аргументов нет.
   * Возвращает число от 0 до 1 000 000 или undefined для неполного выбора,
   * отсутствующего рейса или недопустимой цены. Читает DOM и метаданные без записи и запросов.
   */
  function selectedModelPrice(): number | undefined {
    const route = currentRoute();
    const date = dateInput.value;
    if (!route?.dates.includes(date)) return undefined;
    const price = route.modelPrices?.[date];
    return typeof price === 'number' && price >= 0 && price <= 1_000_000 ? price : undefined;
  }

  /**
   * Обновляет подписи обеих кнопок цены модели по текущему рейсу. Аргументов нет.
   * Возвращает void, скрывает кнопки без цены. Меняет только DOM; ошибки чтения и записи распространяются.
   */
  function syncModelPriceButtons(): void {
    const price = selectedModelPrice();
    const label = price === undefined ? '' : t('q.modelPrice', { price: Number.isInteger(price) ? fmtInt(price) : fmtPrice(price) });
    for (const { modelButton } of priceControls) {
      modelButton.hidden = price === undefined;
      modelButton.textContent = label;
    }
  }

  /**
   * Обновляет доступность городов, стрелок, смены направления и цены модели для выбранного дня.
   * Аргументов нет; возвращает void. При дате вне прогноза блокирует переходы.
   * Если обратный прогноз существует, показывает кнопку обмена и включает её при совпадении даты.
   * Меняет только элементы управления; ошибки DOM распространяются, запросов нет.
   */
  function updateDateControls(): void {
    updateRouteOptions();
    syncModelPriceButtons();
    const i = availableDates.indexOf(dateInput.value);
    prevDay.disabled = i <= 0;
    nextDay.disabled = i === -1 || i >= availableDates.length - 1;
    const reverse = reverseRoute();
    const hasReverse = reverse !== undefined;
    swapRoute.hidden = !hasReverse;
    swapRoute.disabled = i === -1 || !reverse?.dates.includes(dateInput.value);
    forwardArrow.toggleAttribute('hidden', hasReverse);
    routeArrow.classList.toggle('is-reversible', hasReverse);
  }

  /**
   * Отключает варианты, для которых нет рейса на выбранную дату с сохранением второго города.
   * Аргументов нет; возвращает void. При пустой дате варианты доступны по справочнику.
   * Меняет доступность исходных вариантов и синхронизирует оба списка без смены выбора,
   * событий и запросов; ошибки DOM распространяются.
   */
  function updateRouteOptions(): void {
    const { origins, destinations } = flightCities(meta.routes, fromSel.value, toSel.value, dateInput.value);
    for (const option of fromSel.options) option.disabled = !origins.has(option.value);
    for (const option of toSel.options) option.disabled = !destinations.has(option.value);
    fromPicker.sync();
    toPicker.sync();
  }

  /** Сдвигает дату по доступным дням: delta — обязательное целое смещение; за границей ничего не делает. Возвращает void; обновляет поле и планирует расчёт, ошибки DOM распространяются. */
  function shiftDay(delta: number) {
    const current = availableDates.indexOf(dateInput.value);
    if (current === -1) return;
    const next = availableDates[current + delta];
    if (next) {
      dateInput.value = next;
      datePicker.sync();
      updateDateControls();
      schedule(0);
    }
  }

  /**
   * Выбирает день в календаре загрузки и возвращает страницу к началу.
   * @param date Обязательная дата YYYY-MM-DD; дата вне списка текущего маршрута игнорируется.
   * @returns void. Обновляет поле и доступность кнопок, запускает расчёт и прокручивает страницу до начала.
   * @remarks Ошибки DOM распространяются; ошибки асинхронного расчёта обрабатывает run.
   */
  function setDate(date: string) {
    if (!(currentRoute()?.dates.includes(date) ?? false)) return;
    dateInput.value = date;
    datePicker.sync();
    updateDateControls();
    void run();
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }

  function clearErrors() {
    for (const [el, input] of [
      [errDate, dateInput],
      [errPrice, priceInput],
      [errPriceB, priceBInput],
      [errTo, toSel],
    ] as const) {
      el.textContent = '';
      input.removeAttribute('aria-invalid');
    }
    formAlert.hidden = true;
    formAlert.replaceChildren();
  }

  function showFieldErrors(fields: Record<string, string>) {
    const map: Record<string, [HTMLElement, HTMLElement]> = {
      date: [errDate, dateInput],
      price: [errPrice, priceInput],
      priceB: [errPriceB, priceBInput],
      to: [errTo, toSel],
      from: [errTo, fromSel],
    };
    for (const [k, msg] of Object.entries(fields)) {
      const pair = map[k];
      if (!pair) continue;
      pair[0].textContent = msg;
      pair[1].setAttribute('aria-invalid', 'true');
    }
  }

  function showFormError(message: string) {
    formAlert.hidden = false;
    formAlert.replaceChildren(h('div', { class: 'alert alert--error', role: 'alert' }, icon('alert'), h('p', null, message)));
  }

  function priceError(raw: string): string | null {
    const price = Number(raw);
    if (raw === '') return t('q.err.price');
    if (!Number.isFinite(price)) return t('q.err.priceNaN');
    if (price < 0) return t('q.err.priceNeg');
    if (price > 1_000_000) return t('q.err.priceMax');
    return null;
  }

  /** Читает текущие значения формы, включая неполный выбор. Без аргументов, записей и запросов; ошибки DOM распространяются. */
  function readQuery(): Query {
    return {
      from: fromSel.value,
      to: toSel.value,
      date: dateInput.value,
      price: priceInput.value.trim(),
      priceB: compareToggle.checked ? priceBInput.value.trim() || null : null,
    };
  }

  /**
   * Проверяет введённые значения и готовность формы к расчёту.
   * @param query Обязательный снимок формы, пустые строки допустимы; null означает отсутствие второй цены.
   * @returns true для существующего рейса с датой и допустимыми ценами, иначе false.
   * @remarks Обновляет сообщения валидации. Пропускает ошибки для нетронутых пустых полей;
   * без второй цены можно рассчитать основной тариф. Ошибки DOM распространяются, запросов нет.
   */
  function validate(query: Query): boolean {
    clearErrors();
    const fields: Record<string, string> = {};
    const route = currentRoute();
    if (query.from && query.to && !route) fields.to = t('q.err.route');
    const firstDate = availableDates[0];
    const lastDate = availableDates.at(-1);
    const hasFlightDate = availableDates.includes(query.date);
    if (datePicker.hasInvalidText()) fields.date = t('q.err.date');
    else if (query.date && !hasFlightDate && !dateInput.disabled) {
      fields.date = firstDate && lastDate && (query.date < firstDate || query.date > lastDate)
        ? t('q.err.dateRange', { from: fmtDateShort(firstDate), to: fmtDateShort(lastDate) })
        : t('q.err.dateUnavailable');
    }
    const primaryError = priceError(query.price);
    if (primaryError && (query.price || editedPrices.has(priceInput))) fields.price = primaryError;
    if (compareToggle.checked && (query.priceB !== null || editedPrices.has(priceBInput))) {
      const comparisonError = priceError(query.priceB ?? '');
      if (comparisonError) fields.priceB = comparisonError;
    }
    showFieldErrors(fields);
    return !!route && hasFlightDate && !primaryError && Object.keys(fields).length === 0;
  }

  /** Убирает устаревший прогноз и статус загрузки. Без аргументов; очищает снимок и DOM без запросов, ошибки DOM распространяются. */
  function clearResult(): void {
    last = null;
    liveSummary.textContent = '';
    results.classList.remove('is-loading');
    results.replaceChildren();
  }

  /**
   * Сохраняет выбор и рассчитывает прогноз для готовой формы.
   * @param keepCurvePosition При true сохраняет позицию кривой после рендера; по умолчанию false.
   * @param retryVersion При true допускает один повтор при несовпадении снимков; по умолчанию true.
   * @returns Promise<void> после обработки текущего расчёта или сразу при неполной форме.
   * @remarks Отменяет прежний таймер и запрос, записывает параметры и валидирует форму. Для готовой формы
   * загружает прогнозы, кривую и загрузку по дням параллельно, используя кеш версии данных.
   * При несовпадении обновляет метаданные и передаёт повтор обновлению или выполняет его один раз.
   * Целостный результат обновляет DOM, кеш и планирует запись в историю. Отменённые ответы игнорирует;
   * ошибки API отображает либо завершает сессию, при 404 обновляет метаданные. Ошибки записи адреса распространяются.
   */
  async function run(keepCurvePosition = false, retryVersion = true) {
    if (debounce) clearTimeout(debounce);
    debounce = null;
    inflight?.abort();
    inflight = null;
    const q = readQuery();
    writeUrlQuery(q, comparisonState());
    if (!validate(q)) {
      refreshCalculation = false;
      ctx.history.cancelPendingSave();
      clearResult();
      return;
    }
    const ac = new AbortController();
    inflight = ac;
    results.classList.add('is-loading');
    const price = Number(q.price);
    const curveKey = `${meta.data.version}|${q.from}-${q.to}|${q.date}`;
    const monthKey = `${meta.data.version}|${q.from}-${q.to}|${price}`;
    try {
      const [a, b, curve, month] = await Promise.all([
        api.forecast({ from: q.from, to: q.to, date: q.date, price }, ac.signal),
        q.priceB !== null ? api.forecast({ from: q.from, to: q.to, date: q.date, price: Number(q.priceB) }, ac.signal) : Promise.resolve(null),
        curveCache.get(curveKey) ?? api.curve({ from: q.from, to: q.to, date: q.date }, ac.signal),
        monthCache.get(monthKey) ?? api.month({ from: q.from, to: q.to, price }, ac.signal),
      ]);
      if (ac.signal.aborted || ctx.signal.aborted) return;
      if (![a, b, curve, month].every((response) => response === null || matchesDataVersion(response, meta.data))) {
        const changed = await refreshMeta();
        if (!changed && retryVersion && !ac.signal.aborted && !ctx.signal.aborted) {
          curveCache.delete(curveKey);
          monthCache.delete(monthKey);
          await run(keepCurvePosition, false);
        }
        return;
      }
      curveCache.set(curveKey, curve);
      monthCache.set(monthKey, month);
      last = { a, b, curve, month };
      renderResult(keepCurvePosition);
      refreshCalculation = false;
      ctx.history.scheduleSave({ from: q.from, to: q.to, date: q.date, price });
    } catch (err) {
      if (ac.signal.aborted || (err as Error).name === 'AbortError' || ctx.signal.aborted) return;
      if (err instanceof ApiError) {
        if (err.status === 401) return ctx.onLogout(t('session.expired'));
        if (err.status === 404) void refreshMeta();
        if (Object.keys(err.fields).length) showFieldErrors(err.fields);
        showFormError(err.message);
      } else {
        showFormError(t('q.err.request'));
      }
    } finally {
      if (inflight === ac) {
        inflight = null;
        results.classList.remove('is-loading');
      }
    }
  }

  /**
   * Откладывает расчёт после изменения формы.
   * @param ms Неотрицательная задержка в миллисекундах, по умолчанию 250.
   * @returns void. Сразу сохраняет поля в адресе и записи истории, отменяет текущие запросы и заменяет таймер.
   * Ошибки History API и таймера распространяются; асинхронным расчётом управляет run.
   */
  function schedule(ms = 250) {
    writeUrlQuery(readQuery(), comparisonState());
    inflight?.abort();
    if (debounce) clearTimeout(debounce);
    debounce = setTimeout(() => void run(), ms);
  }

  /**
   * Переиспользует текущую проверку метаданных. Аргументов нет.
   * @returns Promise с true, если проверка сменила версию; остальные исходы дают false.
   * @remarks Допускает только один запрос проверки одновременно для этого экрана.
   * Ошибки обрабатывает загрузка метаданных; после завершения следующий вызов может повторить запрос.
   */
  function refreshMeta(): Promise<boolean> {
    return metaRefresh ??= loadMeta().finally(() => { metaRefresh = null; });
  }

  /**
   * Загружает актуальные метаданные для формы и её справочника. Аргументов нет.
   * @returns Promise с true при переходе на новую версию и false при прежней версии, отмене или сбое.
   * @remarks Использует сигнал экрана; при новой версии очищает кеш, восстанавливает доступные города,
   * обновляет элементы управления и планирует расчёт. При совпадении версий обновляет цену модели;
   * если ещё нет успешного расчёта для обновлённых данных, повторяет его при свободной форме.
   * При 401 завершает сессию; прочие сбои запроса метаданных игнорирует.
   */
  async function loadMeta(): Promise<boolean> {
    try {
      const next = await api.meta(ctx.signal);
      if (ctx.signal.aborted) return false;
      const previousData = meta.data;
      const changed = next.data.version !== previousData.version || next.data.loadedAt !== previousData.loadedAt;
      meta = next;
      renderDataAlert();
      if (changed) {
        curveCache.clear();
        monthCache.clear();
        const keep = { from: fromSel.value, to: toSel.value };
        fillCities(fromSel, 'origin', keep.from);
        fillCities(toSel, 'destination', keep.to);
        syncRouteControls();
        toast(t(dataUpdateNotice(previousData.source, next.data.source)));
        refreshCalculation = true;
        schedule(0);
      } else {
        syncModelPriceButtons();
        if (refreshCalculation && !inflight && !debounce) schedule(0);
      }
      return changed;
    } catch (err) {
      if ((err as Error).name === 'AbortError' || ctx.signal.aborted) return false;
      if (err instanceof ApiError && err.status === 401) ctx.onLogout(t('session.expired'));
      return false;
    }
  }

  // ---------- результат ----------
  /**
   * Отображает последний успешный расчёт и общее предупреждение для обеих активных цен.
   * @param keepCurvePosition Булево значение без значения по умолчанию: сохранять ли положение кривой при перерисовке.
   * @returns Ничего; если `last` отсутствует, завершает работу без изменений.
   * @remarks Вызывается после успешного расчёта и очистки ошибок формы в `validate`.
   * Сначала собирает карточки и предупреждение при выходе любой активной цены за диапазон,
   * затем заменяет результаты, обновляет графики, восстанавливает фокус и при необходимости прокрутку.
   * При выключенном сравнении `last.b` равен `null` и не влияет на предупреждение.
   * Изменяет DOM и состояние графиков; не выполняет запросов и не сохраняет данные.
   * Ошибки DOM и графиков передаются в `run` без повторов и отката частичных изменений.
   */
  function renderResult(keepCurvePosition: boolean) {
    if (!last) return;
    const curveTop = keepCurvePosition ? curveChart.root.getBoundingClientRect().top : null;
    const { a: r, b, curve, month } = last;
    const med = r.median;
    const focused = results.querySelector(':focus-visible');
    const focusedDate = focused?.getAttribute('data-date');
    const focusedControl = focused?.getAttribute('data-testid');
    const curveFocused = focused?.matches('[data-testid="profit-curve"] .hit');
    liveSummary.textContent = t('r.liveSummary', { sales: fmtInt(med.rounded.sales), seats: fmtInt(r.seats), free: fmtInt(med.rounded.freeSeats) });
    const nodes: HTMLElement[] = [];
    if (b) nodes.push(compareCard(r, b));
    nodes.push(statsCard(r), chartCard(r), curveCard(curve), calendarCard(month, r.date));
    if (r.priceOutOfRange || b?.priceOutOfRange) {
      formAlert.hidden = false;
      formAlert.replaceChildren(h('div', { class: 'alert alert--warn', role: 'status', 'data-testid': 'price-range-warning' }, icon('info'), h('p', null, t('f.outOfRange'))));
    }
    results.replaceChildren(...nodes);
    setChartMode(chartMode);
    curveChart.update(curve, r.price);
    if (focusedDate) {
      results.querySelector<HTMLButtonElement>(`button[data-date="${CSS.escape(focusedDate)}"]`)?.focus({ preventScroll: true });
    } else if (focusedControl) {
      results.querySelector<HTMLElement>(`[data-testid="${CSS.escape(focusedControl)}"]`)?.focus({ preventScroll: true });
    } else if (curveFocused) {
      curveChart.root.querySelector<SVGElement>('.hit')?.focus({ preventScroll: true });
    }
    if (curveTop !== null) {
      const offset = curveChart.root.getBoundingClientRect().top - curveTop;
      if (offset !== 0) window.scrollBy({ top: offset, behavior: 'instant' });
    }
  }

  function statsCard(r: ForecastResponse) {
    const med = r.median;
    const over = Math.max(0, med.wants - r.seats);
    const risk = sellOutView(r.sellOut);
    return h(
      'section',
      { class: 'card', 'aria-label': t('r.summary') },
      h(
        'div',
        { class: 'stats' },
        stat(
          t('r.sales'),
          h('span', { class: 'stat__value stat__value--hero', 'data-testid': 'sales' }, fmtInt(med.rounded.sales), h('span', { class: 'stat__unit' }, t('r.tickets', { n: med.rounded.sales }))),
          h('span', { class: 'stat__note' }, `${t('r.salesNote')} `, h('strong', null, fmtPct(med.loadFactor))),
        ),
        stat(
          t('r.free'),
          h('span', { class: 'stat__value', 'data-testid': 'free-seats' }, fmtInt(med.rounded.freeSeats)),
          h('span', { class: 'stat__note' }, `${t('r.totalSeats')} `, h('strong', { 'data-testid': 'seats' }, fmtInt(r.seats))),
        ),
        stat(
          t('r.wants'),
          h('span', { class: 'stat__value', 'data-testid': 'wants' }, fmtNum(med.wants)),
          h('span', { class: 'stat__note' }, over > 0 ? h('strong', null, t('r.overflow', { n: fmtNum(over) })) : t('r.atBase', { n: fmtNum(med.baseDemand) })),
        ),
        stat(
          t('r.risk'),
          h('span', { class: 'stat__value', 'data-testid': 'sellout' }, risk.text),
          h('span', { class: `badge ${risk.high ? 'badge--warn' : 'badge--ok'}` }, icon(risk.high ? 'alert' : 'check'), risk.high ? t('r.riskHigh') : t('r.riskLow')),
          h('span', { class: 'stat__note' }, t('r.riskNote')),
        ),
      ),
      meter(med.loadFactor),
    );
  }

  const btnChart = h('button', { type: 'button', class: 'seg__btn' }, t('c.chart'));
  const btnTable = h('button', { type: 'button', class: 'seg__btn', 'data-testid': 'table-toggle' }, t('c.table'));
  const viewSlot = h('div');
  btnChart.addEventListener('click', () => setChartMode('chart'));
  btnTable.addEventListener('click', () => setChartMode('table'));

  function setChartMode(mode: 'chart' | 'table') {
    chartMode = mode;
    btnChart.setAttribute('aria-pressed', String(mode === 'chart'));
    btnTable.setAttribute('aria-pressed', String(mode === 'table'));
    if (!last) return;
    const r = last.a;
    if (mode === 'chart') {
      const legend = h(
        'ul',
        { class: 'legend', 'aria-label': t('c.legend') },
        h('li', null, h('span', { class: 'legend__swatch legend__swatch--sold' }), t('c.buy')),
        h('li', null, h('span', { class: 'legend__swatch legend__swatch--over' }), t('c.over')),
        h('li', null, h('span', { class: 'legend__line' }), t('c.capacity', { n: fmtInt(r.seats), raw: r.seats })),
      );
      viewSlot.replaceChildren(h('div', null, legend, chart.root));
      chart.update({ scenarios: r.scenarios, seats: r.seats, price: r.price });
    } else {
      viewSlot.replaceChildren(scenarioTable(r));
    }
  }

  function chartCard(r: ForecastResponse) {
    const med = r.median;
    const lo = r.scenarios[0]!;
    const hi = r.scenarios[r.scenarios.length - 1]!;
    const coverage = Math.round((hi.q - lo.q) * 100);
    return h(
      'section',
      { class: 'card chart-card', 'aria-labelledby': 'chart-title' },
      h(
        'div',
        { class: 'card__head' },
        h(
          'div',
          null,
          h('h2', { class: 'card__title', id: 'chart-title' }, t('c.title', { price: fmtPrice(r.price) })),
          h('p', { class: 'card__sub' }, t('c.sub', { n: r.scenarios.length })),
        ),
        h('div', { class: 'seg', role: 'group', 'aria-label': t('c.view') }, btnChart, btnTable),
      ),
      h(
        'div',
        { class: 'card__body' },
        viewSlot,
        h(
          'div',
          { class: 'chart-caption', 'data-testid': 'chart-caption' },
          h(
            'span',
            null,
            t('c.range', { pct: coverage }),
            h('strong', null, fmtNum(Math.max(0, lo.wants))),
            t('c.rangeTo'),
            h('strong', null, fmtNum(Math.max(0, hi.wants))),
            t('c.people', { n: Math.round(Math.max(0, hi.wants)) }),
          ),
          h('span', null, t('c.median', { q: quantileLabel(0.5) }), h('strong', { 'data-testid': 'median-caption' }, fmtNum(med.wants))),
        ),
      ),
    );
  }

  function compareCard(a: ForecastResponse, b: ForecastResponse) {
    const rows: Array<[string, number, number, (x: number) => string, boolean]> = [
      [t('t.wants'), a.median.wants, b.median.wants, fmtNum, false],
      [t('t.sales'), a.median.sales, b.median.sales, fmtNum, false],
      [t('t.free'), a.median.freeSeats, b.median.freeSeats, fmtNum, false],
      [t('cmp.loadRow'), a.median.loadFactor, b.median.loadFactor, fmtPct, true],
      [t('r.revenue'), a.economics.revenue, b.economics.revenue, fmtMoneyShort, false],
    ];
    if (a.economics.margin !== null && b.economics.margin !== null) rows.push([t('r.margin'), a.economics.margin, b.economics.margin, fmtMoneyShort, false]);
    const tbody = h('tbody');
    for (const [label, va, vb, fmt, pct] of rows) {
      const diff = vb - va;
      const sign = diff > 0 ? '+' : diff < 0 ? '−' : '';
      const diffText = diff === 0 ? '—' : `${sign}${pct ? fmtPct(Math.abs(diff)) : fmt(Math.abs(diff))}`;
      tbody.append(h('tr', null, h('td', null, label), h('td', null, fmt(va)), h('td', null, fmt(vb)), h('td', { class: diff > 0 ? 'is-up' : diff < 0 ? 'is-down' : '' }, diffText)));
    }
    const ra = sellOutView(a.sellOut);
    const rb = sellOutView(b.sellOut);
    tbody.append(h('tr', null, h('td', null, t('cmp.riskRow')), h('td', null, ra.text), h('td', null, rb.text), h('td', null, '')));

    const ma = a.economics.margin ?? a.economics.revenue;
    const mb = b.economics.margin ?? b.economics.revenue;
    const verdict = ma === mb ? t('cmp.same') : t('cmp.better', { which: mb > ma ? 2 : 1, n: fmtMoneyShort(Math.abs(mb - ma)) });
    return h(
      'section',
      { class: 'card', 'aria-labelledby': 'cmp-title', 'data-testid': 'compare-card' },
      h('div', { class: 'card__head' }, h('div', null, h('h2', { class: 'card__title', id: 'cmp-title' }, t('cmp.title')), h('p', { class: 'card__sub' }, t('cmp.sub')))),
      h(
        'div',
        { class: 'card__body' },
        h(
          'div',
          { class: 'table-wrap', tabindex: 0, role: 'region', 'aria-label': t('t.scrollable') },
          h(
            'table',
            { class: 'table table--compare' },
            h('thead', null, h('tr', null, h('th', { scope: 'col' }, t('cmp.metric')), h('th', { scope: 'col' }, t('cmp.a', { price: fmtPrice(a.price) })), h('th', { scope: 'col' }, t('cmp.b', { price: fmtPrice(b.price) })), h('th', { scope: 'col' }, t('cmp.diff')))),
            tbody,
          ),
        ),
        h('p', { class: 'compare-verdict', 'data-testid': 'compare-verdict' }, verdict),
      ),
    );
  }

  function curveCard(curve: CurveResponse) {
    const best = curve.optimum;
    const value = best.margin ?? best.revenue;
    const apply = h('button', { type: 'button', class: 'btn btn--ghost btn--sm', 'data-testid': 'apply-best-price' }, t('pc.apply'));
    apply.addEventListener('click', () => applyCurvePrice(best.price));
    const legend = h(
      'ul',
      { class: 'legend', 'aria-label': t('c.legend') },
      curve.costPerPassenger !== null ? h('li', null, h('span', { class: 'legend__stroke legend__stroke--accent' }), t('pc.margin')) : null,
      h('li', null, h('span', { class: 'legend__stroke legend__stroke--muted' }), t('pc.revenue')),
      h('li', null, h('span', { class: 'legend__vline' }), t('pc.current')),
      curve.modelPrice !== null ? h('li', null, h('span', { class: 'legend__vline legend__vline--dashed' }), t('pc.model')) : null,
      h('li', null, h('span', { class: 'legend__dot' }), curve.costPerPassenger !== null ? t('pc.best') : t('pc.bestRevenue')),
    );
    return h(
      'section',
      { class: 'card', 'aria-labelledby': 'pc-title', 'data-testid': 'curve-card' },
      h('div', { class: 'card__head' }, h('div', null, h('h2', { class: 'card__title', id: 'pc-title' }, t('pc.title')), h('p', { class: 'card__sub' }, t('pc.sub')))),
      h(
        'div',
        { class: 'card__body' },
        legend,
        curveChart.root,
        h(
          'div',
          { class: 'chart-caption' },
          h('span', { 'data-testid': 'best-price-note' }, t('pc.bestNote', { price: fmtPrice(best.price), value: fmtMoneyShort(value), sales: fmtNum(best.sales) }), best.capped ? ` ${t('pc.capNote')}` : ''),
          apply,
        ),
      ),
    );
  }

  function calendarCard(month: MonthResponse, selected: string) {
    return h(
      'section',
      { class: 'card', 'aria-labelledby': 'cal-title', 'data-testid': 'calendar-card' },
      h('div', { class: 'card__head' }, h('div', null, h('h2', { class: 'card__title', id: 'cal-title' }, t('cal.title')), h('p', { class: 'card__sub' }, t('cal.sub', { price: fmtPrice(month.price) })))),
      h('div', { class: 'card__body' }, renderCalendar(month.days, selected, setDate)),
    );
  }

  /**
   * Возвращает форму к состоянию первого открытия.
   * Аргументов нет; возвращает void. Очищает города, дату и обе цены, выключает сравнение
   * и обновляет элементы формы. Затем run отменяет ожидающий таймер и текущий запрос, удаляет
   * параметры адреса, ошибки и результат без нового запроса. Ошибки DOM распространяются.
   */
  function resetFields(): void {
    fromSel.value = '';
    toSel.value = '';
    dateInput.value = '';
    priceInput.value = '';
    priceBInput.value = '';
    compareToggle.checked = false;
    editedPrices.clear();
    chartMode = 'chart';
    syncCompareControls();
    syncRouteControls(false);
    void run();
  }

  // ---------- события ----------
  /** Обновляет ограничения после выбора города и планирует расчёт. Без аргументов и результата; ошибки синхронизации DOM распространяются. */
  function updateSelectedCities(): void {
    syncRouteControls();
    schedule(0);
  }
  fromSel.addEventListener('change', updateSelectedCities);
  toSel.addEventListener('change', updateSelectedCities);
  clearFields.addEventListener('click', resetFields);
  swapRoute.addEventListener('click', () => {
    const reverse = reverseRoute();
    if (swapRoute.disabled || !reverse?.dates.includes(dateInput.value)) return;
    fromSel.value = reverse.origin.code;
    toSel.value = reverse.destination.code;
    updateSelectedCities();
    if (swapRoute.hidden) document.getElementById(`${toSel.id}-trigger`)?.focus({ preventScroll: true });
  });
  dateInput.addEventListener('input', () => {
    updateDateControls();
    schedule();
  });
  dateInput.addEventListener('change', () => {
    updateDateControls();
    schedule(0);
  });
  prevDay.addEventListener('click', () => shiftDay(-1));
  nextDay.addEventListener('click', () => shiftDay(1));
  for (const { input, slider, baseButton, modelButton } of priceControls) {
    input.addEventListener('input', () => {
      editedPrices.add(input);
      if (input.value !== '') slider.value = input.value;
      schedule();
    });
    slider.addEventListener('change', () => {
      input.value = slider.value;
      schedule(0);
    });
    baseButton.addEventListener('click', () => applyPresetPrice(input, slider, currentRoute()?.basePrice));
    modelButton.addEventListener('click', () => applyPresetPrice(input, slider, selectedModelPrice()));
  }
  /**
   * Активирует флажок сравнения по Enter через стандартное событие click.
   * @param event Обязательное событие KeyboardEvent на флажке. Пробел и остальные клавиши обрабатывает браузер.
   * @returns void. Для Enter отменяет стандартное действие формы. Повторы при удержании игнорирует.
   * @remarks Нажатие Enter меняет состояние доступного флажка и вызывает updateComparison
   * через событие change. Ошибки вызовов DOM не перехватываются.
   */
  function activateCompareOnEnter(event: KeyboardEvent): void {
    if (event.key !== 'Enter') return;
    event.preventDefault();
    if (!event.repeat) compareToggle.click();
  }

  /**
   * Синхронизирует поля после изменения флажка. Аргументов нет, возвращает void.
   * Сначала обновляет видимость и подписи, при включении фокусирует поле второй цены,
   * затем сохраняет параметры в URL и состояние сравнения, отменяет текущий запрос и заменяет
   * таймер пересчёта. Пересчёт может отправить сетевые запросы. Ошибки DOM, History API и таймера
   * прерывают синхронные шаги и передаются браузеру. Отката нет.
   */
  function updateComparison(): void {
    syncCompareControls();
    if (compareToggle.checked) priceBInput.focus();
    schedule(0);
  }

  compareToggle.addEventListener('keydown', activateCompareOnEnter);
  compareToggle.addEventListener('change', updateComparison);
  form.addEventListener('submit', (e) => e.preventDefault());
  watchDataUpdates(ctx.signal, () => void refreshMeta());
  document.addEventListener(
    'themechange',
    () => {
      if (last && chartMode === 'chart') chart.update({ scenarios: last.a.scenarios, seats: last.a.seats, price: last.a.price });
      if (last) curveChart.update(last.curve, last.a.price);
    },
    { signal: ctx.signal },
  );

  // ---------- старт ----------
  renderDataAlert();
  const restored = state.restored;
  const initial = restored ?? readUrlQuery();
  fillCities(fromSel, 'origin', initial.from?.toUpperCase() ?? '');
  fillCities(toSel, 'destination', initial.to?.toUpperCase() ?? '');
  const urlPriceB = 'priceB' in initial ? initial.priceB : null;
  if (restored || (initial.price && Number.isFinite(Number(initial.price)))) setPrice(initial.price ?? '');
  const savedComparison = restored
    ? { price: restored.comparisonPrice, enabled: restored.comparing }
    : readComparisonState(ctx.user.id);
  if (savedComparison || (urlPriceB && Number.isFinite(Number(urlPriceB)))) {
    compareToggle.checked = savedComparison?.enabled ?? true;
    priceBInput.value = savedComparison?.price ?? urlPriceB ?? '';
    priceBSlider.value = priceBInput.value;
  }
  syncCompareControls();
  syncRouteControls();
  if (initial.date && availableDates.includes(initial.date)) {
    dateInput.value = initial.date;
    datePicker.sync();
    updateDateControls();
  }
  state.capture(() => ({
    meta, from: fromSel.value, to: toSel.value, date: dateInput.value, price: priceInput.value,
    comparisonPrice: priceBInput.value, comparing: compareToggle.checked, chartMode, result: last,
  }));

  if (restored?.meta) void refreshMeta();
  const result = restored?.result;
  const query = readQuery();
  if (result && validate(query) && result.a.route.code === currentRoute()?.code && result.a.date === query.date
    && matchesDataVersion(result.a, meta.data) && matchesDataVersion(result.curve, meta.data)
    && matchesDataVersion(result.month, meta.data) && result.a.price === Number(query.price)
    && (query.priceB === null
      ? result.b === null
      : result.b?.price === Number(query.priceB) && matchesDataVersion(result.b, meta.data))) {
    last = result;
    writeUrlQuery(query, comparisonState());
    renderResult(false);
    ctx.history.scheduleSave({ from: query.from, to: query.to, date: query.date, price: result.a.price });
    return;
  }
  void run();
}

function priceRow(input: HTMLInputElement, slider: HTMLInputElement, scale: HTMLElement) {
  return h('div', { class: 'price-row' }, h('div', { class: 'input-group' }, input, h('span', { class: 'input-group__suffix' }, '₽')), slider, scale);
}

function stat(label: string, value: Node, ...notes: Node[]) {
  return h('div', { class: 'stat' }, h('span', { class: 'label' }, label), value, ...notes);
}

function meter(load: number) {
  const pct = Math.max(0, Math.min(1, load));
  const fill = h('div', { class: 'meter__fill' });
  fill.style.width = `${(pct * 100).toFixed(2)}%`;
  const ticks = h('div', { class: 'meter__ticks', 'aria-hidden': 'true' });
  for (const v of [0, 25, 50, 75, 100]) {
    const sp = h('span', null, `${v}%`);
    sp.style.left = `${v}%`;
    ticks.append(sp);
  }
  return h(
    'div',
    { class: 'meter' },
    h(
      'div',
      { class: 'meter__bar', role: 'meter', 'aria-label': t('r.load'), 'aria-valuemin': 0, 'aria-valuemax': 100, 'aria-valuenow': Math.round(pct * 100), 'aria-valuetext': fmtPct(pct) },
      fill,
    ),
    ticks,
  );
}

function scenarioTable(r: ForecastResponse) {
  const tbody = h('tbody');
  for (const sc of r.scenarios) {
    tbody.append(
      h(
        'tr',
        { class: sc.q === 0.5 ? 'is-median' : '' },
        h('td', null, `${quantileLabel(sc.q)}${sc.q === 0.5 ? ` · ${t('t.median')}` : ''}`),
        h('td', null, fmtNum(sc.baseDemand)),
        h('td', null, fmtNum(sc.wants)),
        h('td', null, fmtNum(sc.sales)),
        h('td', null, sc.overflow > 0 ? fmtNum(sc.overflow) : '—'),
        h('td', null, fmtNum(r.seats - sc.sales)),
      ),
    );
  }
  return h(
    'div',
    { class: 'table-wrap', tabindex: 0, role: 'region', 'aria-label': t('t.scrollable') },
    h(
      'table',
      { class: 'table', 'data-testid': 'scenario-table' },
      h('caption', { class: 'sr-only' }, t('t.caption')),
      h(
        'thead',
        null,
        h(
          'tr',
          null,
          h('th', { scope: 'col' }, t('t.scenario')),
          h('th', { scope: 'col' }, t('t.base')),
          h('th', { scope: 'col' }, t('t.wants')),
          h('th', { scope: 'col' }, t('t.sales')),
          h('th', { scope: 'col' }, t('t.over')),
          h('th', { scope: 'col' }, t('t.free')),
        ),
      ),
      tbody,
    ),
  );
}
