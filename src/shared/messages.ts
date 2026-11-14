/**
 * Сообщения сервера и проверки данных на двух языках.
 * Ошибка хранит ключ и параметры, а текст собирается под язык конкретного запроса.
 * Русский — язык по умолчанию (в том числе для `Error.message`).
 */
export type Lang = 'ru' | 'en';
export type Params = Record<string, string | number>;

export interface Localizable {
  key: MessageKey;
  params?: Params;
}

type Catalog = Record<string, (p: Params) => string>;

const ru = {
  // HTTP и авторизация
  login_required: () => 'Войдите в систему, чтобы пользоваться прогнозом',
  invalid_credentials: () => 'Неверный email или пароль',
  registration_disabled: () => 'Регистрация новых пользователей отключена администратором',
  check_fields: () => 'Проверьте введённые данные',
  check_form: () => 'Проверьте поля формы',
  email_required: () => 'Укажите email',
  email_invalid: () => 'Похоже, в адресе ошибка',
  email_taken: () => 'Пользователь с таким email уже зарегистрирован',
  name_required: () => 'Укажите имя',
  name_too_long: (p) => `Не длиннее ${p.max} символов`,
  name_invalid: () => 'Имя содержит недопустимые символы',
  password_short: (p) => `Пароль — не короче ${p.min} символов`,
  password_long: (p) => `Пароль — не длиннее ${p.max} символов`,
  password_weak: () => 'Нужны хотя бы одна буква и одна цифра',
  password_has_email: () => 'Пароль не должен содержать имя из email',
  too_many_attempts: () => 'Слишком много попыток. Подождите минуту и попробуйте снова.',
  json_required: () => 'Ожидается JSON (Content-Type: application/json)',
  foreign_origin: () => 'Запрос с чужого сайта отклонён',
  body_too_large: () => 'Слишком большой запрос',
  bad_request: () => 'Некорректный запрос',
  internal_error: () => 'Внутренняя ошибка сервера. Попробуйте ещё раз.',
  api_not_found: () => 'Такого адреса API нет',
  not_found: () => 'Не найдено',
  data_unavailable: (p) => `Данные прогноза недоступны: ${p.reason}`,
  data_not_loaded: () => 'файл не загружен',
  admin_only: () => 'Раздел доступен только администратору',
  // Прогноз
  from_required: () => 'Укажите пункт отправления',
  to_required: () => 'Укажите пункт назначения',
  city_not_found: (p) => `Город «${p.city}» не найден в справочнике маршрутов`,
  same_city: () => 'Пункты отправления и назначения совпадают',
  date_required: () => 'Укажите дату вылета',
  date_format: () => 'Укажите дату в формате ГГГГ-ММ-ДД или ДД.ММ.ГГГГ',
  price_required: () => 'Укажите цену билета',
  price_nan: () => 'Цена должна быть числом',
  price_negative: () => 'Цена не может быть отрицательной',
  price_too_high: (p) => `Цена должна быть не больше ${Number(p.max).toLocaleString('ru-RU')} ₽`,
  route_missing: (p) => `Направления ${p.from} → ${p.to} нет в справочнике. ${p.hint}.`,
  route_hint_available: (p) => `Из этого города в справочнике есть направления: ${p.list}`,
  route_hint_none: () => 'Из этого города в справочнике нет направлений',
  route_field: () => 'Нет такого направления',
  route_no_forecast: (p) => `Для маршрута ${p.route} пока нет данных прогноза`,
  flight_missing: (p) => `На ${p.date} рейса ${p.route} в прогнозе нет. Прогноз есть ${p.range}.`,
  dates_range: (p) => `с ${p.from} по ${p.to}`,
  dates_available: (p) => `Доступны даты ${p.range}`,
  history_not_found: () => 'Запись истории не найдена',
  history_clear_mode: () => 'Укажите режим очистки истории (all или unpinned)',
  // Загрузка файлов
  upload_kind: () => 'Укажите тип файла: forecast или routes',
  upload_empty: () => 'Файл пустой',
  upload_too_large: (p) => `Файл больше ${p.mb} МБ`,
  upload_write_failed: (p) => `Не удалось сохранить файл: ${p.reason}`,
  data_revision_required: () => 'Обновите страницу «Данные» и подтвердите операцию ещё раз.',
  data_revision_conflict: () => 'Данные изменились. Проверьте актуальную версию и повторите операцию.',
  restore_invalid: (p) => `Не удалось восстановить предыдущую версию: ${p.reason}`,
  download_not_found: () => 'Файл для скачивания не найден',
  download_read_failed: () => 'Не удалось прочитать файл для скачивания',
  // CSV
  line_prefix: (p) => `Строка ${p.line}: `,
  csv_unclosed_quote: () => 'незакрытая кавычка',
  csv_quote_suffix: () => 'после закрывающей кавычки ожидается разделитель или конец строки',
  csv_duplicate_column: (p) => `столбец ${p.column} указан несколько раз`,
  csv_empty: () => 'файл пустой',
  routes_missing_cols: (p) => `в справочнике маршрутов нет обязательных колонок: ${p.cols}`,
  route_code_empty: () => 'пустой код маршрута',
  route_code_format: (p) => `код маршрута «${p.code}» должен иметь вид ОТКУДА-КУДА, например MOW-AER`,
  route_duplicate: (p) => `Справочник маршрутов, строка ${p.line}: маршрут ${p.code} повторяется, используется последняя запись`,
  base_price_invalid: (p) => `base_price для ${p.code} должна быть положительным числом`,
  sensitivity_invalid: (p) => `price_sensitivity для ${p.code} должна быть неотрицательным числом`,
  field_not_number: (p) => `${p.field} для ${p.code} — не число`,
  routes_no_rows: () => 'в справочнике маршрутов нет ни одной строки',
  forecast_missing_cols: (p) => `в файле прогноза нет обязательных колонок: ${p.cols}`,
  no_quantile_cols: () => 'в файле прогноза нет колонок вида 0.5_base_demand',
  no_median: () => 'в файле прогноза нет медианы — колонки 0.5_base_demand',
  route_empty: () => 'пустой маршрут',
  date_invalid: (p) => `не удалось прочитать дату «${p.value}»`,
  seats_invalid: (p) => `число мест должно быть положительным, получено «${p.value}»`,
  quantile_not_number: (p) => `${p.column} — не число: «${p.value}»`,
  flight_duplicate: (p) => `Файл прогноза, строка ${p.line}: рейс ${p.route} на ${p.date} уже встречался, используется последняя запись`,
  forecast_no_rows: () => 'в файле прогноза нет ни одной строки с данными',
  quantiles_sorted: (p) =>
    `В ${p.count} ${Number(p.count) % 10 === 1 && Number(p.count) % 100 !== 11 ? 'строке' : 'строках'} файла прогноза квантили спроса были не по возрастанию. Медиана сохранена, остальные значения скорректированы автоматически.`,
  file_not_found: (p) => `${p.what} не найден: ${p.file}`,
  file_read_error: (p) => `${p.what}: не удалось прочитать ${p.file} (${p.code})`,
  file_invalid_encoding: (p) => `${p.what}: файл не в кодировке UTF-8`,
  files_changed_while_reading: () => 'CSV изменились во время чтения, загрузка будет повторена.',
  what_routes: () => 'справочник маршрутов',
  what_forecast: () => 'файл прогноза',
  no_routes_matched: () =>
    'ни один маршрут из файла прогноза не найден в справочнике маршрутов (routes.csv). Проверьте колонку route.',
  replacement_routes_no_matches: () =>
    'В новом справочнике нет ни одного маршрута из текущего прогноза. После замены рейсы не будут отображаться.',
  unknown_routes: (p) => `Маршруты не найдены в справочнике, их строки пропущены: ${p.list}`,
} satisfies Catalog;

