#!/usr/bin/env node
/**
 * The sample documents, printed by a real browser.
 *
 *     npm run samples
 *
 * They are produced rather than hand-written, and produced **by something other
 * than this project**, which is the whole point. A PDF reader tested only
 * against PDFs the same repository also wrote is a reader tested against its own
 * assumptions: it will agree with itself about glyph codes, compression and
 * where a line ends, and fall over on the first file anybody actually has.
 *
 * A browser's print-to-PDF gives exactly the awkward things a real document
 * has — subset fonts whose codes are not characters, Flate-compressed streams,
 * text placed by matrix rather than by line, kerning written as cursor moves.
 * Every one of those broke the reader once.
 *
 * The PNG is the other half of the argument: a page with no text layer at all.
 * The text-layer engine must **decline** it rather than return an empty string
 * and call that a result.
 *
 * The files are committed, so nobody needs a browser to run the tests. Re-run
 * this only to change what the samples say.
 */

import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const SAMPLES = path.join(here, '..', 'samples');

let chromium;
try {
  const require = createRequire(import.meta.url);
  ({ chromium } = require('playwright-core'));
} catch {
  console.error('playwright-core is not installed here, so the samples cannot be remade.');
  console.error('They are committed; this is only needed to change what they say.');
  process.exit(2);
}

const PAPER = `
  <style>
    body { font-family: Georgia, 'Times New Roman', serif; margin: 0; padding: 46px 54px; color: #111; }
    h1 { font-size: 21px; margin: 0 0 2px; letter-spacing: -0.01em; }
    .who { font-size: 12px; color: #555; margin: 0 0 26px; line-height: 1.5; }
    table { width: 100%; border-collapse: collapse; font-size: 12.5px; margin: 18px 0; }
    th { text-align: left; border-bottom: 1px solid #999; padding: 5px 0; font-size: 10.5px;
         text-transform: uppercase; letter-spacing: 0.06em; color: #555; }
    td { padding: 6px 0; border-bottom: 1px solid #e2e2e2; }
    td.n { text-align: right; font-variant-numeric: tabular-nums; }
    .total { font-size: 14px; margin-top: 16px; }
    .note { font-size: 11px; color: #666; margin-top: 30px; line-height: 1.6; }
  </style>
`;

const DOCUMENTS = {
  'invoice.pdf': `
    ${PAPER}
    <h1>Invoice 2026-0184</h1>
    <p class="who">
      Harbour Medical Supplies Ltd — 14 Quay Street<br />
      To: Northgate Clinic, 12 Marsh Lane<br />
      Issued 2 April 2026 · Terms 30 days
    </p>
    <table>
      <thead><tr><th>Item</th><th>Qty</th><th class="n">Unit</th><th class="n">Amount</th></tr></thead>
      <tbody>
        <tr><td>Nitrile gloves, medium</td><td>12</td><td class="n">6.20</td><td class="n">74.40</td></tr>
        <tr><td>Alcohol wipes</td><td>4</td><td class="n">4.50</td><td class="n">18.00</td></tr>
        <tr><td>Examination couch roll</td><td>3</td><td class="n">11.90</td><td class="n">35.70</td></tr>
      </tbody>
    </table>
    <p class="total"><strong>Total due EUR 128.10</strong> by 2 May 2026.</p>
    <p class="note">
      Purchase order PO-4471. Payment to account GB00 EXAM 0000 0000 0000 00.
      Queries to accounts at the address above. Everything on this page is invented.
    </p>
  `,

  'letter.pdf': `
    ${PAPER}
    <h1>Delivery note DN-88120</h1>
    <p class="who">Harbour Medical Supplies Ltd<br />Despatched 13 April 2026</p>
    <p style="font-size:13px;line-height:1.7">
      Dear Ms Rossi,<br /><br />
      The three items on purchase order PO-4471 left our depot this morning and are
      with the carrier. The tracking number is JD0002234567 and delivery is expected
      before 17:00 on Wednesday.<br /><br />
      One line was short: we sent two boxes of alcohol wipes rather than four, and the
      remaining two follow next week at no extra charge.<br /><br />
      Yours sincerely,<br />
      Despatch
    </p>
    <p class="note">Invented, like everything else in this folder.</p>
  `,

  // Two pages, because a reader that joins pages wrongly looks correct on one.
  'two-pages.pdf': `
    ${PAPER}
    <h1>Terms of supply</h1>
    <p style="font-size:12.5px;line-height:1.7">
      1. Prices hold for ninety days from the date of quotation.<br />
      2. Delivery dates are estimates and not guarantees.<br />
      3. Short deliveries are made good within fourteen days.
    </p>
    <div style="page-break-before: always"></div>
    <h1>Schedule of charges</h1>
    <p style="font-size:12.5px;line-height:1.7">
      Carriage is charged at cost below EUR 250 and is free above it.<br />
      Returns accepted within 30 days, unopened, at the buyer's expense.
    </p>
  `,
};

/**
 * The same date every time, in place of the one the browser stamped.
 *
 * `D:` and fourteen digits is a fixed-width field, so this is a substitution
 * and not a rewrite: the file keeps its length, and every byte offset in the
 * cross-reference table still points where it did. Doing it any other way
 * means renumbering the xref, which is a lot of work to change a date nobody
 * reads.
 *
 * latin1 both ways because it maps bytes one to one: this is a binary file
 * being edited as text, and any other encoding would rewrite the compressed
 * streams on the way through.
 */
function withoutTheClock(pdf) {
  return Buffer.from(
    pdf.toString('latin1').replace(/D:[0-9]{14}/g, 'D:20260101000000'),
    'latin1'
  );
}

fs.mkdirSync(SAMPLES, { recursive: true });

const browser = await chromium.launch({ channel: 'msedge' });

try {
  const page = await browser.newPage();

  for (const [name, html] of Object.entries(DOCUMENTS)) {
    await page.setContent(html, { waitUntil: 'load' });

    // Through a buffer, so the clock can be taken out of it before the file
    // lands. Chromium stamps /CreationDate and /ModDate with the wall clock,
    // so re-running this produced three files that differed from the committed
    // ones by ten bytes and nothing else. That is enough to dirty the working
    // tree for no reason, and enough that nobody can check the samples are the
    // samples.
    const pdf = await page.pdf({ format: 'A4', printBackground: true });
    fs.writeFileSync(path.join(SAMPLES, name), withoutTheClock(pdf));

    console.log(`  samples/${name}`);
  }

  // A page with no text layer: the same letter, rendered to pixels. The
  // text-layer engine has to say it cannot read this rather than return nothing
  // and call it an answer.
  const shot = await browser.newPage({ viewport: { width: 820, height: 1060 } });
  await shot.setContent(DOCUMENTS['letter.pdf'], { waitUntil: 'load' });
  await shot.screenshot({ path: path.join(SAMPLES, 'scan.png') });
  console.log('  samples/scan.png');

  console.log('\nProduced by a browser, not by this project. That is the point.');
} finally {
  await browser.close();
}
