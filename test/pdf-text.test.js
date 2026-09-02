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
