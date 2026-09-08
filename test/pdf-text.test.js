import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import { readPdfText } from '../src/ocr/pdf-text.js';

/**
 * Against the sample documents, which a browser wrote and this project did not.
 *
 * A PDF reader tested only against PDFs the same repository also produced is a
 * reader tested against its own assumptions. It will agree with itself about
 * glyph codes, compression and where a line ends, and fall over on the first
 * file anybody actually has. Everything asserted below broke once on a real
 * file, which is why it is asserted.
 */

const here = path.dirname(fileURLToPath(import.meta.url));
const SAMPLES = path.join(here, '..', 'samples');

const sample = (name) => fs.readFileSync(path.join(SAMPLES, name));

describe('reading the text layer of a real PDF', () => {
  it('gives back the words that are on the page', () => {
    const { text } = readPdfText(sample('invoice.pdf'));

    assert.match(text, /Invoice 2026-0184/);
    assert.match(text, /Harbour Medical Supplies Ltd/);
    assert.match(text, /Total due EUR 128\.10 by 2 May 2026\./);
  });

  it('keeps the headings whole', () => {
    // A browser draws a heading one glyph at a time, moving the cursor between
    // each with a RELATIVE `Td`. Reading that as an absolute move put the first
    // letter of every heading on a line by itself: "I" and then "nvoice".
    const { text } = readPdfText(sample('invoice.pdf'));

    assert.ok(
      text.split('\n').includes('Invoice 2026-0184'),
      `the first line was ${JSON.stringify(text.split('\n').slice(0, 3))}`
    );
  });

  it('separates the cells of a table row', () => {
    // Four runs at the same height and different x. Without the glyph widths
    // there is no way to tell that from a sentence with a bold word in it, and
    // the row arrived as "Nitrile gloves, medium126.2074.40".
    const { text } = readPdfText(sample('invoice.pdf'));

    assert.match(text, /Nitrile gloves, medium 12 6\.20 74\.40/);
    assert.match(text, /Examination couch roll 3 11\.90 35\.70/);
  });

  it('does not put spaces inside words', () => {
    // The other half of the same decision. A threshold low enough to separate
    // table cells but too low for kerning breaks every long word instead.
    const { text } = readPdfText(sample('invoice.pdf'));

    assert.match(text, /Examination/);
    assert.doesNotMatch(text, /Exam ination|Nitri le|medi um/);
  });

  it('reads every page, not only the first', () => {
    const { text, pages } = readPdfText(sample('two-pages.pdf'));

    assert.equal(pages.length, 2);
    assert.match(text, /Terms of supply/);
    assert.match(text, /Schedule of charges/);
  });

  it('keeps a wrapped paragraph as lines rather than as one', () => {
    const { text } = readPdfText(sample('letter.pdf'));
    const lines = text.split('\n').filter((line) => line.trim());

    assert.ok(lines.length > 6, `the letter came back as ${lines.length} lines`);
    assert.match(text, /JD0002234567/);
  });

  it('says what it did, in words that mean something', () => {
    const { why } = readPdfText(sample('two-pages.pdf'));
    assert.equal(why, 'read from the text layer of 2 pages');
  });
});

describe('when there is nothing to read', () => {
  it('declines a file that is not a PDF instead of returning nothing', () => {
    // The distinction the whole engine turns on. An empty string could mean
    // "this page is blank" or "this reader cannot open it", and the caller has
    // to be able to tell, because only one of them is worth paying an OCR
    // engine for.
    const { text, why } = readPdfText(sample('scan.png'));

    assert.equal(text, '');
    assert.equal(why, 'this is not a PDF');
  });

  it('declines an empty buffer', () => {
    const { text, why } = readPdfText(Buffer.alloc(0));

    assert.equal(text, '');
    assert.equal(why, 'this is not a PDF');
  });

  it('declines a PDF header with nothing behind it', () => {
    const { text, why } = readPdfText(Buffer.from('%PDF-1.7\n%%EOF\n'));

    assert.equal(text, '');
    assert.match(why, /no objects|no pages/);
  });

  it('does not throw on a file that has been truncated', () => {
    // Half a PDF is what arrives when an upload is interrupted, and a reader
    // that throws on it turns somebody's bad connection into a 500.
    const half = sample('invoice.pdf').subarray(0, 4000);

    assert.doesNotThrow(() => readPdfText(half));
    assert.equal(typeof readPdfText(half).text, 'string');
  });

  it('does not throw on bytes that are not a document at all', () => {
    const noise = Buffer.from(Array.from({ length: 2048 }, (_, at) => (at * 37) % 256));

    assert.doesNotThrow(() => readPdfText(noise));
  });
});

