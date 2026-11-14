/** Наблюдение за сменой данных на открытом рабочем экране. */
import type { DataInfo, ResponseVersion } from './api';

/** Интервал фоновой проверки видимого экрана в миллисекундах. */
const checkIntervalMs = 5_000;

/**
 * Проверяет, использовал ли ответ последнюю известную версию исходных CSV.
 * @param response Обязательная метка ответа с номером версии и необязательной датой загрузки.
 * @param data Обязательные метаданные с номером версии и датой загрузки снимка.
 * @returns true при совпадении номера и, если дата доступна в ответе, даты загрузки.
 * @remarks Чистое сравнение без записи, исключений и запросов.
 */
export function matchesDataVersion(response: ResponseVersion, data: DataInfo): boolean {
  return response.dataVersion === data.version
    && (response.dataLoadedAt === undefined || response.dataLoadedAt === data.loadedAt);
}

/**
 * Подключает проверку данных на открытом экране.
 * @param signal Обязательный сигнал времени жизни экрана. При отмене удаляет обработчики и интервал.
 * @param refresh Обязательный обработчик. Получает true при возврате на вкладку или восстановлении
 * сети и false при проверке по таймеру; сам обрабатывает результат и ошибки запросов.
 * @returns void. Скрытая вкладка не запускает проверки; при отменённом сигнале подписок нет.
 * @remarks Регистрирует события документа, сети и восстановления страницы из кеша. Сам сеть не использует.
 * Синхронная ошибка обработчика передаётся браузеру; повтор проверки возможен при следующем событии.
 */
export function watchDataUpdates(signal: AbortSignal, refresh: (resumed: boolean) => void): void {
  if (signal.aborted) return;

  /** При видимости экрана запускает проверку с указанной причиной; ошибки обработчика распространяются. */
  function check(resumed: boolean): void {
    if (document.visibilityState === 'visible') refresh(resumed);
  }

  document.addEventListener('visibilitychange', () => check(true), { signal });
  window.addEventListener('online', () => check(true), { signal });
  window.addEventListener('pageshow', (event) => {
    if (event.persisted) check(true);
  }, { signal });
  const timer = window.setInterval(() => check(false), checkIntervalMs);
  signal.addEventListener('abort', () => window.clearInterval(timer), { once: true });
}
