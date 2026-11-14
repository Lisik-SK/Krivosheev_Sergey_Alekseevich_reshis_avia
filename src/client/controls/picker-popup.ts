/** Общая всплывающая панель полей: позиционирование, закрытие и жизненный цикл без сетевых запросов. */

/** Управляет одной панелью; владелец заполняет panel и задаёт доступное имя и роль. */
export interface PickerPopup {
  /** Контейнер в body; после отмены сигнала удалён из документа. */
  readonly panel: HTMLDivElement;
  /** Открывает панель, закрывает остальные и посылает pickeropen; аргументов и результата нет. */
  open(): void;
  /** Закрывает панель; restoreFocus по умолчанию false, при true возвращает фокус триггеру; возвращает void. */
  close(restoreFocus?: boolean): void;
  /** Меняет открытое состояние; при закрытии возвращает фокус; аргументов и результата нет. */
  toggle(): void;
  /** Без аргументов возвращает true только для открытой панели; состояние не меняет. */
  isOpen(): boolean;
}

/**
 * Создаёт панель и обработчики закрытия, затем привязывает очистку к сигналу экрана.
 * @param trigger Обязательный подключённый HTMLElement, относительно которого располагается панель.
 * @param signal Обязательный AbortSignal; отмена удаляет панель и все внешние слушатели.
 * @returns PickerPopup с закрытой panel в body; при уже отменённом сигнале панель не подключается.
 * @remarks Вызывает синхронные pickeropen/pickerclose на panel. Перед открытием другой панели
 * закрывает предыдущую без переноса фокуса. Escape возвращает фокус; Tab продолжает штатный обход.
 * Меняет DOM, атрибут aria-expanded и положение фокуса; не отменяет клики и не блокирует прокрутку.
 * ResizeObserver следит за высотой содержимого и освобождается при отмене сигнала.
 * Требуется document.body. Ошибки DOM распространяются без повторов и отката частичных изменений.
 */
export function createPickerPopup(trigger: HTMLElement, signal: AbortSignal): PickerPopup {
  const panel = document.createElement('div');
  panel.className = 'picker-popup';
  panel.hidden = true;
  if (!signal.aborted) document.body.append(panel);

  /** Без аргументов размещает открытую панель в пределах окна; возвращает void, меняет inline-стили, ошибки DOM не перехватывает. */
  function position(): void {
    if (panel.hidden || !trigger.isConnected) return;
    const rect = (trigger.closest('.date-field') ?? trigger).getBoundingClientRect();
    const margin = 12;
    const gap = 8;
    const width = Math.min(window.innerWidth - margin * 2, Math.max(rect.width, panel.classList.contains('date-picker') ? 288 : 220));
    const below = window.innerHeight - rect.bottom - gap - margin;
    const above = rect.top - gap - margin;
    panel.style.width = `${Math.max(0, width)}px`;
    panel.style.maxHeight = `${Math.max(80, Math.min(360, Math.max(below, above)))}px`;
    const height = panel.getBoundingClientRect().height;
    const top = below >= height || below >= above ? rect.bottom + gap : rect.top - gap - height;
    panel.style.left = `${Math.max(margin, Math.min(rect.left, window.innerWidth - width - margin))}px`;
    panel.style.top = `${Math.max(margin, Math.min(top, window.innerHeight - height - margin))}px`;
  }

  /**
   * Закрывает открытую панель и сообщает владельцу pickerclose; иначе ничего не делает.
   * @param restoreFocus Необязательный boolean, по умолчанию false; true фокусирует подключённый триггер без прокрутки.
   * @returns void. Меняет DOM/фокус; ошибки DOM не перехватываются, источники данных не изменяются.
   */
  function close(restoreFocus = false): void {
    if (panel.hidden) return;
    panel.hidden = true;
    trigger.setAttribute('aria-expanded', 'false');
    if (restoreFocus && trigger.isConnected) trigger.focus({ preventScroll: true });
    panel.dispatchEvent(new Event('pickerclose'));
  }

  /** Без аргументов открывает доступный триггер и позиционирует панель после pickeropen; возвращает void; DOM-ошибки не перехватываются. */
  function open(): void {
    if (signal.aborted || !trigger.isConnected || trigger.matches(':disabled') || !panel.hidden) return;
    panel.hidden = false;
    trigger.setAttribute('aria-expanded', 'true');
    panel.dispatchEvent(new Event('pickeropen', { bubbles: true }));
    position();
  }

  /** Переключает состояние без аргументов; возвращает void; наследует эффекты и ошибки open/close. */
  function toggle(): void {
    if (panel.hidden) open();
    else close(true);
  }

  /** Без аргументов и эффектов возвращает boolean открытого состояния; исключений не создаёт. */
  function isOpen(): boolean {
    return !panel.hidden;
  }

  /** @param event Обязательное событие открытия панели. @returns void; закрывает текущую при открытии другой, DOM-ошибки распространяются. */
  function onOtherOpen(event: Event): void {
    if (event.target !== panel) close();
  }

  /** @param event Обязательное событие указателя или фокуса. @returns void; закрывает панель при переходе наружу, не мешая стандартному событию. */
  function onOutside(event: Event): void {
    if (event.target instanceof Node && !panel.contains(event.target) && !trigger.contains(event.target)) close();
  }

  /** @param event Обязательный KeyboardEvent. @returns void; Escape отменяет действие и закрывает панель, Tab восстанавливает исходную точку обхода без отмены перехода. */
  function onKey(event: KeyboardEvent): void {
    if (panel.hidden) return;
    if (event.key === 'Escape') {
      event.preventDefault();
      close(true);
    } else if (event.key === 'Tab') close(true);
  }

  /** @param event Обязательное событие прокрутки. @returns void; перемещает панель при внешней прокрутке, собственный список прокручивается независимо. */
  function onScroll(event: Event): void {
    if (!(event.target instanceof Node) || !panel.contains(event.target)) position();
  }

  /** Без аргументов закрывает и удаляет панель; возвращает void, фокус не переносит, ошибки DOM распространяются. */
  function dispose(): void {
    close();
    observer.disconnect();
    panel.remove();
  }

  // Изменение месяца или списка может менять высоту уже открытой панели.
  const observer = new ResizeObserver(position);
  if (!signal.aborted) observer.observe(panel);
  document.addEventListener('pickeropen', onOtherOpen, { signal });
  document.addEventListener('pointerdown', onOutside, { capture: true, signal });
  document.addEventListener('focusin', onOutside, { signal });
  document.addEventListener('keydown', onKey, { capture: true, signal });
  window.addEventListener('resize', position, { signal });
  document.addEventListener('scroll', onScroll, { capture: true, passive: true, signal });
  signal.addEventListener('abort', dispose, { once: true });
  return { panel, open, close, toggle, isOpen };
}
