import '@fontsource/ibm-plex-sans/400.css';
import '@fontsource/ibm-plex-sans/500.css';
import '@fontsource/ibm-plex-sans/600.css';
import '@fontsource/ibm-plex-mono/400.css';
import '@fontsource/ibm-plex-mono/500.css';
import './styles.css';
import './addons.css';
import './controls/controls.css';

import { api, type HistoryItem, type User } from './api';
import { h, icon } from './dom';
import { trackFocusInput } from './focus-input';
import { t } from './i18n';
import { followSystemTheme } from './theme';
import { renderAdmin } from './views/admin';
import { renderAuth } from './views/auth';
import { renderBoard } from './views/board';
import { renderCalculator } from './views/calculator';
import { HistoryDrawer } from './views/history';
import type { BoardScreenState, FlightScreenState } from './views/screen-state';
import { clearScreenStates, readScreenState, saveScreenState, screenNavigationGeneration } from './views/screen-storage';
import { renderShell, type AppCtx, type Route } from './views/shell';

const root = document.getElementById('app')!;
let screen: AbortController | null = null;
let allowRegistration = true;
let currentUser: User | null = null;
let authMessage: string | undefined;
let captureScreen: (() => void) | undefined;
let pendingRestore: '/' | '/board' | undefined;
let flightScreen: FlightScreenState | undefined;
let boardScreen: BoardScreenState | undefined;
let navigationGeneration = screenNavigationGeneration();

const historyDrawer = new HistoryDrawer(
  (item: HistoryItem) => {
    const [from, to] = item.route.split('-');
    navigate(`/?${new URLSearchParams({ from: from!, to: to!, date: item.date, price: String(item.price) }).toString()}`);
  },
  () => showAuth(t('session.expired')),
);

function nextScreen(): AbortSignal {
  screen?.abort();
  screen = new AbortController();
  return screen.signal;
}

function routeOf(pathname: string): Route {
  if (pathname === '/board') return '/board';
  if (pathname === '/admin') return '/admin';
  return '/';
}

/**
 * Определяет расстояние от текущей записи до входа на сайт.
 * Аргументов нет; возвращает целое неотрицательное число внутренних переходов текущего поколения.
 * Для прямого адреса, старой или некорректной записи возвращает 0.
 * Читает историю браузера без изменения адреса и без запросов.
 */
function navigationDepth(): number {
  const entry = history.state;
  const depth = entry?.screenDepth;
  return entry?.screenGeneration === navigationGeneration && Number.isSafeInteger(depth)
    && depth > 0 && depth < history.length ? depth : 0;
}

/**
 * Переходит на внутренний адрес и начинает отображение с верха страницы.
 * @param path Обязательный адрес приложения; может содержать параметры конкретного расчёта.
 * @param restore Необязательный маршрут рабочего экрана для восстановления при переходе из шапки.
 * @returns void. Сначала сохраняет уходящий экран, затем добавляет адрес в историю,
 * перерисовывает экран с отменой его прежних операций и прокручивает страницу.
 * Ошибки снимка, истории и синхронного рендера распространяются без отката.
 */
function navigate(path: string, restore?: '/' | '/board') {
  captureScreen?.();
  history.pushState({ screenGeneration: navigationGeneration, screenDepth: navigationDepth() + 1 }, '', path);
  render(restore);
  window.scrollTo({ top: 0 });
}

/**
 * Открывает экран из шапки, передавая сохранённые параметры и результат.
 * @param route Обязательный маршрут из шапки; «Данные» открываются обычным переходом.
 * @returns void. Повторный выбор активного «Рейса» или «Табло» оставляет экран на месте.
 * Остальные переходы меняют историю и DOM через navigate; ошибки распространяются.
 */
function navigateTab(route: Route): void {
  if (route === '/admin') {
    navigate(route);
    return;
  }
  if (route === routeOf(location.pathname)) return;
  navigate(route, route);
}

