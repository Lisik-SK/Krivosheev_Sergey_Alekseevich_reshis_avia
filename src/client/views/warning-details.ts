/** Общая разметка раскрывающихся замечаний к данным. */
import { h, icon } from '../dom';

/**
 * Создаёт сворачиваемую плашку с информационной иконкой и списком замечаний.
 * @param title Обязательный локализованный заголовок, по которому раскрывается список.
 * @param warnings Непустой список сообщений, которые выводятся как обычный текст.
 * @returns Новый div с закрытым списком. Вызывающий код задаёт отступы и при необходимости роль оповещения.
 * @remarks Создаёт DOM-узлы вне страницы, не выполняет запросов и не меняет данные.
 * Ошибки создания DOM-узлов распространяются вызывающему коду.
 */
export function warningDetails(title: string, warnings: readonly string[]): HTMLDivElement {
  return h(
    'div',
    { class: 'alert alert--warn' },
    icon('info'),
    h('details', null, h('summary', null, title), h('ul', null, ...warnings.map((warning) => h('li', null, warning)))),
  );
}
