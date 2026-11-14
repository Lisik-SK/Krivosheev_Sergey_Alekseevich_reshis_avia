/**
 * История расчётов (дополнение 5): боковая панель со списком последних
 * расчётов пользователя. Закреплённые записи всегда наверху.
 */
import { api, ApiError, type HistoryItem } from '../api';
import { h, icon } from '../dom';
import { fmtDateShort, fmtDateTime, fmtNum, fmtPrice } from '../format';
import { cityName, t } from '../i18n';
import { toast } from './shell';

type HistoryQuery = Parameters<typeof api.saveHistory>[0];

export class HistoryDrawer {
  private items: HistoryItem[] = [];
  private dialog: HTMLDivElement | null = null;
  private list: HTMLDivElement | null = null;
  private returnFocus: HTMLElement | null = null;
  private keys: AbortController | null = null;
  private pendingSave: { query: HistoryQuery; timer: ReturnType<typeof setTimeout> } | null = null;
  private mutations = Promise.resolve();
  private clearing = false;
  private clearVersion = 0;

  constructor(
    private readonly onOpenItem: (item: HistoryItem) => void,
    private readonly onUnauthorized: () => void,
  ) {}

  /** Новый список после сохранения расчёта (если панель открыта — перерисовываем). */
  setItems(items: HistoryItem[]) {
    this.items = items;
    this.renderList();
  }

  scheduleSave(query: HistoryQuery) {
    if (this.clearing) return;
    this.cancelPendingSave();
    const timer = setTimeout(() => {
      this.pendingSave = null;
      void this.updateItems(() => api.saveHistory(query));
    }, 1500);
    this.pendingSave = { query, timer };
  }

  cancelPendingSave() {
    if (!this.pendingSave) return;
    clearTimeout(this.pendingSave.timer);
    this.pendingSave = null;
  }

  private updateItems(change: () => Promise<{ items: HistoryItem[] }>): Promise<void> {
    const action = this.mutations.then(change).then(({ items }) => this.setItems(items));
    this.mutations = action.catch(() => {});
    return action;
  }