export type MessageKey = keyof typeof ru;

const en: Record<MessageKey, (p: Params) => string> = {
  login_required: () => 'Sign in to use the forecast',
  invalid_credentials: () => 'Wrong email or password',
  registration_disabled: () => 'Sign-up is disabled by the administrator',
  check_fields: () => 'Please check your input',
  check_form: () => 'Please check the form fields',
  email_required: () => 'Enter your email',
  email_invalid: () => 'This email address looks wrong',
  email_taken: () => 'A user with this email already exists',
  name_required: () => 'Enter your name',
  name_too_long: (p) => `At most ${p.max} characters`,
  name_invalid: () => 'The name contains invalid characters',
  password_short: (p) => `Password must be at least ${p.min} characters`,
  password_long: (p) => `Password must be at most ${p.max} characters`,
  password_weak: () => 'Use at least one letter and one digit',
  password_has_email: () => 'Password must not contain the name part of your email',
  too_many_attempts: () => 'Too many attempts. Wait a minute and try again.',
  json_required: () => 'JSON expected (Content-Type: application/json)',
  foreign_origin: () => 'Cross-site request rejected',
  body_too_large: () => 'Request is too large',
  bad_request: () => 'Bad request',
  internal_error: () => 'Internal server error. Please try again.',
  api_not_found: () => 'No such API endpoint',
  not_found: () => 'Not found',
  data_unavailable: (p) => `Forecast data is unavailable: ${p.reason}`,
  data_not_loaded: () => 'file not loaded',
  admin_only: () => 'This section is for administrators only',
  from_required: () => 'Choose the departure city',
  to_required: () => 'Choose the destination',
  city_not_found: (p) => `City “${p.city}” is not in the route directory`,
  same_city: () => 'Departure and destination are the same',
  date_required: () => 'Choose the departure date',
  date_format: () => 'Use YYYY-MM-DD or DD.MM.YYYY',
  price_required: () => 'Enter the ticket price',
  price_nan: () => 'Price must be a number',
  price_negative: () => 'Price cannot be negative',
  price_too_high: (p) => `Price must not exceed ${Number(p.max).toLocaleString('en-GB')} ₽`,
  route_missing: (p) => `There is no ${p.from} → ${p.to} route in the directory. ${p.hint}.`,
  route_hint_available: (p) => `The directory lists routes from this city to: ${p.list}`,
  route_hint_none: () => 'The directory has no routes from this city',
  route_field: () => 'No such route',
  route_no_forecast: (p) => `There is no forecast data for route ${p.route} yet`,
  flight_missing: (p) => `There is no ${p.route} flight on ${p.date} in the forecast. The forecast covers ${p.range}.`,
  dates_range: (p) => `from ${p.from} to ${p.to}`,
  dates_available: (p) => `Available dates: ${p.range}`,
  history_not_found: () => 'History entry not found',
  history_clear_mode: () => 'Specify a history clear mode (all or unpinned)',
  upload_kind: () => 'File type must be forecast or routes',
  upload_empty: () => 'The file is empty',
  upload_too_large: (p) => `The file is larger than ${p.mb} MB`,
  upload_write_failed: (p) => `Could not save the file: ${p.reason}`,
  data_revision_required: () => 'Refresh the Data page and confirm the operation again.',
  data_revision_conflict: () => 'The data has changed. Check the current version and try again.',
  restore_invalid: (p) => `Could not restore the previous version: ${p.reason}`,
  download_not_found: () => 'The file to download was not found',
  download_read_failed: () => 'Could not read the file to download',
  line_prefix: (p) => `Line ${p.line}: `,
  csv_unclosed_quote: () => 'unclosed quote',
  csv_quote_suffix: () => 'expected a separator or end of record after a closing quote',
  csv_duplicate_column: (p) => `duplicate ${p.column} column`,
  csv_empty: () => 'the file is empty',
  routes_missing_cols: (p) => `the routes file lacks required columns: ${p.cols}`,
  route_code_empty: () => 'empty route code',
  route_code_format: (p) => `route code “${p.code}” must look like FROM-TO, e.g. MOW-AER`,
  route_duplicate: (p) => `Routes file, line ${p.line}: route ${p.code} appears more than once; the last row is used`,
  base_price_invalid: (p) => `base_price for ${p.code} must be a positive number`,
  sensitivity_invalid: (p) => `price_sensitivity for ${p.code} must be a non-negative number`,
  field_not_number: (p) => `${p.field} for ${p.code} is not a number`,
  routes_no_rows: () => 'the routes file has no rows',
  forecast_missing_cols: (p) => `the forecast file lacks required columns: ${p.cols}`,
  no_quantile_cols: () => 'the forecast file has no columns like 0.5_base_demand',
  no_median: () => 'the forecast file has no median column 0.5_base_demand',
  route_empty: () => 'empty route',
  date_invalid: (p) => `cannot read the date “${p.value}”`,
  seats_invalid: (p) => `seats must be a positive number, got “${p.value}”`,
  quantile_not_number: (p) => `${p.column} is not a number: “${p.value}”`,
  flight_duplicate: (p) => `Forecast file, line ${p.line}: flight ${p.route} on ${p.date} appears more than once; the last row is used`,
  forecast_no_rows: () => 'the forecast file has no data rows',
  quantiles_sorted: (p) =>
    `In ${p.count} ${Number(p.count) === 1 ? 'row' : 'rows'} of the forecast file demand quantiles were not in ascending order. The median was kept, the others were adjusted automatically.`,
  file_not_found: (p) => `${p.what} not found: ${p.file}`,
  file_read_error: (p) => `${p.what}: cannot read ${p.file} (${p.code})`,
  file_invalid_encoding: (p) => `${p.what}: the file is not valid UTF-8`,
  files_changed_while_reading: () => 'The CSV files changed during reading. Loading will be retried.',
  what_routes: () => 'routes file',
  what_forecast: () => 'forecast file',
  no_routes_matched: () => 'none of the forecast routes is in the routes file (routes.csv). Check the route column.',
  replacement_routes_no_matches: () =>
    'The new route directory contains none of the routes in the current forecast. After replacement, no flights will be displayed.',
  unknown_routes: (p) => `Routes not found in the routes file, their rows were skipped: ${p.list}`,
};

