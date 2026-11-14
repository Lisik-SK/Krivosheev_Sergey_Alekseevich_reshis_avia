/**
 * Оформляет одиночный select общей панелью сайта, сохраняя исходный элемент
 * источником значений и событий. Сетевых запросов и сохранения данных нет.
 */
import { h } from '../dom';
import { locale } from '../i18n';
import { createPickerPopup } from './picker-popup';

/** Управление отображением списка; ресурсами и внешними слушателями владеет переданный AbortSignal. */
export interface SelectPicker {
  /**
   * Обновляет подпись, доступность и варианты после программного изменения source.
   * Аргументов нет; возвращает void. Меняет DOM, при открытой панели сохраняет
   * активный вариант, если он доступен. После abort ничего не делает;
   * исключения DOM не перехватываются, событий change не создаёт.
   */
  sync(): void;
}

/**
 * Проверяет доступность варианта с учётом видимости и родительской группы.
 * @param option Обязательный HTMLOptionElement из исходного select.
 * @returns true, если вариант скрыт или он либо его optgroup отключены. Побочных эффектов нет.
 * @remarks Не бросает ожидаемых ошибок; вариант может быть отсоединён от DOM.
 */
function isOptionDisabled(option: HTMLOptionElement): boolean {
  return option.hasAttribute('hidden') || option.disabled || (option.parentElement instanceof HTMLOptGroupElement && option.parentElement.disabled);
}

/**
 * Заменяет видимый одиночный select кнопкой и доступным списком вариантов.
 * @param source Обязательный HTMLSelectElement в DOM с уникальным непустым id;
 * должен быть одиночным списком. Его id, name, options и value сохраняются.
 * @param signal Обязательный AbortSignal экрана. После отмены отключает наблюдение;
 * общий popup удаляет свою панель и слушатели, оболочка остаётся частью экрана.
 * @returns Контроллер sync для обновления после присваивания source.value.
 * @throws Error Если source не подключён, не имеет id, является multiple или signal уже отменён.
 * @remarks Сначала скрывает источник и переносит подписи, затем создаёт popup,
 * подключает события и синхронизирует состояние. Выбор меняет source.value,
 * закрывает панель и создаёт одно всплывающее change только при новом значении.
 * Не отменяет Tab и не изменяет данные при просмотре стрелками. Ошибки DOM
 * передаются вызывающему коду без повторов и отката частично созданной оболочки.
 */
