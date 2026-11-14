/**
 * Различает указатель и клавиатуру для отображения рамок фокуса.
 * Состояние хранится на корне страницы и сохраняется при перерисовке интерфейса;
 * модуль не снимает фокус, не отменяет события и не выполняет ввод-вывод.
 */

/**
 * Отмечает нажатие мыши, пера или касание как взаимодействие указателем.
 * Аргументов нет; возвращает void. Меняет только data-focus-input у корня документа.
 * Предусловие: документ загружен; исключения DOM не перехватываются.
 */
function usePointerFocus(): void {
  document.documentElement.dataset.focusInput = 'pointer';
}

/**
 * Включает обозначение фокуса при клавиатурной навигации или активации.
 * @param event Обязательное событие KeyboardEvent; поддерживаются Tab, стрелки,
 * Enter, пробел, Home, End, PageUp и PageDown, в том числе с Shift.
 * @returns void; прочие клавиши и сочетания с Ctrl, Alt или Meta игнорируются.
 * @remarks Меняет только data-focus-input; не отменяет стандартное действие.
 * Документ должен быть загружен; исключения DOM передаются вызывающему коду.
 */
function useKeyboardFocus(event: KeyboardEvent): void {
  if (event.ctrlKey || event.altKey || event.metaKey) return;
  if (['Tab', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Enter', ' ', 'Home', 'End', 'PageUp', 'PageDown'].includes(event.key)) {
    document.documentElement.dataset.focusInput = 'keyboard';
  }
}

/**
 * Подключает определение способа взаимодействия на время жизни документа.
 * Аргументов нет; возвращает void. Сначала подписывается на pointerdown, затем
 * на keydown в фазе захвата, до обработчиков контролов и переноса фокуса.
 * Повторный вызов не дублирует слушатели с теми же функциями; удаление документа
 * освобождает их. Начальное состояние оставляет браузерную индикацию фокуса.
 * Требуется доступный document; ошибки регистрации не перехватываются,
 * повторных попыток и отката первой подписки при ошибке второй нет.
 */
export function trackFocusInput(): void {
  document.addEventListener('pointerdown', usePointerFocus, true);
  document.addEventListener('keydown', useKeyboardFocus, true);
}
