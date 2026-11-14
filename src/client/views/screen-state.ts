/** Сериализуемые данные для восстановления «Рейса» и «Табло» в текущей вкладке браузера. */
import type { BoardResponse, CurveResponse, ForecastResponse, Meta, MonthResponse } from '../api';

/** Связывает экран с памятью навигации на время одного отображения. */
export interface ScreenStateAccess<State> {
  /** Снимок при возврате через шапку, в том числе после перезагрузки; иначе undefined. */
  readonly restored: State | undefined;
  /**
   * Регистрирует обязательную функцию без аргументов, возвращающую свежий снимок.
   * Возвращает void; заменяет обработчик сохранения для текущего экрана без немедленной записи.
   * При переходе обработчик читает снимок для памяти и хранилища вкладки; ошибки чтения распространяются.
   */
  capture(read: () => State): void;
}

/** Последний успешный расчёт рейса с данными всех карточек. */
export interface FlightResult {
  a: ForecastResponse;
  b: ForecastResponse | null;
  curve: CurveResponse;
  month: MonthResponse;
}

/** Выбранный маршрут, дата, обе цены, режим отображения и последний результат рейса. */
export interface FlightScreenState {
  meta?: Meta;
  from: string;
  to: string;
  date: string;
  price: string;
  comparisonPrice: string;
  comparing: boolean;
  chartMode: 'chart' | 'table';
  result: FlightResult | null;
}

/** Выбранная дата и режим цены табло вместе с последним ответом для таблицы и карты. */
export interface BoardScreenState {
  date: string;
  mode: 'base' | 'model';
  result: BoardResponse | null;
}
