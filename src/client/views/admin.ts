/**
 * Загрузка прогноза через интерфейс (дополнение 6), только для администратора.
 * Файл сначала проверяется на сервере без записи: показываем сводку и разницу
 * с текущими данными. Замена — отдельным подтверждением, прежняя версия
 * сохраняется и её можно вернуть одной кнопкой.
 */
import { api, ApiError, type AdminData, type UploadResponse } from '../api';
import { h, icon } from '../dom';
import { fmtDateShort, fmtDateTime, fmtInt, fmtNum } from '../format';
import { t } from '../i18n';
import { toast, type AppCtx } from './shell';
import { warningDetails } from './warning-details';

type Kind = 'forecast' | 'routes';

/**
 * Создаёт экран управления CSV и подключает проверку, применение и откат версий.
 * @param ctx Обязательный контекст пользователя и сигнал времени жизни экрана.
 * @param setMain Обязательный обработчик подключения основного элемента страницы.
 * @param onDataChanged Обязательный обработчик без аргументов, вызывается после успешного применения
 * или отката, в том числе если администратор ушёл с экрана до ответа сервера.
 * @returns Promise<void> после загрузки сведений о файлах или показа ошибки доступа.
 * @remarks Читает файлы из формы, отправляет запросы по действиям пользователя и обновляет DOM.
 * Ошибки запросов отображаются на экране, ответ после ухода может только известить о смене данных.
 */
