/** Хранилище снимков «Рейса» и «Табло» в текущей вкладке браузера. */
import type { BoardScreenState, FlightScreenState } from './screen-state';

/** Связывает маршруты рабочих экранов с типами их снимков. */
interface ScreenStates {
  '/': FlightScreenState;
  '/board': BoardScreenState;
}

/** Ключи снимков с версией формата; смена версии отделяет несовместимые данные. */
const keys: Record<keyof ScreenStates, string> = {
  '/': 'ra-flight-screen-v1',
  '/board': 'ra-board-screen-v1',
};

/** Ключ поколения записей навигации в текущей вкладке. */
const navigationGenerationKey = 'ra-screen-navigation-generation';

/**
 * Читает или обновляет поколение записей навигации текущей вкладки.
 * @param next Необязательное целое неотрицательное поколение; без аргумента выполняется только чтение.
 * @returns Поколение либо 0, если сохранённое значение отсутствует или недоступно.
 * При записи возвращает переданное поколение даже при ошибке хранилища.
 * @remarks Обращается только к sessionStorage, не выполняет сетевых запросов.
 */
export function screenNavigationGeneration(next?: number): number {
  try {
    if (next !== undefined) sessionStorage.setItem(navigationGenerationKey, String(next));
    else {
      const saved = Number(sessionStorage.getItem(navigationGenerationKey));
      if (Number.isSafeInteger(saved) && saved >= 0) return saved;
    }
  } catch {
    // Без хранилища поколение действует до перезагрузки документа.
  }
  return next ?? 0;
}

/**
 * Проверяет объекты из хранилища перед чтением их полей.
 * @param value Обязательное значение любого типа.
 * @returns true для объекта, отличного от массива и null.
 * @remarks Чистая проверка без исключений, изменения данных и ввода-вывода.
 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Проверяет поля города, используемые в списках маршрутов и на карте.
 * @param value Обязательное значение из хранилища произвольного типа.
 * @returns true, если код и название города являются строками.
 * @remarks Не меняет данные, не выполняет запросов и не выбрасывает исключений.
 */
function isCity(value: unknown): boolean {
  return isRecord(value) && typeof value.code === 'string' && typeof value.name === 'string';
}

/**
 * Проверяет основные параметры и структуру кешированного ответа «Рейса».
 * @param state Обязательный объект из хранилища; поля считаются непроверенными.
 * @returns Снимок либо undefined для некорректных параметров. Если кеш повреждён,
 * возвращает параметры без кеша, чтобы экран выполнил обычную загрузку.
 * @remarks Входные данные не изменяет, запросов не выполняет.
 */
function restoreFlight(state: Record<string, unknown>): FlightScreenState | undefined {
  const { from, to, date, price, comparisonPrice, comparing, chartMode, meta, result } = state;
  if (typeof from !== 'string' || typeof to !== 'string' || typeof date !== 'string'
    || typeof price !== 'string' || typeof comparisonPrice !== 'string'
    || typeof comparing !== 'boolean' || (chartMode !== 'chart' && chartMode !== 'table')) return;

  const parameters = { from, to, date, price, comparisonPrice, comparing, chartMode } as const;
  if (!isRecord(meta) || !Array.isArray(meta.routes) || !isRecord(meta.data)
    || !Array.isArray(meta.data.warnings) || typeof meta.data.version !== 'number'
    || (meta.data.error !== null && typeof meta.data.error !== 'string')
    || !meta.routes.every((route: unknown) => isRecord(route) && typeof route.code === 'string'
      && isCity(route.origin) && isCity(route.destination) && Array.isArray(route.dates)
      && route.dates.every((day: unknown) => typeof day === 'string'))) return { ...parameters, result: null };

  const usableResult = isRecord(result) && isForecast(result.a) && (result.b === null || isForecast(result.b))
    && isRecord(result.curve) && Array.isArray(result.curve.points) && result.curve.points.every(isRecord)
    && isRecord(result.curve.bounds)
    && isRecord(result.curve.optimum) && isRecord(result.month) && Array.isArray(result.month.days)
    && result.month.days.every((day: unknown) => isRecord(day) && typeof day.date === 'string');
  return {
    ...parameters,
    meta: meta as unknown as FlightScreenState['meta'],
    result: usableResult ? result as unknown as FlightScreenState['result'] : null,
  };
}

