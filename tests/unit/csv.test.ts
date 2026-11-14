import { describe, expect, it } from 'vitest';
import { CsvError, detectDelimiter, parseCsv, parseNumber } from '../../src/shared/csv';
import { msg } from '../../src/shared/messages';

const cellsOf = (text: string) => parseCsv(text).rows.map((r) => r.cells);

describe('parseCsv: basics', () => {
  it('parses header and rows with line numbers', () => {
    const t = parseCsv('a,b,c\n1,2,3\n4,5,6\n');
    expect(t.delimiter).toBe(',');
    expect(t.header).toEqual(['a', 'b', 'c']);
    expect(t.rows).toEqual([
      { line: 2, cells: ['1', '2', '3'] },
      { line: 3, cells: ['4', '5', '6'] },
    ]);
  });

  it('strips UTF-8 BOM so the first header is clean', () => {
    const t = parseCsv('\uFEFFroute,date\nMOW-AER,2026-06-01');
    expect(t.header).toEqual(['route', 'date']);
    expect(t.header[0]!.charCodeAt(0)).toBe('r'.charCodeAt(0));
    expect(t.rows[0]!.cells).toEqual(['MOW-AER', '2026-06-01']);
  });

  it('handles CRLF line endings without leaving \\r in cells', () => {
    const t = parseCsv('a,b\r\n1,2\r\n3,4\r\n');
    expect(t.header).toEqual(['a', 'b']);
    expect(t.rows.map((r) => r.cells)).toEqual([
      ['1', '2'],
      ['3', '4'],
    ]);
    expect(t.rows.map((r) => r.line)).toEqual([2, 3]);
  });

  it('handles bare CR line endings (old Mac)', () => {
    expect(cellsOf('a,b\r1,2\r3,4')).toEqual([
      ['1', '2'],
      ['3', '4'],
    ]);
  });

  it('parses the last row without a trailing newline', () => {
    expect(cellsOf('a,b\n1,2')).toEqual([['1', '2']]);
  });

  it('skips empty trailing lines and blank lines in the middle, keeping correct line numbers', () => {
    const t = parseCsv('a,b\n1,2\n\n3,4\n\n\r\n\n');
    expect(t.rows).toEqual([
      { line: 2, cells: ['1', '2'] },
      { line: 4, cells: ['3', '4'] },
    ]);
  });

  it('skips whitespace-only lines', () => {
    expect(cellsOf('a,b\n1,2\n   \n')).toEqual([['1', '2']]);
  });

  it('trims unquoted cells and header names', () => {
    const t = parseCsv(' a , b \n 1 , 2 \n');
    expect(t.header).toEqual(['a', 'b']);
    expect(t.rows[0]!.cells).toEqual(['1', '2']);
  });

  it('keeps empty cells inside a row that has data', () => {
    expect(cellsOf('a,b,c\n1,,3\n,,x\n')).toEqual([
      ['1', '', '3'],
      ['', '', 'x'],
    ]);
  });

  it('skips rows made only of delimiters / empty cells (Excel ";;;" rows), keeping line numbers', () => {
    const t = parseCsv('a;b;c\n;;\n1;2;3\n ; ; \n"";"";""\n4;5;6\n;;\n');
    expect(t.rows).toEqual([
      { line: 3, cells: ['1', '2', '3'] },
      { line: 6, cells: ['4', '5', '6'] },
    ]);
  });

  it('throws CsvError on an empty file', () => {
    expect(() => parseCsv('')).toThrow(CsvError);
    expect(() => parseCsv('\uFEFF')).toThrow(CsvError);
    expect(() => parseCsv('\n\n\n')).toThrow(msg('ru', 'csv_empty'));
  });

  it('returns a header with no rows for a header-only file', () => {
    const t = parseCsv('a,b\n');
    expect(t.header).toEqual(['a', 'b']);
    expect(t.rows).toEqual([]);
  });
});