  private async clearHistory(mode: 'all' | 'unpinned') {
    if (this.clearing) return;
    const dialog = this.dialog;
    this.clearing = true;
    this.clearVersion += 1;
    this.cancelPendingSave();
    this.renderList();
    dialog?.querySelector<HTMLElement>('[data-testid="history-close"]')?.focus();
    try {
      await this.updateItems(() => api.clearHistory(mode));
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) this.onUnauthorized();
      else toast(t('h.clearFailed'), 'error');
    } finally {
      this.clearing = false;
      this.renderList();
    }
  }

  async open(from?: HTMLElement) {
    this.returnFocus = from ?? (document.activeElement as HTMLElement | null);
    this.close(false);
    const closeBtn = h('button', { type: 'button', class: 'icon-btn', 'aria-label': t('h.close'), 'data-testid': 'history-close' }, icon('close'));
    closeBtn.addEventListener('click', () => this.close());
    this.list = h('div', { class: 'drawer__body', 'data-testid': 'history-list' });
    const panel = h(
      'div',
      { class: 'drawer__panel', role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': 'history-title' },
      h('div', { class: 'drawer__head' }, h('h2', { class: 'card__title', id: 'history-title' }, t('h.title')), closeBtn),
      this.list,
    );
    const backdrop = h('div', { class: 'drawer__backdrop' });
    backdrop.addEventListener('click', () => this.close());
    this.dialog = h('div', { class: 'drawer', 'data-testid': 'history-drawer' }, backdrop, panel);
    // Клавиши слушаем на документе: после удаления записи фокус может оказаться на body.
    this.keys = new AbortController();
    document.addEventListener('keydown', (e) => {
      if (!this.dialog) return;
      if (e.key === 'Escape') {
        e.preventDefault();
        this.close();
      } else if (e.key === 'Tab') {
        // Фокус не выходит за пределы панели.
        const focusables = [...panel.querySelectorAll<HTMLElement>('button, a[href]')].filter((el) => !el.hasAttribute('disabled'));
        const first = focusables[0];
        const last = focusables[focusables.length - 1];
        if (!first || !last) return;
        if (e.shiftKey && document.activeElement === first) {
          e.preventDefault();
          last.focus();
        } else if (!e.shiftKey && document.activeElement === last) {
          e.preventDefault();
          first.focus();
        }
      }
    }, { signal: this.keys.signal });
    document.body.append(this.dialog);
    document.body.classList.add('has-drawer');
    closeBtn.focus();
    this.renderList();
    try {
      const version = this.clearVersion;
      await this.mutations;
      const { items } = await api.history();
      if (version === this.clearVersion) this.setItems(items);
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) this.onUnauthorized();
    }
  }

  close(restoreFocus = true) {
    if (!this.dialog) return;
    this.dialog.remove();
    this.dialog = null;
    this.keys?.abort();
    this.keys = null;
    this.list = null;
    document.body.classList.remove('has-drawer');
    if (restoreFocus) this.returnFocus?.focus();
  }

  private renderList() {
    const list = this.list;
    if (!list) return;
    if (!this.items.length) {
      list.replaceChildren(h('p', { class: 'drawer__empty' }, t('h.empty')));
      return;
    }
    const pinned = this.items.filter((i) => i.pinned);
    const recent = this.items.filter((i) => !i.pinned);
    const clearAll = h('button', {
      type: 'button', class: 'btn btn--ghost btn--sm', disabled: this.clearing, 'data-testid': 'history-clear-all',
    }, t('h.clearAll'));
    const clearUnpinned = h('button', {
      type: 'button', class: 'btn btn--ghost btn--sm', disabled: this.clearing || recent.length === 0,
      'data-testid': 'history-clear-unpinned',
    }, t('h.clearUnpinned'));
    clearAll.addEventListener('click', () => void this.clearHistory('all'));
    clearUnpinned.addEventListener('click', () => void this.clearHistory('unpinned'));
    const section = (title: string, items: HistoryItem[]) =>
      items.length ? [h('h3', { class: 'label drawer__section' }, title), h('ul', { class: 'hist' }, ...items.map((i) => this.row(i)))] : [];
    list.replaceChildren(
      h('div', { class: 'hist__bulk', 'aria-busy': String(this.clearing) }, clearAll, clearUnpinned),
      ...section(t('h.pinned'), pinned),
      ...section(t('h.recent'), recent),
    );
  }

  private row(item: HistoryItem) {
    const open = h(
      'button',
      { type: 'button', class: 'hist__main', disabled: this.clearing, 'data-testid': 'history-item' },
      h('span', { class: 'hist__route mono' }, `${item.from.code} → ${item.to.code}`),
      h('span', { class: 'hist__meta' }, `${fmtDateShort(item.date)} · ${fmtPrice(item.price)}`),
      h('span', { class: 'hist__result' }, t('h.result', { sales: fmtNum(item.sales), seats: fmtNum(item.seats) })),
      h('span', { class: 'hist__time' }, fmtDateTime(item.createdAt)),
    );
    open.setAttribute('aria-label', `${t('h.open')}: ${cityName(item.from)} → ${cityName(item.to)}, ${fmtDateShort(item.date)}, ${fmtPrice(item.price)}`);
    open.addEventListener('click', () => {
      this.close(false);
      this.onOpenItem(item);
    });
    const pin = h(
      'button',
      {
        type: 'button',
        class: 'icon-btn icon-btn--plain' + (item.pinned ? ' is-on' : ''),
        disabled: this.clearing,
        'aria-pressed': String(item.pinned),
        'aria-label': item.pinned ? t('h.unpin') : t('h.pin'),
        title: item.pinned ? t('h.unpin') : t('h.pin'),
        'data-testid': 'history-pin',
      },
      icon('star'),
    );
    pin.addEventListener('click', async () => {
      try {
        await this.updateItems(() => api.pinHistory(item.id, !item.pinned));
        this.list?.querySelector<HTMLElement>(`[data-id="${item.id}"] [data-testid=history-pin]`)?.focus();
      } catch (err) {
        if (err instanceof ApiError && err.status === 401) this.onUnauthorized();
      }
    });
    const del = h(
      'button',
      { type: 'button', class: 'icon-btn icon-btn--plain', disabled: this.clearing, 'aria-label': t('h.delete'), title: t('h.delete'), 'data-testid': 'history-delete' },
      icon('trash'),
    );
    del.addEventListener('click', async () => {
      try {
        const pending = this.pendingSave?.query;
        if (pending?.from === item.from.code && pending.to === item.to.code && pending.date === item.date && pending.price === item.price) {
          this.cancelPendingSave();
        }
        await this.updateItems(() => api.deleteHistory(item.id));
        (this.list?.querySelector<HTMLElement>('[data-testid=history-item]') ?? this.dialog?.querySelector<HTMLElement>('[data-testid=history-close]'))?.focus();
      } catch (err) {
        if (err instanceof ApiError && err.status === 401) this.onUnauthorized();
      }
    });
    return h('li', { class: 'hist__item', 'data-id': item.id }, open, h('span', { class: 'hist__actions' }, pin, del));
  }
}