const catalogs: Record<Lang, Record<MessageKey, (p: Params) => string>> = { ru, en };

export function msg(lang: Lang, key: MessageKey, params: Params = {}): string {
  // Параметры-ключи вида { what: 'what_routes' } тоже переводим.
  const resolved: Params = {};
  for (const [k, v] of Object.entries(params)) {
    resolved[k] = typeof v === 'string' && v in ru && /^what_/.test(v) ? catalogs[lang][v as MessageKey]({}) : v;
  }
  return catalogs[lang][key](resolved);
}

export function render(lang: Lang, item: Localizable | string): string {
  return typeof item === 'string' ? item : msg(lang, item.key, item.params);
}

export function parseLang(value: string | undefined | null): Lang | null {
  if (!value) return null;
  const v = value.trim().toLowerCase();
  if (v.startsWith('en')) return 'en';
  if (v.startsWith('ru')) return 'ru';
  return null;
}

/** Ошибка с переводимым сообщением. `message` — на русском (по умолчанию). */
export class LocalizedError extends Error {
  readonly key: MessageKey;
  readonly params: Params;
  constructor(key: MessageKey, params: Params = {}) {
    super(msg('ru', key, params));
    this.key = key;
    this.params = params;
  }
  localize(lang: Lang): string {
    return msg(lang, this.key, this.params);
  }
  toLocalizable(): Localizable {
    return { key: this.key, params: this.params };
  }
}