describe('parseCsv: quotes', () => {
  it('keeps the delimiter inside a quoted field', () => {
    expect(cellsOf('name,x\n"Москва, Внуково",1\n')).toEqual([['Москва, Внуково', '1']]);
  });

  it('keeps newlines inside a quoted field and numbers following lines correctly', () => {
    const t = parseCsv('a,b\n"line1\nline2",2\n3,4\n');
    expect(t.rows[0]!.cells).toEqual(['line1\nline2', '2']);
    expect(t.rows[0]!.line).toBe(2);
    // The quoted field spans lines 2-3, so the next record starts on line 4.
    expect(t.rows[1]).toEqual({ line: 4, cells: ['3', '4'] });
  });

  it('keeps CRLF inside a quoted field', () => {
    expect(cellsOf('a,b\r\n"x\r\ny",2\r\n')).toEqual([['x\r\ny', '2']]);
  });

  it('unescapes doubled quotes', () => {
    expect(cellsOf('a,b\n"He said ""hi""",2\n')).toEqual([['He said "hi"', '2']]);
    expect(cellsOf('a\n""""\n')).toEqual([['"']]);
  });

  it('does not trim whitespace inside quoted fields', () => {
    expect(cellsOf('a,b\n"  padded  ",2\n')).toEqual([['  padded  ', '2']]);
  });

  it('allows leading whitespace before an opening quote', () => {
    expect(cellsOf('a,b\n  "x,y",2\n')).toEqual([['x,y', '2']]);
  });

  it('treats a quote in the middle of an unquoted field as a literal', () => {
    expect(cellsOf('a,b\n5"7,2\n')).toEqual([['5"7', '2']]);
  });

  it('accepts an empty quoted field', () => {
    expect(cellsOf('a,b\n"",2\n')).toEqual([['', '2']]);
  });

  it('quoted header names are supported', () => {
    expect(parseCsv('"route","date"\n"MOW-AER","2026-06-01"\n').header).toEqual(['route', 'date']);
  });

  it('throws CsvError with the record line number on an unclosed quote', () => {
    let err: unknown;
    try {
      parseCsv('a,b\n1,2\n"broken,3\n4,5\n');
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(CsvError);
    expect((err as CsvError).line).toBe(3);
    expect((err as CsvError).key).toBe('csv_unclosed_quote');
    expect((err as CsvError).message).toBe(msg('ru', 'line_prefix', { line: 3 }) + msg('ru', 'csv_unclosed_quote'));
    expect((err as CsvError).localize('en')).toBe(msg('en', 'line_prefix', { line: 3 }) + msg('en', 'csv_unclosed_quote'));
  });
});

describe('parseCsv: delimiters', () => {
  it('detects semicolon (Russian Excel export)', () => {
    const t = parseCsv('route;base_price;price_sensitivity\nMOW-AER;9000;0,141\n');
    expect(t.delimiter).toBe(';');
    expect(t.rows[0]!.cells).toEqual(['MOW-AER', '9000', '0,141']);
  });

  it('detects tab', () => {
    const t = parseCsv('a\tb\tc\n1\t2\t3\n');
    expect(t.delimiter).toBe('\t');
    expect(t.rows[0]!.cells).toEqual(['1', '2', '3']);
  });

  it('with semicolons, commas inside cells are not delimiters', () => {
    const t = parseCsv('a;b\n1,5;2,25\n');
    expect(t.delimiter).toBe(';');
    expect(t.rows[0]!.cells).toEqual(['1,5', '2,25']);
  });

  it('ignores delimiters inside quotes when detecting', () => {
    expect(detectDelimiter('"a;b;c;d",x,y')).toBe(',');
    expect(detectDelimiter('"a,b,c,d";x;y')).toBe(';');
  });

  it('defaults to comma for a single-column header', () => {
    expect(detectDelimiter('route')).toBe(',');
    expect(parseCsv('route\nMOW-AER\n').rows[0]!.cells).toEqual(['MOW-AER']);
  });

  it('only looks at the first line (with CRLF too)', () => {
    expect(parseCsv('a;b\r\n1,2;3\r\n').delimiter).toBe(';');
  });
});

describe('parseNumber', () => {
  it.each([
    ['0', 0],
    ['42', 42],
    ['-7', -7],
    ['+5', 5],
    ['9000', 9000],
    ['0.141', 0.141],
    ['0,141', 0.141],
    ['.5', 0.5],
    ['5.', 5],
    ['1e3', 1000],
    ['1.5E-2', 0.015],
    ['  12  ', 12],
    ['1 234,5', 1234.5],
    ['1\u00a0234,5', 1234.5], // NBSP thousands separator (Excel RU)
    ['1\u202f234,5', 1234.5], // narrow NBSP (Intl ru-RU)
    ['1 000 000', 1_000_000],
    ['775.0', 775],
  ])('parseNumber(%j) === %d', (raw, expected) => {
    expect(parseNumber(raw)).toBe(expected);
  });

  it.each([undefined, '', '   ', 'nan', 'NaN', 'NULL', 'None', 'NA', 'n/a', 'N/A'])(
    'parseNumber(%j) is null (missing value)',
    (raw) => {
      expect(parseNumber(raw)).toBeNull();
    },
  );

  it.each(['abc', '12abc', '1.2.3', '1,234,5', '--1', 'Infinity', '0x10', '₽100', '1e', '-', '.', 'e5'])(
    'parseNumber(%j) is NaN (garbage)',
    (raw) => {
      expect(Number.isNaN(parseNumber(raw))).toBe(true);
    },
  );
});