/**
 * Сбрасывает сохранённые результаты после подтверждённой замены или отката CSV.
 * @param user Обязательный пользователь, от имени которого отправлен запрос. Ответы прежней сессии игнорируются.
 * @returns void. Если рабочий экран уже открыт, сначала сохраняет его текущие параметры.
 * Убирает старые ответы и метаданные из памяти и хранилища вкладки, затем перерисовывает
 * открытый рабочий экран с прежними параметрами. Если экран ещё загружается, повторяет его
 * исходный способ открытия: через сохранённый снимок или по параметрам адреса.
 * Экран «Данные» продолжает свою работу.
 * Ошибки чтения снимка и синхронного рендера распространяются; запросами управляют представления.
 */
function invalidateForecastData(user: User): void {
  if (currentUser !== user) return;
  const route = routeOf(location.pathname);
  const restore = route !== '/admin' && captureScreen ? route : pendingRestore;
  captureScreen?.();

  const flight = flightScreen ?? readScreenState('/', user.id);
  if (flight) {
    flightScreen = { ...flight, meta: undefined, result: null };
    saveScreenState('/', user.id, flightScreen);
  }
  const board = boardScreen ?? readScreenState('/board', user.id);
  if (board) {
    boardScreen = { ...board, result: null };
    saveScreenState('/board', user.id, boardScreen);
  }

  if (route !== '/admin') render(restore);
}

/**
 * Открывает вход и очищает снимки экранов текущего пользователя.
 * @param message Необязательный текст причины завершения сессии; по умолчанию сообщения нет.
 * @returns void. Сбрасывает память навигации и снимки вкладки, закрывает историю и запускает рендер входа.
 * Ошибки DOM распространяются.
 */
function showAuth(message?: string) {
  currentUser = null;
  authMessage = message;
  flightScreen = undefined;
  boardScreen = undefined;
  clearScreenStates();
  historyDrawer.close(false);
  render();
}

/**
 * Завершает работу с текущим экраном при явном выходе из аккаунта.
 * Аргументов нет; возвращает void. Запоминает расстояние до входа на сайт, меняет поколение
 * записей, очищает текущий адрес и показывает вход через showAuth. При наличии внутренних
 * переходов асинхронно возвращает браузер к записи входа на сайт; popstate очищает её параметры.
 * Запрос выхода выполняет шапка до вызова; ошибки истории и DOM распространяются.
 */
function signOut(): void {
  const depth = navigationDepth();
  navigationGeneration = screenNavigationGeneration(navigationGeneration + 1);
  try {
    history.replaceState(null, '', '/');
  } finally {
    showAuth();
  }
  if (depth > 0) history.go(-depth);
}

/**
 * Отмечает запись открытого экрана поколением текущей сессии навигации.
 * Аргументов нет; возвращает void. Для записи завершённой сессии сбрасывает адрес и параметры,
 * а прямую ссылку без отметки сохраняет. Меняет только текущую запись, без запросов.
 * Ошибки History API распространяются.
 */
function syncNavigationEntry(): void {
  const generation = history.state?.screenGeneration;
  if (typeof generation === 'number' && generation !== navigationGeneration) {
    history.replaceState(currentUser ? { screenGeneration: navigationGeneration, screenDepth: 0 } : null, '', '/');
  } else if (currentUser && generation !== navigationGeneration) {
    history.replaceState({ ...history.state, screenGeneration: navigationGeneration, screenDepth: 0 }, '');
  }
}

/**
 * Заменяет активный экран с привязкой его операций к новому сигналу отмены.
 * @param restore Необязательный маршрут рабочего экрана, снимок которого следует передать представлению.
 * Без аргумента представление инициализируется из URL.
 * @returns void. Создаёт каркас, назначает заголовок, запускает отрисовку и регистрирует
 * сохранение будущего снимка рабочего экрана в память страницы и хранилище вкладки.
 * Запоминает способ открытия до завершения инициализации на случай смены данных.
 * «Данные» и вход не сохраняются.
 * Синхронные ошибки DOM распространяются, загрузкой и её ошибками управляют представления.
 */
