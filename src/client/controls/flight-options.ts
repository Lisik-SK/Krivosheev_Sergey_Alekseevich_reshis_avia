/** Вычисляет доступные города и дни для частично заполненной формы прогноза. */
import type { RouteMeta } from '../api';

/**
 * Собирает дни прогноза для текущего выбора городов.
 * @param routes Обязательный справочник направлений с датами в формате YYYY-MM-DD, может быть пустым.
 * @param from Код города отправления либо пустая строка для любого города.
 * @param to Код города назначения либо пустая строка для любого города.
 * @returns Новый отсортированный список уникальных дат. При отсутствии совпадений возвращает пустой список.
 * @remarks Не меняет справочник и не обращается к внешним ресурсам. Ошибок для корректного справочника нет.
 */
export function flightDates(routes: readonly RouteMeta[], from: string, to: string): string[] {
  const dates = new Set<string>();
  for (const route of routes) {
    if (from && route.origin.code !== from) continue;
    if (to && route.destination.code !== to) continue;
    for (const date of route.dates) dates.add(date);
  }
  return [...dates].sort();
}

/**
 * Определяет, какие города можно выбрать с учётом остальных полей формы.
 * @param routes Обязательный справочник направлений с датами в формате YYYY-MM-DD, может быть пустым.
 * @param from Код выбранного города отправления либо пустая строка.
 * @param to Код выбранного города назначения либо пустая строка.
 * @param date Дата вылета в формате YYYY-MM-DD либо пустая строка для поиска по всему справочнику.
 * @returns Новые множества кодов отправления и назначения. При отсутствии совпадений множества пусты.
 * @remarks Каждое множество учитывает дату и противоположный город. Не меняет данные и не выполняет запросов.
 */
export function flightCities(routes: readonly RouteMeta[], from: string, to: string, date: string): {
  origins: ReadonlySet<string>;
  destinations: ReadonlySet<string>;
} {
  const origins = new Set<string>();
  const destinations = new Set<string>();
  for (const route of routes) {
    if (date && !route.dates.includes(date)) continue;
    if (!to || route.destination.code === to) origins.add(route.origin.code);
    if (!from || route.origin.code === from) destinations.add(route.destination.code);
  }
  return { origins, destinations };
}
