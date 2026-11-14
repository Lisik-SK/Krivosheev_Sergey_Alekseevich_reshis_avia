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

export function detectDelimiter(firstLine: string): Delimiter {
  const candidates: Delimiter[] = [',', ';', '\t'];
  let best: Delimiter = ',';
  let bestCount = 0;
  for (const d of candidates) {
    const count = splitOutsideQuotes(firstLine, d);
    if (count > bestCount) {
      best = d;
      bestCount = count;
    }
  }
  return best;
}

function splitOutsideQuotes(line: string, delimiter: string): number {
  let count = 0;
  let inQuotes = false;
  for (const ch of line) {
    if (ch === '"') inQuotes = !inQuotes;
    else if (ch === delimiter && !inQuotes) count++;
  }
  return count;
}

export function parseCsv(input: string): CsvTable {
  let text = input;
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);

  const firstLineEnd = text.search(/\r?\n/);
  const firstLine = firstLineEnd === -1 ? text : text.slice(0, firstLineEnd);
  const delimiter = detectDelimiter(firstLine);

  const records: Array<{ line: number; cells: string[] }> = [];
  let cells: string[] = [];
  let field = '';
  let inQuotes = false;
  let fieldWasQuoted = false;
  let line = 1;
  let recordLine = 1;

  const pushField = () => {
    cells.push(fieldWasQuoted ? field : field.trim());
    field = '';
    fieldWasQuoted = false;
  };
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
        if (ch === '\n') line++;
        field += ch;
      }
      continue;
    }
    if (ch === '"' && field.trim() === '') {
      inQuotes = true;
      fieldWasQuoted = true;
      field = '';
    } else if (ch === delimiter) {
      pushField();
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++;
      pushRecord();
      line++;
      recordLine = line;
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