export async function renderAdmin(ctx: AppCtx, setMain: (main: HTMLElement) => void, onDataChanged: () => void) {
  if (ctx.user.role !== 'admin') {
    setMain(h('main', { class: 'page', id: 'main' }, h('div', { class: 'card' }, h('div', { class: 'empty' }, icon('alert', 'empty__icon'), h('p', null, t('a.forbidden'))))));
    return;
  }

  let info: AdminData | null = null;
  let kind: Kind = 'forecast';
  let pending: { name: string; content: string } | null = null;

  const current = h('div', { class: 'card__body', 'data-testid': 'admin-current' });
  const kindForecast = h('input', { type: 'radio', name: 'kind', value: 'forecast', id: 'k-forecast', checked: true });
  const kindRoutes = h('input', { type: 'radio', name: 'kind', value: 'routes', id: 'k-routes' });
  const fileInput = h('input', { type: 'file', accept: '.csv,text/csv,text/plain', class: 'sr-only', id: 'a-file', 'data-testid': 'admin-file' });
  const maxNote = h('p', { class: 'field__hint' });
  const drop = h(
    'label',
    { class: 'dropzone', for: 'a-file', 'data-testid': 'admin-drop' },
    icon('upload', 'dropzone__icon'),
    h('span', { class: 'dropzone__title' }, t('a.drop')),
    h('span', { class: 'btn btn--ghost btn--sm' }, t('a.choose')),
  );
  const preview = h('div', { 'data-testid': 'admin-preview', 'aria-live': 'polite' });

  const page = h(
    'main',
    { class: 'page', id: 'main' },
    h('div', { class: 'page__head' }, h('div', null, h('h1', { class: 'page__title' }, t('a.title')), h('p', { class: 'page__lead' }, t('a.lead')))),
    h(
      'div',
      { class: 'stack' },
      h('section', { class: 'card', 'aria-labelledby': 'a-current' }, h('div', { class: 'card__head' }, h('h2', { class: 'card__title', id: 'a-current' }, t('a.current'))), current),
      h(
        'section',
        { class: 'card', 'aria-label': t('a.kind') },
        h(
          'div',
          { class: 'card__body stack' },
          h(
            'fieldset',
            { class: 'radio-group' },
            h('legend', { class: 'label' }, t('a.kind')),
            h('label', { class: 'radio', for: 'k-forecast' }, kindForecast, t('a.kindForecast')),
            h('label', { class: 'radio', for: 'k-routes' }, kindRoutes, t('a.kindRoutes')),
          ),
          h('div', null, fileInput, drop, maxNote),
          preview,
        ),
      ),
    ),
  );
  setMain(page);

  /**
   * Загружает сведения о текущих CSV и обновляет список файлов с действиями загрузки и отката.
   * Аргументов нет. Возвращает Promise<void> после обновления, показа ошибки или выхода по сигналу ухода.
   * @remarks Выполняет запрос чтения. При ответе 401 завершает сеанс, прочие ошибки выводит в интерфейсе.
   * После успешного ответа проверяет сигнал экрана и только затем обновляет DOM и подключает обработчики.
   * Откат выполняется отдельным запросом при нажатии кнопки и повторно загружает сведения после успеха.
   */
  async function loadInfo() {
    try {
      info = await api.adminData();
      if (ctx.signal.aborted) return;
      maxNote.textContent = t('a.maxSize', { mb: info.uploadMaxMb });
      const src = info.data.source;
      const row = (label: string, file: { name: string; size: number; modifiedAt: string } | undefined, k: Kind) => {
        const download = file ? h(
          'a',
          {
            class: 'btn btn--ghost btn--sm', href: `/api/admin/download/${k}`, download: file.name,
            'aria-label': t(k === 'forecast' ? 'a.downloadForecast' : 'a.downloadRoutes'),
            'data-testid': `download-${k}`,
          },
          icon('download'),
          t('a.download'),
        ) : null;
        const restore = h('button', { type: 'button', class: 'btn btn--ghost btn--sm', 'data-testid': `restore-${k}` }, icon('undo'), t('a.restore'));
        restore.addEventListener('click', async () => {
          restore.setAttribute('disabled', '');
          try {
            await api.restore(k);
            onDataChanged();
            if (ctx.signal.aborted) return;
            toast(t('a.restored'));
            await loadInfo();
          } catch (err) {
            preview.replaceChildren(errorBox(err));
          } finally {
            restore.removeAttribute('disabled');
          }
        });
        return h(
          'div',
          { class: 'file-row' },
          h('span', { class: 'label' }, label),
          h('span', { class: 'mono' }, file?.name ?? '—'),
          h('span', { class: 'file-row__meta' }, file ? `${fmtNum(Math.max(0.1, file.size / 1024))} KB · ${t('a.modified')} ${fmtDateTime(file.modifiedAt)}` : ''),
          h('div', { class: 'file-row__actions' }, download, info!.backups[k] ? restore : null),
        );
      };
      current.replaceChildren(
        row(t('a.forecast'), src?.forecast, 'forecast'),
        row(t('a.routes'), src?.routes, 'routes'),
        h('p', { class: 'field__hint' }, `${t('data.flights', { n: info.data.flights })}, ${t('data.routes', { n: info.data.routes })}`),
      );
      if (info.data.error) current.append(h('div', { class: 'alert alert--warn' }, icon('info'), h('p', null, info.data.error)));
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) return ctx.onLogout(t('session.expired'));
      current.replaceChildren(errorBox(err));
    }
  }

  function errorBox(err: unknown) {
    return h('div', { class: 'alert alert--error', role: 'alert' }, icon('alert'), h('p', null, err instanceof Error ? err.message : t('error.generic')));
  }

  async function check(file: File) {
    if (info && file.size > info.uploadMaxMb * 1024 * 1024) {
      preview.replaceChildren(errorBox(new Error(t('a.maxSize', { mb: info.uploadMaxMb }))));
      return;
    }
    let content: string;
    try {
      content = await file.text();
    } catch {
      preview.replaceChildren(errorBox(new Error(t('a.readError'))));
      return;
    }
    pending = { name: file.name, content };
    preview.replaceChildren(h('p', { class: 'field__hint' }, t('a.checking')));
    try {
      const res = await api.upload(kind, file.name, content, false);
      renderPreview(res);
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) return ctx.onLogout(t('session.expired'));
      preview.replaceChildren(errorBox(err));
    }
  }

  /**
   * Показывает результат проверки загруженного файла.
   * @param res Обязательный ответ проверки; при успехе содержит сводку и может содержать замечания и разницу данных.
   * @returns void. Заменяет предпросмотр ошибкой или сводкой со сворачиваемыми замечаниями и действиями.
   * @remarks Сам рендер меняет только DOM. Кнопки позволяют очистить предпросмотр или применить
   * подготовленный файл. Применение выполняет запрос и показывает ошибку в предпросмотре.
   * Ошибки создания разметки распространяются.
   */
  function renderPreview(res: UploadResponse) {
    if (!res.ok || !res.summary) {
      preview.replaceChildren(
        h('div', { class: 'alert alert--error', role: 'alert', 'data-testid': 'admin-invalid' }, icon('alert'), h('div', null, h('strong', null, t('a.invalid')), h('p', null, res.error ?? ''))),
      );
      return;
    }
    const sm = res.summary;
    const nodes: Node[] = [
      h(
        'div',
        { class: 'alert', 'data-testid': 'admin-valid' },
        icon('check'),
        h(
          'div',
          null,
          h('strong', null, `${t('a.valid')}: ${pending?.name ?? ''}`),
          h(
            'p',
            null,
            t('a.summary', {
              flights: t('data.flights', { n: sm.flights }),
              routes: t('data.routes', { n: sm.routes.length }),
              from: sm.dateFrom ? fmtDateShort(sm.dateFrom) : '—',
              to: sm.dateTo ? fmtDateShort(sm.dateTo) : '—',
              q: sm.quantileLevels.join(', '),
            }),
          ),
        ),
      ),
    ];
    if (res.warnings?.length) {
      const warning = warningDetails(`${t('a.warnings')}: ${res.warnings.length}`, res.warnings);
      warning.classList.add('admin-warnings');
      nodes.push(warning);
    }
    if (res.diff) {
      const d = res.diff;
      const tbody = h('tbody');
      for (const r of d.perRoute) {
        const delta = r.deltaPct;
        tbody.append(
          h(
            'tr',
            null,
            h('td', { class: 'mono' }, r.route),
            h('td', null, r.before === null ? '—' : fmtNum(r.before)),
            h('td', null, r.after === null ? '—' : fmtNum(r.after)),
            h('td', { class: delta === null || delta === 0 ? '' : delta > 0 ? 'is-up' : 'is-down' }, delta === null ? '—' : `${delta > 0 ? '+' : delta < 0 ? '−' : ''}${fmtNum(Math.abs(delta))} %`),
          ),
        );
      }
      const list: Node[] = [];
      if (d.changedFlights || !d.removedFlights) list.push(h('li', null, t('a.changed', { n: d.changedFlights })));
      if (d.removedFlights) list.push(h('li', null, t('a.removedFlights', { n: d.removedFlights })));
      if (d.addedRoutes.length) list.push(h('li', null, `${t('a.added')}: ${d.addedRoutes.join(', ')}`));
      if (d.removedRoutes.length) list.push(h('li', null, `${t('a.removed')}: ${d.removedRoutes.join(', ')}`));
      nodes.push(
        h('h3', { class: 'label' }, t('a.diff')),
        h('ul', { class: 'diff-list', 'data-testid': 'admin-diff' }, ...list),
        h(
          'div',
          { class: 'table-wrap', tabindex: 0, role: 'region', 'aria-label': t('t.scrollable') },
          h(
            'table',
            { class: 'table' },
            h('thead', null, h('tr', null, h('th', { scope: 'col' }, t('a.route')), h('th', { scope: 'col' }, t('a.before')), h('th', { scope: 'col' }, t('a.after')), h('th', { scope: 'col' }, t('a.delta')))),
            tbody,
          ),
        ),
      );
    }
    const apply = h('button', { type: 'button', class: 'btn', 'data-testid': 'admin-apply' }, t('a.apply'));
    const cancel = h('button', { type: 'button', class: 'btn btn--ghost' }, t('a.cancel'));
    cancel.addEventListener('click', () => {
      pending = null;
      fileInput.value = '';
      preview.replaceChildren();
    });
    apply.addEventListener('click', async () => {
      if (!pending) return;
      const appliedKind = kind;
      apply.setAttribute('disabled', '');
      apply.textContent = t('a.applying');
      try {
        const done = await api.upload(appliedKind, pending.name, pending.content, true);
        if (done.applied) onDataChanged();
        if (ctx.signal.aborted) return;
        if (!done.ok) return renderPreview(done);
        pending = null;
        fileInput.value = '';
        const routesApplied = appliedKind === 'routes';
        preview.replaceChildren(h('div', { class: 'alert', role: 'status', 'data-testid': 'admin-applied' }, icon('check'), h('p', null, t(routesApplied ? 'a.routesApplied' : 'a.applied'))));
        toast(t(routesApplied ? 'toast.routesUpdated' : 'toast.newData'));
        await loadInfo();
      } catch (err) {
        preview.replaceChildren(errorBox(err));
      }
    });
    nodes.push(h('div', { class: 'actions' }, apply, cancel));
    preview.replaceChildren(...nodes);
  }

  for (const r of [kindForecast, kindRoutes]) {
    r.addEventListener('change', () => {
      kind = kindRoutes.checked ? 'routes' : 'forecast';
      if (pending) void check(new File([pending.content], pending.name));
    });
  }
  fileInput.addEventListener('change', () => {
    const f = fileInput.files?.[0];
    if (f) void check(f);
  });
  for (const ev of ['dragenter', 'dragover'] as const) {
    drop.addEventListener(ev, (e) => {
      e.preventDefault();
      drop.classList.add('is-over');
    });
  }
  for (const ev of ['dragleave', 'drop'] as const) {
    drop.addEventListener(ev, () => drop.classList.remove('is-over'));
  }
  drop.addEventListener('drop', (e) => {
    e.preventDefault();
    const f = (e as DragEvent).dataTransfer?.files?.[0];
    if (f) void check(f);
  });

  await loadInfo();
}
