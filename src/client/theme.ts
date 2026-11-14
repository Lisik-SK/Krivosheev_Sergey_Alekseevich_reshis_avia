import { h, icon } from './dom';
import { t } from './i18n';

export type Theme = 'light' | 'dark';
const KEY = 'ra-theme';

export function currentTheme(): Theme {
  return document.documentElement.getAttribute('data-theme') === 'dark' ? 'dark' : 'light';
}

/**
 * Применяет тему страницы и синхронизирует значок вкладки.
 * @param theme Обязательная тема, светлая или тёмная.
 * @param persist Необязательный флаг записи в локальное хранилище, по умолчанию true.
 * @returns Ничего не возвращает.
 * @remarks Обновляет DOM, затем при необходимости сохраняет выбор и всегда посылает событие themechange.
 * Браузер загружает значок при смене его адреса. При отсутствии ссылки обновляется только тема.
 * Ошибки локального хранилища игнорируются, ошибки DOM распространяются.
 */
export function setTheme(theme: Theme, persist = true): void {
  document.documentElement.setAttribute('data-theme', theme);
  document.querySelector('link[rel="icon"]')
    ?.setAttribute('href', theme === 'dark' ? '/favicon-dark.svg' : '/favicon.svg?v=forecast');
  if (persist) {
    try {
      localStorage.setItem(KEY, theme);
    } catch {
      /* приватный режим — тема просто не запомнится */
    }
  }
  document.dispatchEvent(new CustomEvent('themechange', { detail: theme }));
}

/** Пока пользователь сам не выбрал тему, следуем системной. */
export function followSystemTheme() {
  const mq = window.matchMedia?.('(prefers-color-scheme: dark)');
  mq?.addEventListener?.('change', (e) => {
    let saved: string | null = null;
    try {
      saved = localStorage.getItem(KEY);
    } catch {
      /* ignore */
    }
    if (saved !== 'light' && saved !== 'dark') setTheme(e.matches ? 'dark' : 'light', false);
  });
}

export function themeToggle(signal?: AbortSignal): HTMLButtonElement {
  const btn = h(
    'button',
    { type: 'button', class: 'theme-toggle', role: 'switch', 'data-testid': 'theme-toggle' },
    h('span', { class: 'theme-toggle__knob', 'aria-hidden': 'true' }),
    h('span', { class: 'theme-toggle__icon theme-toggle__icon--sun' }, icon('sun')),
    h('span', { class: 'theme-toggle__icon theme-toggle__icon--moon' }, icon('moon')),
  );
  const sync = () => {
    const dark = currentTheme() === 'dark';
    btn.setAttribute('aria-checked', String(dark));
    btn.setAttribute('aria-label', t('theme.dark'));
    btn.title = dark ? t('theme.toLight') : t('theme.toDark');
  };
  btn.addEventListener('click', () => {
    setTheme(currentTheme() === 'dark' ? 'light' : 'dark');
  });
  document.addEventListener('themechange', sync, signal ? { signal } : undefined);
  sync();
  return btn;
}