export function mountSelectPicker(source: HTMLSelectElement, signal: AbortSignal): SelectPicker {
  if (!source.isConnected || !source.id || source.multiple || signal.aborted) {
    throw new Error('Select picker requires a connected single select with an id and an active signal');
  }

  const labels = [...source.labels];
  const trigger = h('button', {
    type: 'button',
    class: `select picker-trigger${source.classList.contains('input--mono') ? ' input--mono' : ''}`,
    id: `${source.id}-trigger`,
    'data-testid': source.dataset.testid ? `${source.dataset.testid}-trigger` : null,
    role: 'combobox',
    'aria-haspopup': 'listbox',
    'aria-expanded': 'false',
  });
  const field = h('div', { class: 'picker-field' });
  source.before(field);
  field.append(source, trigger);
  source.hidden = true;
  source.tabIndex = -1;
  source.setAttribute('aria-hidden', 'true');
  for (const [index, label] of labels.entries()) {
    label.id ||= `${source.id}-label-${index}`;
    label.htmlFor = trigger.id;
  }
  if (labels.length) trigger.setAttribute('aria-labelledby', labels.map((label) => label.id).join(' '));
  else if (source.getAttribute('aria-label')) trigger.setAttribute('aria-label', source.getAttribute('aria-label')!);

  const popup = createPickerPopup(trigger, signal);
  popup.panel.id = `${source.id}-listbox`;
  popup.panel.classList.add('select-picker');
  popup.panel.setAttribute('role', 'listbox');
  popup.panel.setAttribute('aria-labelledby', labels.length ? labels.map((label) => label.id).join(' ') : trigger.id);
  trigger.setAttribute('aria-controls', popup.panel.id);
  let buttons: HTMLButtonElement[] = [];
  let search = '';
  let searchedAt = 0;

  /**
   * Фокусирует доступный вариант по индексу source.options.
   * @param index Обязательное целое число от 0 до options.length − 1; иные индексы игнорируются.
   * @returns void. Меняет фокус и прокрутку только панели; значения не меняет.
   * @remarks Отключённые варианты игнорируются; ошибки DOM не перехватываются.
   */
  function focusOption(index: number): void {
    const button = buttons[index];
    if (!button || button.disabled) return;
    button.focus({ preventScroll: true });
    button.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }

  /**
   * Строит варианты из текущего source без изменения выбора, сохраняя скрытость служебных вариантов.
   * Аргументов нет; возвращает void. Заменяет DOM списка, сохраняет фокус
   * по индексу доступного варианта, иначе возвращает фокус кнопке списка.
   * Исключения DOM передаются вызывающему коду.
   */
  function renderOptions(): void {
    const focusedIndex = buttons.indexOf(document.activeElement as HTMLButtonElement);
    buttons = [...source.options].map((option, index) => h('button', {
      type: 'button',
      class: `picker-option${option.selected ? ' is-selected' : ''}`,
      id: `${source.id}-option-${index}`,
      role: 'option',
      tabindex: -1,
      hidden: option.hasAttribute('hidden'),
      disabled: isOptionDisabled(option),
      'aria-selected': String(option.selected),
      'data-index': index,
    }, option.label));
    popup.panel.replaceChildren(...buttons);
    if (popup.isOpen() && focusedIndex >= 0) {
      if (buttons[focusedIndex]?.disabled === false) focusOption(focusedIndex);
      else trigger.focus({ preventScroll: true });
    }
  }

  /**
   * Синхронизирует кнопку и список с исходным select, не создавая событий.
   * Аргументов нет; возвращает void. После abort ничего не делает; при disabled
   * закрывает панель без переноса фокуса. Меняет DOM; ошибки DOM не перехватываются.
   */
  function sync(): void {
    if (signal.aborted) return;
    trigger.textContent = source.selectedOptions[0]?.label ?? '';
    trigger.disabled = source.disabled;
    for (const attribute of ['aria-invalid', 'aria-describedby', 'title']) {
      const value = source.getAttribute(attribute);
      if (value === null) trigger.removeAttribute(attribute);
      else trigger.setAttribute(attribute, value);
    }
    if (source.disabled) popup.close(false);
    renderOptions();
  }

  /**
   * Открывает актуальный список и фокусирует выбранный доступный вариант.
   * Аргументов нет; возвращает void. Показывает и список, в котором все варианты отключены.
   * Отключённая кнопка, пустой список и abort игнорируются.
   * Если доступных вариантов нет, фокусирует кнопку списка.
   * Обновляет DOM и фокус без смены значения; ошибки popup и DOM не перехватываются.
   */
  function openList(): void {
    sync();
    if (signal.aborted || trigger.disabled || buttons.length === 0) return;
    popup.open();
    const index = buttons[source.selectedIndex]?.disabled === false
      ? source.selectedIndex
      : buttons.findIndex((button) => !button.disabled);
    if (index >= 0) focusOption(index);
    else trigger.focus({ preventScroll: true });
  }

  /**
   * Подтверждает доступный вариант и уведомляет существующую логику формы.
   * @param index Обязательный целый индекс source.options; отсутствующий или disabled игнорируется.
   * @returns void. Сначала меняет source, закрывает popup с возвратом фокуса,
   * обновляет DOM, затем создаёт ровно одно bubbling change при изменившемся индексе.
   * @remarks Disabled source и abort отклоняются; ошибки обработчиков/DOM не перехватываются.
   */
  function choose(index: number): void {
    const option = source.options[index];
    if (signal.aborted || source.disabled || !option || isOptionDisabled(option)) return;
    const changed = source.selectedIndex !== index;
    source.selectedIndex = index;
    popup.close(true);
    sync();
    if (changed) source.dispatchEvent(new Event('change', { bubbles: true }));
  }

  /**
   * Обрабатывает навигацию и поиск в открытом или закрытом списке.
   * @param event Обязательный KeyboardEvent кнопки либо панели; Alt/Ctrl/Meta и композиция игнорируются.
   * @returns void. Стрелки/Home/End и поиск меняют только фокус; Enter/пробел
   * подтверждают открытый вариант. Tab/Escape оставлены общему popup.
   * @remarks Для обработанных клавиш отменяет стандартное действие, изменяет
   * локальный поисковый префикс (срок 700 мс) и DOM; ошибки DOM не перехватываются.
   */
  function onKeyDown(event: KeyboardEvent): void {
    if (signal.aborted || source.disabled || event.ctrlKey || event.metaKey || event.altKey || event.isComposing) return;
    const key = event.key;
    if (key === 'Enter' || key === ' ') {
      event.preventDefault();
      const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
      if (popup.isOpen() && index >= 0) choose(index);
      else openList();
      return;
    }
    const navigation = ['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(key);
    if (!navigation && key.length !== 1) return;
    event.preventDefault();
    const wasOpen = popup.isOpen();
    if (!wasOpen) openList();
    const available = buttons.map((button, index) => button.disabled ? -1 : index).filter((index) => index >= 0);
    if (!available.length) return;
    const current = buttons.indexOf(document.activeElement as HTMLButtonElement);
    if (navigation) {
      if (key === 'Home') focusOption(available[0]!);
      else if (key === 'End') focusOption(available[available.length - 1]!);
      else if (wasOpen) {
        const position = available.indexOf(current);
        const delta = key === 'ArrowDown' ? 1 : -1;
        focusOption(available[Math.max(0, Math.min(available.length - 1, position + delta))]!);
      }
      return;
    }
    const now = Date.now();
    search = now - searchedAt > 700 ? key : search + key;
    searchedAt = now;
    const prefix = (new Set(search.toLocaleLowerCase(locale())).size === 1 ? key : search).toLocaleLowerCase(locale());
    const ordered = [...available.filter((index) => index > current), ...available.filter((index) => index <= current)];
    const match = ordered.find((index) => source.options[index]!.label.toLocaleLowerCase(locale()).startsWith(prefix)
      || source.options[index]!.value.toLocaleLowerCase(locale()).startsWith(prefix));
    if (match !== undefined) focusOption(match);
  }

  trigger.addEventListener('click', () => popup.isOpen() ? popup.close(true) : openList(), { signal });
  trigger.addEventListener('keydown', onKeyDown, { signal });
  popup.panel.addEventListener('keydown', onKeyDown, { signal });
  popup.panel.addEventListener('click', (event) => {
    const target = event.target instanceof Element ? event.target.closest<HTMLButtonElement>('.picker-option') : null;
    if (target && popup.panel.contains(target)) choose(Number(target.dataset.index));
  }, { signal });
  popup.panel.addEventListener('pickeropen', () => trigger.setAttribute('aria-expanded', 'true'), { signal });
  popup.panel.addEventListener('pickerclose', () => trigger.setAttribute('aria-expanded', 'false'), { signal });
  source.addEventListener('input', sync, { signal });
  source.addEventListener('change', sync, { signal });
  const observer = new MutationObserver(sync);
  observer.observe(source, { childList: true, subtree: true, attributes: true, attributeFilter: ['disabled', 'hidden', 'selected', 'label', 'aria-invalid', 'aria-describedby', 'title'] });
  signal.addEventListener('abort', () => observer.disconnect(), { once: true });
  sync();
  return { sync };
}
