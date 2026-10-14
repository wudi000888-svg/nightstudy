import { Worker } from 'node:worker_threads';
import { normalize } from './shared.js';

export const bookTemplateHeader = 'NIGHTSTUDY-WORDBOOK v1';
export const bookImportLimits = {
  maxEntries: 10000,
  maxFileBytes: 2 * 1024 * 1024,
  maxTxtBytes: 256 * 1024,
  maxPages: 250,
  maxTextCharacters: 512000,
} as const;
export type BookFileFormat = 'txt' | 'pdf' | 'docx';
export type ImportReason = { code: string; message: string };
export type ParsedBookRow = {
  lineNumber: number;
  text: string;
  normalizedLemma: string;
  status: 'ready' | 'failed' | 'duplicate';
  reasons: ImportReason[];
  duplicateOfLine?: number;
};
export class BookParserError extends Error {
  code: string;
  statusCode: number;
  constructor(code: string, statusCode = 400) {
    super(code);
    this.code = code;
    this.statusCode = statusCode;
  }
}
export function decodeBookUpload(format: BookFileFormat, filename: string, base64: string) {
  const maximum = format === 'txt' ? bookImportLimits.maxTxtBytes : bookImportLimits.maxFileBytes;
  if (!filename.toLowerCase().endsWith(`.${format}`) || /[\r\n\0/\\]/.test(filename))
    throw new BookParserError('import_filename_invalid');
  if (
    !base64 ||
    base64.length > Math.ceil(maximum / 3) * 4 ||
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(base64)
  )
    throw new BookParserError(
      base64.length > Math.ceil(maximum / 3) * 4
        ? 'import_file_too_large'
        : 'import_base64_invalid',
      base64.length > Math.ceil(maximum / 3) * 4 ? 413 : 400,
    );
  const bytes = Buffer.from(base64, 'base64');
  if (bytes.length > maximum) throw new BookParserError('import_file_too_large', 413);
  if (bytes.toString('base64') !== base64) throw new BookParserError('import_base64_invalid');
  return bytes;
}
export function parseBookLines(text: string): ParsedBookRow[] {
  if (text.length > bookImportLimits.maxTextCharacters)
    throw new BookParserError('import_text_too_large', 413);
  if (text.includes('\0')) throw new BookParserError('import_text_invalid');
  const lines = text
    .replace(/^\uFEFF/, '')
    .replace(/\r\n?/g, '\n')
    .split('\n');
  const first = lines.findIndex((line) => line.trim());
  if (first < 0 || lines[first]?.trim() !== bookTemplateHeader)
    throw new BookParserError('import_template_header_missing');
  const rows: ParsedBookRow[] = [],
    firstLine = new Map<string, number>();
  for (let index = first + 1; index < lines.length; index++) {
    const raw = lines[index]!;
    if (!raw.trim()) continue;
    if (rows.length >= bookImportLimits.maxEntries)
      throw new BookParserError('import_too_many_rows', 413);
    const value = normalize(raw);
    const row: ParsedBookRow = {
      lineNumber: index + 1,
      text: raw,
      normalizedLemma: value.length <= 160 ? value : '',
      status: 'ready',
      reasons: [],
    };
    if (value.length > 160 || !/^[a-z]+(?:['-][a-z]+)*(?: [a-z]+(?:['-][a-z]+)*)*$/.test(value)) {
      row.status = 'failed';
      row.reasons.push({
        code: 'invalid_line',
        message: '每行仅接受一个英语单词或短语，不接受编号、表格、释义或多语言文本',
      });
    } else if (firstLine.has(value)) {
      row.status = 'duplicate';
      row.duplicateOfLine = firstLine.get(value)!;
      row.reasons.push({
        code: 'duplicate',
        message: `与第 ${row.duplicateOfLine} 行相同，确认时去重`,
      });
    } else firstLine.set(value, row.lineNumber);
    rows.push(row);
  }
  if (!rows.length) throw new BookParserError('import_no_rows');
  return rows;
}
let activeParsers = 0;
export async function parseBookFile(
  format: BookFileFormat,
  bytes: Uint8Array,
): Promise<{ rows: ParsedBookRow[]; pageCount: number | null }> {
  if (
    bytes.length > (format === 'txt' ? bookImportLimits.maxTxtBytes : bookImportLimits.maxFileBytes)
  )
    throw new BookParserError('import_file_too_large', 413);
  if (format === 'txt') {
    let text: string;
    try {
      text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    } catch {
      throw new BookParserError('import_text_not_utf8');
    }
    return { rows: parseBookLines(text), pageCount: null };
  }
  if (activeParsers >= 2) throw new BookParserError('import_parser_busy', 429);
  activeParsers++;
  const workerUrl = new URL(
    import.meta.url.endsWith('.ts') ? './custom-book-worker.ts' : './custom-book-worker.js',
    import.meta.url,
  );
  let worker: Worker | undefined;
  try {
    const result = await new Promise<{ text: string; pageCount: number | null }>(
      (resolve, reject) => {
        const copy = new Uint8Array(bytes);
        worker = new Worker(workerUrl, {
          workerData: { format, bytes: copy, limits: bookImportLimits },
          transferList: [copy.buffer],
          resourceLimits: { maxOldGenerationSizeMb: 128, stackSizeMb: 4 },
          env: {},
          stdout: true,
          stderr: true,
        });
        // Consume diagnostics without exposing uploaded document text or paths.
        worker.stdout?.resume();
        worker.stderr?.resume();
        const timer = setTimeout(() => {
          reject(new BookParserError('import_parser_timeout', 422));
          void worker?.terminate();
        }, 12000);
        worker.once('message', (message: unknown) => {
          const value = message as { text?: unknown; pageCount?: unknown; code?: unknown };
          if (
            typeof value.text === 'string' &&
            value.text.length <= bookImportLimits.maxTextCharacters
          )
            resolve({
              text: value.text,
              pageCount: typeof value.pageCount === 'number' ? value.pageCount : null,
            });
          else
            reject(
              new BookParserError(
                typeof value.code === 'string' && /^import_[a-z_]+$/.test(value.code)
                  ? value.code
                  : 'import_document_invalid',
              ),
            );
        });
        worker.once('error', () => reject(new BookParserError('import_document_invalid')));
        worker.once('exit', (code) => {
          clearTimeout(timer);
          if (code !== 0) reject(new BookParserError('import_document_invalid'));
        });
      },
    );
    return { rows: parseBookLines(result.text), pageCount: result.pageCount };
  } finally {
    // Do not release the CPU slot before the worker has actually stopped.
    if (worker) await worker.terminate();
    activeParsers--;
  }
}