function render(restore?: '/' | '/board') {
  captureScreen = undefined;
  pendingRestore = restore;
  const signal = nextScreen();
  syncNavigationEntry();
  if (!currentUser) {
    document.title = `${t('auth.tabLogin')} · ${t('app.name')}`;
    renderAuth(
      root,
      (user) => {
        currentUser = user;
        authMessage = undefined;
        render();
      },
      allowRegistration,
      signal,
      authMessage,
    );
    return;
  }
  const route = routeOf(location.pathname);
  const ctx: AppCtx = {
    user: currentUser, signal, onLogout: showAuth, onSignOut: signOut, navigate, navigateTab, history: historyDrawer,
  };
  const setMain = (main: HTMLElement) => {
    if (signal.aborted) return;
    root.replaceChildren(renderShell(ctx, route, main));
  };
  // Пока данные грузятся, каркас уже на месте — без «прыжка» страницы.
  setMain(h('main', { class: 'page', id: 'main' }, h('div', { class: 'boot boot--inline', role: 'status' }, h('span', { class: 'boot__dot' }), t('app.loading'))));
  const titles: Record<Route, string> = { '/': t('nav.flight'), '/board': t('nav.board'), '/admin': t('nav.admin') };
  document.title = `${titles[route]} · ${t('app.name')}`;
  if (route === '/board') {
    void renderBoard(ctx, setMain, {
      restored: restore === route ? boardScreen ?? readScreenState(route, ctx.user.id) : undefined,
      capture: (read) => {
        captureScreen = () => {
          boardScreen = read();
          saveScreenState(route, ctx.user.id, boardScreen);
        };
      },
    });
  } else if (route === '/admin') {
    void renderAdmin(ctx, setMain, () => invalidateForecastData(ctx.user));
  } else {
    void renderCalculator(ctx, setMain, {
      restored: restore === route ? flightScreen ?? readScreenState(route, ctx.user.id) : undefined,
      capture: (read) => {
        captureScreen = () => {
          flightScreen = read();
          saveScreenState(route, ctx.user.id, flightScreen);
        };
      },
    });
  }
}

/**
 * Инициализирует тему, браузерную навигацию и авторизованную сессию.
 * Аргументов нет; возвращает Promise<void> после первого запуска рендера или вывода ошибки.
 * @remarks Подписывается на события страницы, запрашивает пользователя и настройки.
 * При переходе по истории сохраняет уходящий рабочий экран, затем читает новый адрес.
 * На экране входа сбрасывает заголовок перед рендером, чтобы браузер обновил его
 * у восстановленной записи истории даже при уже актуальном значении в документе.
 * При восстановлении документа из кеша браузера сверяет поколение навигации
 * и закрывает экран, если в другом документе этой вкладки произошёл выход.
 * Ошибки запросов показываются в интерфейсе, повтор выполняется при перезагрузке страницы.
 */
async function boot() {
  followSystemTheme();
  window.addEventListener('pageshow', (event) => {
    if (!event.persisted) return;
    const latestGeneration = screenNavigationGeneration();
    if (latestGeneration <= navigationGeneration) return;
    navigationGeneration = latestGeneration;
    showAuth();
  });
  window.addEventListener('popstate', () => {
    captureScreen?.();
    if (!currentUser) document.title = '';
    render();
  });
  document.addEventListener('langchange', () => render());
  try {
    const [{ user }, cfg] = await Promise.all([api.me(), api.authConfig()]);
    allowRegistration = cfg.allowRegistration;
    currentUser = user;
    if (!user) clearScreenStates();
    render();
  } catch (err) {
    root.replaceChildren(h('div', { class: 'boot' }, icon('alert'), h('span', null, err instanceof Error ? err.message : t('app.serverDown'))));
  }
}

trackFocusInput();
void boot();
