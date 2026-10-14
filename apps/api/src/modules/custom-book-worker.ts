import { parentPort, workerData } from 'node:worker_threads';
import { inflateRawSync, inflateSync, crc32 } from 'node:zlib';
import { XMLParser, XMLValidator } from 'fast-xml-parser';

// Standalone imports let Node 24 execute this .ts worker in development/tests and its
// emitted .js counterpart in production. No application config or secrets are loaded.
const data = workerData as {
  format: 'pdf' | 'docx';
  bytes: Uint8Array;
  limits: { maxPages: number; maxTextCharacters: number };
};
class DocumentError extends Error {
  code: string;
  constructor(code: string) {
    super(code);
    this.code = code;
  }
}
const invalid = () => {
  throw new DocumentError('import_document_invalid');
};
function boundedText(value: string) {
  if (value.length > data.limits.maxTextCharacters)
    throw new DocumentError('import_text_too_large');
  return value;
}
function docxEntries(buffer: Buffer) {
  const minimum = Math.max(0, buffer.length - 65557);
  let end = -1;
  for (let at = buffer.length - 22; at >= minimum; at--)
    if (buffer.readUInt32LE(at) === 0x06054b50) {
      end = at;
      break;
    }
  if (end < 0 || buffer.readUInt16LE(end + 4) || buffer.readUInt16LE(end + 6)) invalid();
  const count = buffer.readUInt16LE(end + 10),
    size = buffer.readUInt32LE(end + 12),
    offset = buffer.readUInt32LE(end + 16);
  if (
    !count ||
    count > 200 ||
    buffer.readUInt16LE(end + 8) !== count ||
    offset + size > end ||
    end + 22 + buffer.readUInt16LE(end + 20) !== buffer.length
  )
    invalid();
  const entries = new Map<
    string,
    {
      offset: number;
      compressed: number;
      uncompressed: number;
      method: number;
      flags: number;
      crc: number;
    }
  >();
  let at = offset,
    total = 0;
  for (let index = 0; index < count; index++) {
    if (at + 46 > offset + size || buffer.readUInt32LE(at) !== 0x02014b50) invalid();
    const flags = buffer.readUInt16LE(at + 8),
      method = buffer.readUInt16LE(at + 10),
      compressed = buffer.readUInt32LE(at + 20),
      uncompressed = buffer.readUInt32LE(at + 24);
    const nameSize = buffer.readUInt16LE(at + 28),
      extraSize = buffer.readUInt16LE(at + 30),
      commentSize = buffer.readUInt16LE(at + 32),
      localOffset = buffer.readUInt32LE(at + 42);
    if (
      at + 46 + nameSize + extraSize + commentSize > offset + size ||
      flags & 1 ||
      ![0, 8].includes(method) ||
      compressed > buffer.length ||
      localOffset >= offset
    )
      invalid();
    const name = buffer.subarray(at + 46, at + 46 + nameSize).toString('utf8');
    if (
      !name ||
      /[\\\0]/.test(name) ||
      name.startsWith('/') ||
      name.split('/').some((part) => part === '.' || part === '..') ||
      entries.has(name)
    )
      invalid();
    if (/vbaProject|macro|activeX|embeddings/i.test(name))
      throw new DocumentError('import_docx_active_content');
    total += uncompressed;
    if (total > 16 * 1024 * 1024 || uncompressed > 4 * 1024 * 1024)
      throw new DocumentError('import_document_expansion_limit');
    entries.set(name, {
      offset: localOffset,
      compressed,
      uncompressed,
      method,
      flags,
      crc: buffer.readUInt32LE(at + 16),
    });
    at += 46 + nameSize + extraSize + commentSize;
  }
  if (at !== offset + size) invalid();
  const read = (name: string) => {
    const entry = entries.get(name);
    if (!entry) invalid();
    const item = entry!;
    if (
      item.offset + 30 > offset ||
      buffer.readUInt32LE(item.offset) !== 0x04034b50 ||
      buffer.readUInt16LE(item.offset + 6) !== item.flags ||
      buffer.readUInt16LE(item.offset + 8) !== item.method
    )
      invalid();
    const nameSize = buffer.readUInt16LE(item.offset + 26),
      extraSize = buffer.readUInt16LE(item.offset + 28),
      start = item.offset + 30 + nameSize + extraSize;
    if (
      start + item.compressed > offset ||
      buffer.subarray(item.offset + 30, item.offset + 30 + nameSize).toString('utf8') !== name
    )
      invalid();
    const raw = buffer.subarray(start, start + item.compressed);
    const extracted =
      item.method === 0 ? raw : inflateRawSync(raw, { maxOutputLength: 4 * 1024 * 1024 });
    if (extracted.length !== item.uncompressed || crc32(extracted) !== item.crc) invalid();
    let xml: string;
    try {
      xml = new TextDecoder('utf-8', { fatal: true }).decode(extracted);
    } catch {
      invalid();
    }
    if (/<!DOCTYPE|<!ENTITY/i.test(xml!)) throw new DocumentError('import_xml_entities_rejected');
    if (XMLValidator.validate(xml!) !== true) invalid();
    return xml!;
  };
  return { read, entries };
}
function decodeXmlText(text: string) {
  return text.replace(/&(?:amp|lt|gt|quot|apos|#\d+|#x[0-9a-fA-F]+);/g, (entity) => {
    const named: Record<string, string> = {
      '&amp;': '&',
      '&lt;': '<',
      '&gt;': '>',
      '&quot;': '"',
      '&apos;': "'",
    };
    if (named[entity] !== undefined) return named[entity]!;
    const code = entity.startsWith('&#x')
      ? Number.parseInt(entity.slice(3, -1), 16)
      : Number.parseInt(entity.slice(2, -1), 10);
    if (!code || code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff)) invalid();
    return String.fromCodePoint(code);
  });
}
async function extractDocx() {
  const zip = docxEntries(Buffer.from(data.bytes));
  const contentTypes = zip.read('[Content_Types].xml');
  if (
    !contentTypes.includes(
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml',
    ) ||
    /macroEnabled|vbaProject/i.test(contentTypes)
  )
    throw new DocumentError('import_docx_active_content');
  const document = zip.read('word/document.xml');
  if (/<(?:\w+:)?(?:tbl|altChunk|object|instrText)\b/.test(document))
    throw new DocumentError('import_docx_layout_unsupported');
  const nodes = new XMLParser({
    preserveOrder: true,
    ignoreAttributes: false,
    processEntities: false,
    trimValues: false,
    parseTagValue: false,
  }).parse(document) as unknown;
  const paragraphs: string[] = [];
  let characters = 0;
  const textOf = (input: unknown, depth = 0): string => {
    if (depth > 80) throw new DocumentError('import_document_expansion_limit');
    if (!Array.isArray(input)) return '';
    let text = '';
    for (const node of input)
      if (node && typeof node === 'object')
        for (const [key, value] of Object.entries(node)) {
          if (key === '#text') text += String(value);
          else if (key.endsWith(':br') || key === 'br') text += '\n';
          else if (key.endsWith(':tab') || key === 'tab') text += '\t';
          else if (key !== ':@' && key !== '?xml') text += textOf(value, depth + 1);
        }
    return text;
  };
  const visit = (input: unknown, depth = 0) => {
    if (depth > 80) throw new DocumentError('import_document_expansion_limit');
    if (!Array.isArray(input)) return;
    for (const node of input)
      if (node && typeof node === 'object')
        for (const [key, value] of Object.entries(node)) {
          if (key === 'w:p' || key === 'p') {
            const text = decodeXmlText(textOf(value));
            characters += text.length + 1;
            if (characters > data.limits.maxTextCharacters)
              throw new DocumentError('import_text_too_large');
            paragraphs.push(text);
          } else if (key !== ':@') visit(value, depth + 1);
        }
  };
  visit(nodes);
  if (!paragraphs.some((line) => line.trim())) throw new DocumentError('import_document_no_text');
  return { text: boundedText(paragraphs.join('\n')), pageCount: null };
}
function decodeAscii85(input: Buffer): Buffer {
  const raw = input.toString('ascii').replace(/\s/g, '').replace(/^<~/, '');
  if (!raw.endsWith('~>')) invalid();
  const encoded = raw.slice(0, -2),
    output = Buffer.alloc(Math.min(4 * 1024 * 1024, Math.max(4, encoded.length * 4)));
  let written = 0,
    group: number[] = [];
  const emit = (values: number[], size = 4) => {
    const number = values.reduce((sum, value) => sum * 85 + value, 0);
    if (number > 0xffffffff) invalid();
    if (written + size > output.length) throw new DocumentError('import_document_expansion_limit');
    for (let index = 0; index < size; index++)
      output[written++] = Math.floor(number / 256 ** (3 - index)) & 255;
  };
  for (const character of encoded) {
    if (character === 'z') {
      if (group.length) invalid();
      emit([0, 0, 0, 0, 0]);
    } else {
      const value = character.charCodeAt(0) - 33;
      if (value < 0 || value > 84) invalid();
      group.push(value);
      if (group.length === 5) {
        emit(group);
        group = [];
      }
    }
  }
  if (group.length === 1) invalid();
  if (group.length) {
    const size = group.length - 1;
    while (group.length < 5) group.push(84);
    emit(group, size);
  }
  return output.subarray(0, written);
}
async function extractPdf() {
  if (Buffer.from(data.bytes).subarray(0, 5).toString('ascii') !== '%PDF-') invalid();
  // PDF.js can allocate decoded streams outside the V8 heap. Preflight the restricted
  // template container before loading it; unsupported filter/indirection layouts are
  // rejected instead of guessing or letting compressed streams expand without a bound.
  const bytes = Buffer.from(data.bytes),
    source = bytes.toString('latin1');
  const streams = /\bstream(?:\r\n|\n|\r)/g;
  let totalExpanded = 0,
    streamCount = 0,
    match: RegExpExecArray | null;
  while ((match = streams.exec(source))) {
    if (++streamCount > 1000) throw new DocumentError('import_document_expansion_limit');
    const object = source.lastIndexOf('obj', match.index),
      dictionary = source.slice(object + 3, match.index);
    if (object < 0 || /\/[A-Za-z0-9_-]*#[0-9a-fA-F]{2}/.test(dictionary))
      throw new DocumentError('import_pdf_filter_unsupported');
    const after = streams.lastIndex,
      end = source.indexOf('endstream', after);
    if (end < 0) invalid();
    const filter = /\/Filter\s*(\[[^\]]*\]|\/[A-Za-z0-9]+|[^\s<>]+)/.exec(dictionary)?.[1];
    const filters = filter
      ? [...filter.matchAll(/\/([A-Za-z0-9]+)/g)].map((entry) => entry[1]!)
      : [];
    if (
      filter &&
      (!filters.length ||
        filters.length > 2 ||
        filters.some(
          (entry) =>
            ![
              'ASCII85Decode',
              'A85',
              'FlateDecode',
              'Fl',
              'DCTDecode',
              'DCT',
              'JPXDecode',
            ].includes(entry),
        ) ||
        (filters.length === 2 && !['ASCII85Decode', 'A85'].includes(filters[0]!)))
    )
      throw new DocumentError('import_pdf_filter_unsupported');
    let content: Buffer = bytes.subarray(after, end);
    if (content[content.length - 1] === 10) content = content.subarray(0, -1);
    if (content[content.length - 1] === 13) content = content.subarray(0, -1);
    for (const encoding of filters) {
      if (encoding === 'ASCII85Decode' || encoding === 'A85') content = decodeAscii85(content);
      else if (encoding === 'FlateDecode' || encoding === 'Fl') {
        try {
          content = inflateSync(content, { maxOutputLength: 4 * 1024 * 1024 });
        } catch {
          throw new DocumentError('import_document_expansion_limit');
        }
      }
      // Raster filters are never rendered or decoded by this text-only preflight.
    }
    totalExpanded += content.length;
    if (totalExpanded > 32 * 1024 * 1024)
      throw new DocumentError('import_document_expansion_limit');
    streams.lastIndex = end + 'endstream'.length;
  }
  const pdf = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const task = pdf.getDocument({
    data: data.bytes,
    verbosity: 0,
    stopAtErrors: true,
    enableXfa: false,
    useWorkerFetch: false,
    useSystemFonts: false,
    disableFontFace: true,
    useWasm: false,
    disableRange: true,
    disableStream: true,
    disableAutoFetch: true,
  });
  try {
    const document = await task.promise;
    if (document.numPages > data.limits.maxPages) throw new DocumentError('import_pdf_page_limit');
    if (await document.hasJSActions()) throw new DocumentError('import_pdf_active_content');
    const lines: string[] = [];
    let characters = 0;
    for (let index = 1; index <= document.numPages; index++) {
      const page = await document.getPage(index),
        content = await page.getTextContent();
      let current = '',
        previousY: number | null = null,
        previousEnd: number | null = null;
      for (const item of content.items) {
        if (!('str' in item)) continue;
        const y = item.transform[5] as number;
        if (
          current &&
          previousY !== null &&
          Math.abs(y - previousY) > Math.max(1, item.height * 0.25)
        ) {
          lines.push(current);
          current = '';
          previousEnd = null;
        }
        const x = item.transform[4] as number;
        if (current && previousEnd !== null && x - previousEnd > Math.max(12, item.height * 2))
          throw new DocumentError('import_pdf_layout_unsupported');
        if (
          current &&
          previousEnd !== null &&
          x - previousEnd > Math.max(1, item.height * 0.2) &&
          !/\s$/.test(current) &&
          !/^\s/.test(item.str)
        )
          current += ' ';
        current += item.str;
        previousY = y;
        characters += item.str.length + 1;
        previousEnd = x + item.width;
        if (characters > data.limits.maxTextCharacters)
          throw new DocumentError('import_text_too_large');
        if (item.hasEOL) {
          lines.push(current);
          current = '';
          previousY = null;
          previousEnd = null;
        }
      }
      if (current) lines.push(current);
      page.cleanup();
    }
    if (!lines.some((line) => line.trim())) throw new DocumentError('import_document_no_text');
    return { text: boundedText(lines.join('\n')), pageCount: document.numPages };
  } finally {
    await task.destroy();
  }
}
try {
  const result = data.format === 'docx' ? await extractDocx() : await extractPdf();
  parentPort?.postMessage(result);
} catch (error) {
  parentPort?.postMessage({
    code: error instanceof DocumentError ? error.code : 'import_document_invalid',
  });
}