/**
 * How wide a character code is, which this reader used to assume.
 *
 * A string in a content stream is a run of CODES, and what each one means comes
 * from the font's own CMap. So does how many bytes one code takes, and that is
 * the part that was guessed: four hex digits at a time, because an Identity-H
 * CID font uses two bytes per glyph and the samples above all do.
 *
 * A font with single-byte codes writes `<010203>` and means three glyphs. Read
 * two bytes at a time it becomes `0x0102` and half of another, neither of which
 * is in the map, so every lookup returned nothing. The page then had no text,
 * and a document with a perfectly good text layer was refused as a scan whose
 * pixels would have to be recognised — which here means sending it to a paid
 * engine, or refusing it outright.
 *
 * These fixtures are built here rather than added to `samples/`: the defect is
 * small enough to write down exactly, and the sample documents were all written
 * by a browser, which is how a reader ends up tested against one producer.
 */

/**
 * The smallest PDF that carries a text layer: one page, one font, one CMap.
 *
 * @param {{codespace: string, chars: [string, string][], shown: string}} what
 *   `codespace` is the low bound of the code space range, and its LENGTH is
 *   what declares the width. `chars` map codes to characters. `shown` is the
 *   hex string the page draws.
 */
function pdfWith({ codespace, chars, shown }) {
  const cmap = [
    '/CIDInit /ProcSet findresource begin 12 dict begin begincmap',
    '/CMapName /Adobe-Identity-UCS def',
    '/CMapType 2 def',
    `1 begincodespacerange\n<${codespace}> <${'F'.repeat(codespace.length)}>\nendcodespacerange`,
    `${chars.length} beginbfchar`,
    ...chars.map(([code, unicode]) => `<${code}> <${unicode}>`),
    'endbfchar',
    'endcmap end end',
  ].join('\n');

  const content = `BT 72 720 Td /F1 12 Tf<${shown}>Tj ET`;

  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>',
    `<< /Length ${content.length} >>\nstream\n${content}\nendstream`,
    '<< /Type /Font /Subtype /TrueType /BaseFont /Test /ToUnicode 6 0 R >>',
    `<< /Length ${cmap.length} >>\nstream\n${cmap}\nendstream`,
  ];

  let out = '%PDF-1.4\n';
  objects.forEach((body, at) => {
    out += `${at + 1} 0 obj\n${body}\nendobj\n`;
  });
  out += 'trailer\n<< /Root 1 0 R >>\n%%EOF';

  return Buffer.from(out, 'latin1');
}

describe('a font whose codes are one byte wide', () => {
  const ONE_BYTE = pdfWith({
    codespace: '00',
    chars: [
      ['01', '0052'],
      ['02', '006F'],
      ['03', '0077'],
    ],
    shown: '010203',
  });

  it('is read, rather than refused as a scan', () => {
    const read = readPdfText(ONE_BYTE);

    assert.equal(read.text, 'Row');
    assert.match(read.why, /read from the text layer/);
  });

  it('and the same word from a two-byte font is still read', () => {
    // The case this reader was built against, which the fix must not cost.
    const wide = pdfWith({
      codespace: '0000',
      chars: [
        ['0001', '0052'],
        ['0002', '006F'],
        ['0003', '0077'],
      ],
      shown: '000100020003',
    });

    assert.equal(readPdfText(wide).text, 'Row');
  });
});

describe('the width comes from the CMap and not from the string', () => {
  it('so identical bytes say different things under the two declarations', () => {
    // The whole fix in one assertion. A reader that decides for itself gets one
    // of these two wrong, always, and cannot tell which.
    const asOne = pdfWith({
      codespace: '00',
      chars: [
        ['01', '0041'],
        ['02', '0042'],
      ],
      shown: '0102',
    });
    const asTwo = pdfWith({ codespace: '0000', chars: [['0102', '005A']], shown: '0102' });

    assert.equal(readPdfText(asOne).text, 'AB');
    assert.equal(readPdfText(asTwo).text, 'Z');
  });

  it('and a CMap that declares nothing is read as two, which is where this started', () => {
    const silent = pdfWith({ codespace: '0000', chars: [['0001', '0058']], shown: '0001' });
    const withoutRange = Buffer.from(
      silent.toString('latin1').replace(/1 begincodespacerange[\s\S]*?endcodespacerange\n/, ''),
      'latin1'
    );

    assert.equal(readPdfText(withoutRange).text, 'X');
  });
});
