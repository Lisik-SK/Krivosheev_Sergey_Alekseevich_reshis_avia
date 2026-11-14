import { api, type User } from '../api';
import { brandMark, h, icon } from '../dom';
import { lang, setLang, t } from '../i18n';
import { themeToggle } from '../theme';
import type { HistoryDrawer } from './history';

/** Внутренние маршруты трёх экранов авторизованного приложения. */
export type Route = '/' | '/board' | '/admin';

/** Сессия, время жизни и операции перехода, доступные авторизованному экрану. */
export interface AppCtx {
  user: User;
  signal: AbortSignal;
  /** Показывает вход при истечении сессии, сохраняя адрес. Сообщение необязательно; возвращает void. */
  onLogout: (message?: string) => void;
  /** Завершает явный выход без аргументов и возвращаемого значения, сбрасывая текущий адрес и состояние экранов. */
  onSignOut: () => void;
  navigate: (path: string) => void;
  /** Принимает маршрут шапки, возвращает void, восстанавливает рабочий экран и меняет историю; ошибки перехода распространяются. */
  navigateTab: (route: Route) => void;
  history: HistoryDrawer;
}

export function toast(message: string, kind: 'success' | 'error' = 'success') {
  document.querySelector('.toast')?.remove();
  const el = h('div', { class: 'toast', role: kind === 'error' ? 'alert' : 'status' }, icon(kind === 'error' ? 'alert' : 'check'), message);
  document.body.append(el);
  setTimeout(() => el.remove(), 3500);
}

function initials(name: string): string {
  const parts = name.trim().split(/\s+/);
  return ((parts[0]?.[0] ?? '') + (parts[1]?.[0] ?? '')).toUpperCase() || '·';
}

export function langToggle(signal?: AbortSignal): HTMLButtonElement {
  const btn = h('button', { type: 'button', class: 'lang-toggle', 'data-testid': 'lang-toggle' });
  const sync = () => {
    const cur = lang();
    btn.replaceChildren(
      h('span', { class: cur === 'ru' ? 'is-on' : '' }, 'RU'),
      h('span', { class: 'lang-toggle__sep', 'aria-hidden': 'true' }, '/'),
      h('span', { class: cur === 'en' ? 'is-on' : '' }, 'EN'),
    );
    btn.setAttribute('aria-label', `RU / EN — ${t('lang.label')}: ${cur.toUpperCase()}. ${t('lang.switch')}`);
    btn.title = t('lang.switch');
  };
  btn.addEventListener('click', () => setLang(lang() === 'ru' ? 'en' : 'ru'));
  document.addEventListener('langchange', sync, signal ? { signal } : undefined);
  sync();
  return btn;
}

/**
 * Собирает шапку, навигацию, основной блок и подвал авторизованного экрана.
 * @param ctx Обязательный контекст пользователя, навигации, истории и сигнала экрана.
 * @param route Обязательный текущий маршрут для отметки активной ссылки.
 * @param main Обязательный основной блок, который переносится в созданный контейнер.
 * @returns Новый контейнер с общим фоном рабочих экранов и обработчиками.
 * Подключение к документу выполняет вызывающий код.
 * @remarks Сборка не делает запросов; при выходе сначала выполняет запрос, затем вызывает
 * сброс экранов и адреса через контекст, в том числе при сетевой ошибке.
 * Ошибки DOM при сборке распространяются.
 */
export function renderShell(ctx: AppCtx, route: Route, main: HTMLElement): HTMLElement {
  const logout = h('button', { type: 'button', class: 'btn btn--ghost btn--sm', 'data-testid': 'logout' }, icon('logout'), h('span', { class: 'hide-sm' }, t('user.logout')));
  logout.setAttribute('aria-label', t('user.logout'));
  logout.addEventListener('click', async () => {
    logout.setAttribute('disabled', '');
    try {
      await api.logout();
    } catch {
      /* даже при ошибке сети выходим из интерфейса */
    }
    ctx.onSignOut();
  });

  /**
   * Создаёт ссылку шапки для обычного и браузерного перехода.
   * @param path Обязательный маршрут экрана.
   * @param label Обязательная локализованная подпись.
   * @param testid Обязательный идентификатор браузерных тестов.
   * @returns Новая ссылка. Обычный клик запускает восстановление через контекст;
   * браузер обрабатывает модифицированные клики. Ошибки DOM распространяются.
   */
  const link = (path: Route, label: string, testid: string) => {
    const a = h('a', { href: path, class: 'nav__link', 'data-testid': testid }, label);
    if (path === route) a.setAttribute('aria-current', 'page');
    a.addEventListener('click', (e) => {
      if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;
      e.preventDefault();
      ctx.navigateTab(path);
    });
    return a;
  };
  const nav = h(
    'nav',
    { class: 'nav', 'aria-label': t('nav.main') },
    link('/', t('nav.flight'), 'nav-flight'),
    link('/board', t('nav.board'), 'nav-board'),
    ctx.user.role === 'admin' ? link('/admin', t('nav.admin'), 'nav-admin') : null,
  );

  const historyBtn = h(
    'button',
    { type: 'button', class: 'btn btn--ghost btn--sm', 'data-testid': 'history-open', 'aria-haspopup': 'dialog' },
    icon('history'),
    h('span', { class: 'hide-sm' }, t('nav.history')),
  );
  historyBtn.setAttribute('aria-label', t('nav.history'));
  historyBtn.addEventListener('click', () => ctx.history.open(historyBtn));

  const wrap = h('div', { class: 'app-shell' });
  wrap.append(
    h(
      'header',
      { class: 'topbar' },
      h(
        'div',
        { class: 'topbar__inner' },
        h('a', { class: 'brand', href: '/', 'aria-label': t('app.name') }, brandMark(), h('span', { class: 'brand__name' }, t('app.name'))),
        nav,
        h('span', { class: 'topbar__spacer' }),
        historyBtn,
        langToggle(ctx.signal),
        themeToggle(ctx.signal),
        h(
          'span',
          { class: 'user-chip', 'data-testid': 'user-chip' },
          h('span', { class: 'user-chip__avatar', 'aria-hidden': 'true' }, initials(ctx.user.name)),
          h(
            'span',
            { class: 'user-chip__name', title: ctx.user.email },
            ctx.user.name,
            ctx.user.role === 'admin' ? h('span', { class: 'user-chip__role' }, t('user.admin')) : null,
          ),
        ),
        logout,
      ),
    ),
    main,
    h('footer', { class: 'footer' }, t('app.author')),
  );
  const brand = wrap.querySelector('.brand') as HTMLAnchorElement;
  brand.addEventListener('click', (e) => {
    e.preventDefault();
    ctx.navigate('/');
  });
  return wrap;
}