/**
 * Проверяет обязательные контейнеры ответа прогноза перед использованием кеша.
 * @param value Обязательное значение из хранилища произвольного типа.
 * @returns true, если присутствуют маршрут, сценарии, медиана, экономика и риск распродажи.
 * @remarks Читает значения без изменения и ввода-вывода; некорректный ответ отклоняет без исключения.
 */
function isForecast(value: unknown): boolean {
  return isRecord(value) && isRecord(value.route) && isRecord(value.median) && isRecord(value.median.rounded)
    && isRecord(value.economics) && isRecord(value.sellOut) && Array.isArray(value.scenarios)
    && value.scenarios.length > 0 && value.scenarios.every(isRecord);
}

/**
 * Проверяет параметры и обязательные контейнеры ответа «Табло».
 * @param state Обязательный объект из хранилища; поля считаются непроверенными.
 * @returns Снимок либо undefined для некорректных параметров; повреждённый ответ исключается.
 * @remarks Не меняет аргумент и не выполняет запросов.
 */
function restoreBoard(state: Record<string, unknown>): BoardScreenState | undefined {
  const { date, mode, result } = state;
  if (typeof date !== 'string' || (mode !== 'base' && mode !== 'model')) return;
  const usableResult = isRecord(result) && Array.isArray(result.dates) && Array.isArray(result.flights)
    && result.dates.every((day: unknown) => typeof day === 'string')
    && result.flights.every((flight: unknown) => isRecord(flight) && typeof flight.route === 'string'
      && isCity(flight.origin) && isCity(flight.destination) && isRecord(flight.rounded));
  return { date, mode, result: usableResult ? result as unknown as BoardScreenState['result'] : null };
}

/**
 * Читает сохранённый снимок рабочего экрана текущего пользователя.
 * @param route Обязательный маршрут «Рейса» или «Табло»; определяет тип результата.
 * @param userId Обязательный идентификатор авторизованного пользователя.
 * @returns Снимок либо undefined при отсутствии, другом владельце или ошибке чтения.
 * @remarks Читает sessionStorage без записи и сетевых запросов.
 */
export function readScreenState<Route extends keyof ScreenStates>(route: Route, userId: number): ScreenStates[Route] | undefined {
  try {
    const raw = sessionStorage.getItem(keys[route]);
    if (!raw) return;
    const saved: unknown = JSON.parse(raw);
    if (!isRecord(saved) || saved.userId !== userId || !isRecord(saved.state)) return;
    const state = route === '/' ? restoreFlight(saved.state) : restoreBoard(saved.state);
    return state as ScreenStates[Route] | undefined;
  } catch {
    // При недоступном хранилище экран продолжает работать с адресом и памятью страницы.
  }
}

/**
 * Сохраняет свежий снимок одного рабочего экрана.
 * @param route Обязательный маршрут «Рейса» или «Табло».
 * @param userId Обязательный идентификатор владельца снимка.
 * @param state Обязательный сериализуемый снимок, соответствующий маршруту.
 * @returns void. Заменяет снимок экрана в sessionStorage без запросов.
 * При ошибке пробует сохранить параметры без ответов API, а затем убрать устаревший снимок.
 */
export function saveScreenState<Route extends keyof ScreenStates>(route: Route, userId: number, state: ScreenStates[Route]): void {
  try {
    sessionStorage.setItem(keys[route], JSON.stringify({ userId, state }));
  } catch {
    try {
      const parameters = { ...state, meta: undefined, result: null };
      sessionStorage.setItem(keys[route], JSON.stringify({ userId, state: parameters }));
    } catch {
      try {
        sessionStorage.removeItem(keys[route]);
      } catch {
        // При недоступном хранилище остаётся снимок в памяти страницы.
      }
    }
  }
}

/**
 * Удаляет снимки рабочих экранов при завершении сессии.
 * Аргументов нет; возвращает void. Меняет только sessionStorage текущей вкладки.
 * Ошибки доступа игнорируются; сетевые запросы не выполняются.
 */
export function clearScreenStates(): void {
  try {
    for (const key of Object.values(keys)) sessionStorage.removeItem(key);
  } catch {
    // Память страницы очищает вызывающий код.
  }
}
