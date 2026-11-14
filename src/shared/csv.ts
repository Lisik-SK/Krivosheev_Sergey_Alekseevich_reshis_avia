/**
 * Небольшой парсер CSV по RFC 4180 без внешних зависимостей.
 * Понимает BOM, CRLF, кавычки и экранирование "", а также сам определяет
 * разделитель: запятую, точку с запятой (экспорт из русского Excel) или табуляцию.
 */

import { LocalizedError, msg, type Lang, type MessageKey, type Params } from './messages.js';

export type Delimiter = ',' | ';' | '\t';

export interface CsvTable {
  delimiter: Delimiter;
  header: string[];
  /** Строки данных без заголовка. `line` — номер строки в исходном файле (с 1). */
  rows: Array<{ line: number; cells: string[] }>;
}

/** Ошибка разбора CSV. Текст переводится под язык запроса, номер строки — в начале. */
export class CsvError extends LocalizedError {
  constructor(
    key: MessageKey,
    params: Params = {},
    public readonly line?: number,
  ) {
    super(key, params);
    this.name = 'CsvError';
    this.message = this.localize('ru');
  }
  override localize(lang: Lang): string {
    const text = msg(lang, this.key, this.params);
    return this.line ? msg(lang, 'line_prefix', { line: this.line }) + text : text;
  }
}

/**
 * Определяет разделитель по первой записи переданного текста CSV.
 * @param firstRecordAndRest Текст с заголовка; может содержать следующие записи и переносы внутри кавычек.
 * @returns Запятая, точка с запятой или табуляция; при равенстве действует указанный порядок.
 * @remarks Не выполняет ввод-вывод и не выбрасывает ошибки для пустого или повреждённого текста.
 */
export function detectDelimiter(firstRecordAndRest: string): Delimiter {
  const candidates: Delimiter[] = [',', ';', '\t'];
  let best: Delimiter = ',';
  let bestCount = 0;
  for (const d of candidates) {
    const count = countFirstRecordSeparators(firstRecordAndRest, d);
    if (count > bestCount) {
      best = d;
      bestCount = count;
    }
  }
  return best;
}

/**
 * Считает разделители вне кавычек в первой логической записи.
 * @param text Текст CSV начиная с заголовка; пустая строка допустима.
 * @param delimiter Один из поддерживаемых символов разделителя.
 * @returns Неотрицательное число разделителей до первого переноса вне кавычек или конца текста.
 * @remarks Не проверяет синтаксис кавычек, не выполняет ввод-вывод и не меняет вход.
 */
function countFirstRecordSeparators(text: string, delimiter: Delimiter): number {
  let count = 0;
  let inQuotes = false;
  for (const ch of text) {
    if (ch === '"') inQuotes = !inQuotes;
    else if (!inQuotes) {
      if (ch === '\r' || ch === '\n') break;
      if (ch === delimiter) count++;
    }
  }
  return count;
}

/**
 * Разбирает заголовок и записи CSV с запятой, точкой с запятой или табуляцией.
 * @param input Обязательный текст CSV, может начинаться с BOM и строк из пробелов.
 * @returns Таблица без пустых записей, с номерами первых физических строк каждой записи.
 * @throws {CsvError} Если заголовка нет, кавычки не закрыты или после закрытия кавычек есть посторонние символы.
 * @remarks Поддерживает CRLF, LF и CR; не проверяет схему таблицы, не меняет вход и не обращается к диску.
 */
export function parseCsv(input: string): CsvTable {
  let text = input;
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);

  const blankPrefix = /^(?:[^\S\r\n]*(?:\r\n|\r|\n))*/.exec(text)?.[0] ?? '';
  const delimiter = detectDelimiter(text.slice(blankPrefix.length));

  const records: Array<{ line: number; cells: string[] }> = [];
  let cells: string[] = [];
  let field = '';
  let inQuotes = false;
  let fieldWasQuoted = false;
  let line = 1;
  let recordLine = 1;

  /** Завершает текущее поле, добавляет его в запись и очищает состояние разбора поля. */
  const pushField = () => {
    cells.push(fieldWasQuoted ? field : field.trim());
    field = '';
    fieldWasQuoted = false;
  };
  /** Завершает текущую запись и добавляет её в таблицу, если хотя бы одно поле заполнено. */
  const pushRecord = () => {
    pushField();
    // Пустые строки и строки из одних разделителей (;;; из Excel) пропускаем.
    if (!cells.every((c) => c === '')) {
      records.push({ line: recordLine, cells });
    }
    cells = [];
  };

  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        if (ch === '\n' || (ch === '\r' && text[i + 1] !== '\n')) line++;
        field += ch;
      }
      continue;
    }
    if (ch === delimiter) {
      pushField();
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++;
      pushRecord();
      line++;
      recordLine = line;
    } else if (fieldWasQuoted) {
      if (ch.trim() !== '') throw new CsvError('csv_quote_suffix', {}, recordLine);
    } else if (ch === '"' && field.trim() === '') {
      inQuotes = true;
      fieldWasQuoted = true;
      field = '';
    } else {
      field += ch;
    }
  }
  if (inQuotes) throw new CsvError('csv_unclosed_quote', {}, recordLine);
  if (field !== '' || cells.length > 0) pushRecord();

  const headerRecord = records.shift();
  if (!headerRecord) throw new CsvError('csv_empty');
  const header = headerRecord.cells.map((h) => h.trim());
  return { delimiter, header, rows: records };
}

/**
 * Число из ячейки CSV. Пробелы и неразрывные пробелы между разрядами убираются,
 * десятичная запятая допускается (например, «0,141» из Excel).
 */
export function parseNumber(raw: string | undefined): number | null {
  if (raw === undefined) return null;
  const cleaned = raw.replace(/[\s  ]/g, '').replace(',', '.');
  if (cleaned === '' || /^(nan|null|none|na|n\/a)$/i.test(cleaned)) return null;
  if (!/^[+-]?(\d+\.?\d*|\.\d+)(e[+-]?\d+)?$/i.test(cleaned)) return Number.NaN;
  return Number(cleaned);
}
