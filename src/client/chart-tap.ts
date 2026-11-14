/**
 * Распознаёт одиночное касание столбца SVG и подавляет повторную активацию мышью,
 * которую браузер может сгенерировать после касания.
 */

/** Допустимое смещение пальца от точки начала касания в CSS-пикселях. */
const TAP_SLOP = 10;

/**
 * Проверяет, остался ли исходный палец в пределах допустимого смещения.
 * @param start Начальная точка Touch или null, если жест отменён либо ещё не начат.
 * @param current Точка Touch из текущего события или null, если она отсутствует.
 * @returns true для того же пальца на расстоянии до TAP_SLOP включительно.
 * @remarks Работает с координатами окна. Побочных эффектов и исключений нет.
 */
function isNearStart(start: Touch | null, current: Touch | null): boolean {
  return start !== null && current !== null && start.identifier === current.identifier
    && Math.hypot(current.clientX - start.clientX, current.clientY - start.clientY) <= TAP_SLOP;
}

/**
 * Подключает распознавание касаний графика к контейнеру и его документу.
 * @param root Контейнер графика, в котором прямоугольники SVG rect.hit обозначают столбцы.
 * Подписка действует и после замены его дочерних узлов.
 * @param onTap Обязательная функция с результатом void, получающая прямоугольник
 * столбца после завершения одиночного касания.
 * @param onOutsideTouch Обязательная функция без аргументов с результатом void,
 * вызываемая при начале одиночного касания вне контейнера.
 * @returns Функция без аргументов с результатом void для снятия всех подписок.
 * Владелец графика должен вызвать её при уничтожении, повторный вызов допустим.
 * @remarks Начало касания отслеживается на документе, чтобы второй палец в любом
 * месте отменял жест. Смещение свыше порога и touchcancel тоже сбрасывают жест.
 * При отпускании пальца внутри исходного столбца сначала отменяется эмуляция мыши,
 * затем вызывается onTap. Прокрутка и масштабирование разрешены. Ошибки DOM
 * и функций обратного вызова не перехватываются.
 */
export function bindChartTap(
  root: HTMLDivElement,
  onTap: (hit: SVGRectElement) => void,
  onOutsideTouch: () => void,
): () => void {
  const doc = root.ownerDocument;
  const listeners = new AbortController();
  const { signal } = listeners;
  let start: Touch | null = null;

  doc.addEventListener('touchstart', (event) => {
    start = null;
    if (event.touches.length !== 1) return;
    if (!event.composedPath().includes(root)) {
      onOutsideTouch();
      return;
    }
    if (event.target instanceof SVGRectElement && event.target.matches('.hit')) start = event.changedTouches.item(0);
  }, { capture: true, passive: true, signal });

  root.addEventListener('touchmove', (event) => {
    if (event.touches.length !== 1 || !isNearStart(start, event.touches.item(0))) start = null;
  }, { passive: true, signal });

  root.addEventListener('touchcancel', () => {
    start = null;
  }, { signal });

  root.addEventListener('touchend', (event) => {
    const end = event.changedTouches.item(0);
    const touch = start;
    start = null;
    const hit = touch?.target;
    if (!event.cancelable || event.touches.length !== 0 || !end || !isNearStart(touch, end)) return;
    if (!(hit instanceof SVGRectElement) || doc.elementFromPoint(end.clientX, end.clientY) !== hit) return;
    event.preventDefault();
    onTap(hit);
  }, { passive: false, signal });

  return () => listeners.abort();
}
