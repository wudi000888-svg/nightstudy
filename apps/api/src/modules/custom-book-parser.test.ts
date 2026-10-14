import { describe, expect, it } from 'vitest';
import { zipSync, strToU8 } from 'fflate';
import { readFileSync } from 'node:fs';
import { deflateSync } from 'node:zlib';
import {
  bookTemplateHeader,
  decodeBookUpload,
  parseBookFile,
  parseBookLines,
} from './custom-book-parser.js';

export function docxFixture(
  text: string[],
  options: { dtd?: boolean; macro?: boolean; table?: boolean } = {},
) {
  const escape = (value: string) =>
    value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
  return zipSync(
    {
      '[Content_Types].xml': strToU8(
        `<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Override PartName="/word/document.xml" ContentType="${options.macro ? 'application/vnd.ms-word.document.macroEnabled.main+xml' : 'application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml'}"/></Types>`,
      ),
      'word/document.xml': strToU8(
        `${options.dtd ? '<!DOCTYPE w:document [<!ENTITY external SYSTEM "http://127.0.0.1/private">]>' : ''}<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${options.table ? '<w:tbl><w:tr><w:tc>' : ''}${text.map((line) => `<w:p><w:r><w:t>${escape(line)}</w:t></w:r></w:p>`).join('')}${options.table ? '</w:tc></w:tr></w:tbl>' : ''}</w:body></w:document>`,
      ),
    },
    { level: 6 },
  );
}
export function pdfFixture(lines: string[], pages = 1, javascript = false) {
  const escape = (value: string) =>
    value.replaceAll('\\', '\\\\').replaceAll('(', '\\(').replaceAll(')', '\\)');
  const objects: string[] = [];
  const firstPage = 3,
    fontId = firstPage + pages,
    contentId = fontId + 1,
    jsId = contentId + pages;
  objects.push(`<< /Type /Catalog /Pages 2 0 R${javascript ? ` /OpenAction ${jsId} 0 R` : ''} >>`);
  objects.push(
    `<< /Type /Pages /Kids [${Array.from({ length: pages }, (_, index) => `${firstPage + index} 0 R`).join(' ')}] /Count ${pages} >>`,
  );
  for (let page = 0; page < pages; page++)
    objects.push(
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 ${fontId} 0 R >> >> /Contents ${contentId + page} 0 R >>`,
    );
  objects.push('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>');
  for (let page = 0; page < pages; page++) {
    const content = `BT /F1 12 Tf 40 760 Td ${page === 0 ? lines.map((line, index) => `${index ? '0 -18 Td ' : ''}(${escape(line)}) Tj`).join('\n') : ''} ET`;
    objects.push(`<< /Length ${Buffer.byteLength(content)} >>\nstream\n${content}\nendstream`);
  }
  if (javascript) objects.push('<< /S /JavaScript /JS (app.alert\(test\)) >>');
  let output = '%PDF-1.7\n',
    offsets = [0];
  for (let index = 0; index < objects.length; index++) {
    offsets.push(Buffer.byteLength(output));
    output += `${index + 1} 0 obj\n${objects[index]}\nendobj\n`;
  }
  const xref = Buffer.byteLength(output);
  output += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets
    .slice(1)
    .map((offset) => `${String(offset).padStart(10, '0')} 00000 n \n`)
    .join('')}trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(output);
}

describe('standard private wordbook parser', () => {
  it('keeps original line numbers, canonical exact phrases, invalid rows and duplicates explicit', () => {
    const rows = parseBookLines(
      `\uFEFF${bookTemplateHeader}\r\nRain\r\n\r\nrain\r\nice cream\r\n1. window\r\n中文\r\ncan't\r\n`,
    );
    expect(rows.map((row) => [row.lineNumber, row.status])).toEqual([
      [2, 'ready'],
      [4, 'duplicate'],
      [5, 'ready'],
      [6, 'failed'],
      [7, 'failed'],
      [8, 'ready'],
    ]);
    expect(rows[1]?.duplicateOfLine).toBe(2);
    expect(rows[2]?.normalizedLemma).toBe('ice cream');
  });
  it('requires the exact standard header and bounds rows, text and base64 upload bytes', () => {
    expect(() => parseBookLines('Word List\nrain')).toThrow('import_template_header_missing');
    expect(() => parseBookLines(`${bookTemplateHeader}\n${'rain\n'.repeat(10001)}`)).toThrow(
      'import_too_many_rows',
    );
    expect(() => parseBookLines(`${bookTemplateHeader}\n${'a'.repeat(512000)}`)).toThrow(
      'import_text_too_large',
    );
    expect(() => decodeBookUpload('txt', '../words.txt', 'cmFpbg==')).toThrow(
      'import_filename_invalid',
    );
    expect(() => decodeBookUpload('txt', 'words.txt', 'cmFpbg')).toThrow('import_base64_invalid');
    expect(() =>
      decodeBookUpload('txt', 'words.txt', Buffer.alloc(256 * 1024 + 1).toString('base64')),
    ).toThrow('import_file_too_large');
  });
  it('accepts UTF-8 text and rejects corrupt encoding instead of replacing characters', async () => {
    expect(
      (await parseBookFile('txt', Buffer.from(`${bookTemplateHeader}\nrain\n`))).rows[0]
        ?.normalizedLemma,
    ).toBe('rain');
    await expect(parseBookFile('txt', Buffer.from([0xc3, 0x28]))).rejects.toMatchObject({
      code: 'import_text_not_utf8',
    });
  });
  it('extracts only ordinary DOCX paragraphs in an isolated worker', async () => {
    const result = await parseBookFile(
      'docx',
      docxFixture([bookTemplateHeader, 'rain', 'ice cream']),
    );
    expect(result.rows.map((row) => row.normalizedLemma)).toEqual(['rain', 'ice cream']);
  });
  it('rejects DOCX macros, DTD entities, tables, corrupt archives and declared expansion bombs', async () => {
    await expect(
      parseBookFile('docx', docxFixture([bookTemplateHeader, 'rain'], { macro: true })),
    ).rejects.toMatchObject({ code: 'import_docx_active_content' });
    await expect(
      parseBookFile('docx', docxFixture([bookTemplateHeader, 'rain'], { dtd: true })),
    ).rejects.toMatchObject({ code: 'import_xml_entities_rejected' });
    await expect(
      parseBookFile('docx', docxFixture([bookTemplateHeader, 'rain'], { table: true })),
    ).rejects.toMatchObject({ code: 'import_docx_layout_unsupported' });
    await expect(parseBookFile('docx', Buffer.from('not-a-zip'))).rejects.toMatchObject({
      code: 'import_document_invalid',
    });
    const bomb = Buffer.from(docxFixture([bookTemplateHeader, 'rain']));
    const directory = bomb.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]));
    bomb.writeUInt32LE(0x20000000, directory + 24);
    await expect(parseBookFile('docx', bomb)).rejects.toMatchObject({
      code: 'import_document_expansion_limit',
    });
    const damaged = Buffer.from(docxFixture([bookTemplateHeader, 'rain']));
    const central = damaged.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]));
    damaged.writeUInt32LE(0, central + 16);
    await expect(parseBookFile('docx', damaged)).rejects.toMatchObject({
      code: 'import_document_invalid',
    });
  });
  it('extracts a standard PDF text layer without OCR and rejects scripts, excess pages or corrupt PDF', async () => {
    const result = await parseBookFile('pdf', pdfFixture([bookTemplateHeader, 'rain', 'window']));
    expect(result.pageCount).toBe(1);
    expect(result.rows.map((row) => row.normalizedLemma)).toEqual(['rain', 'window']);
    await expect(
      parseBookFile('pdf', pdfFixture([bookTemplateHeader, 'rain'], 1, true)),
    ).rejects.toMatchObject({ code: 'import_pdf_active_content' });
    await expect(
      parseBookFile('pdf', pdfFixture([bookTemplateHeader, 'rain'], 251)),
    ).rejects.toMatchObject({ code: 'import_pdf_page_limit' });
    await expect(parseBookFile('pdf', pdfFixture([]))).rejects.toMatchObject({
      code: 'import_document_no_text',
    });
    await expect(parseBookFile('pdf', Buffer.from('%PDF-1.7 broken'))).rejects.toMatchObject({
      code: 'import_document_invalid',
    });
  });
  it('bounds live document parsers at two actual workers and releases capacity after they finish', async () => {
    const bytes = docxFixture([bookTemplateHeader, 'rain']);
    const first = parseBookFile('docx', bytes),
      second = parseBookFile('docx', bytes);
    await expect(parseBookFile('docx', bytes)).rejects.toMatchObject({
      code: 'import_parser_busy',
      statusCode: 429,
    });
    await Promise.all([first, second]);
    expect((await parseBookFile('docx', bytes)).rows[0]?.normalizedLemma).toBe('rain');
  });
  it('accepts all three distributed standard template files through the real parser', async () => {
    for (const format of ['txt', 'docx', 'pdf'] as const) {
      const bytes = readFileSync(
        new URL(
          `../../../../docs/templates/nightstudy-wordbook-template.${format}`,
          import.meta.url,
        ),
      );
      const result = await parseBookFile(format, bytes);
      expect(
        result.rows.some((row) => row.normalizedLemma === 'rain' && row.status === 'ready'),
      ).toBe(true);
      expect(result.rows.every((row) => row.status === 'ready')).toBe(true);
    }
  });
  it('accepts a 1001-entry standard TXT without the former 1000-row truncation', async () => {
    const lines = Array.from(
      { length: 1001 },
      (_, index) =>
        `entry${String.fromCharCode(97 + Math.floor(index / 676), 97 + (Math.floor(index / 26) % 26), 97 + (index % 26))}`,
    );
    const result = await parseBookFile(
      'txt',
      Buffer.from([bookTemplateHeader, ...lines].join('\n')),
    );
    expect(result.rows).toHaveLength(1001);
    expect(result.rows.every((row) => row.status === 'ready')).toBe(true);
  });
  it('rejects compressed PDF stream expansion before PDF.js allocates the decoded content', async () => {
    const compressed = deflateSync(Buffer.alloc(5 * 1024 * 1024, 65));
    const bytes = Buffer.concat([
      Buffer.from(
        `%PDF-1.7\n1 0 obj\n<< /Length ${compressed.length} /Filter /FlateDecode >>\nstream\n`,
      ),
      compressed,
      Buffer.from('\nendstream\nendobj\n%%EOF'),
    ]);
    await expect(parseBookFile('pdf', bytes)).rejects.toMatchObject({
      code: 'import_document_expansion_limit',
    });
  });
});
