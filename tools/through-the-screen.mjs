#!/usr/bin/env node
/**
 * The page, driven with a browser.
 *
 *     npm run check:screen
 *     npm run check:screen -- --show      with a visible browser
 *
 * A third layer, and it is not the same claim as the other two. `npm test` says
 * the parts work; `npm run walkthrough` says the API behaves over HTTP; only
 * this says a person can pick a client, get a token, send a document and watch
 * it happen.
 *
 * Two things live only here.
 *
 * **The stream.** `POST /api/read/live` returns NDJSON, and every defect in
 * reading it is invisible from the server side: a chunk boundary lands wherever
 * the network put it, routinely in the middle of a line, and a reader that
 * parses each chunk instead of each line throws on half an object. The server
 * sees a perfect response either way.
 *
 * **The refusals.** They are the reason the scopes exist, and a scope that is
 * only ever described is a scope nobody has seen. So this signs in as the
 * write-only client on purpose and confirms the page shows it being turned away
 * — which is the demonstration, not a failure of it.
 */

import { createRequire } from 'node:module';

const BASE = process.env.OCR_URL || 'http://localhost:3400';
const show = process.argv.includes('--show');

let chromium;
try {
  const require = createRequire(import.meta.url);
  ({ chromium } = require('playwright-core'));
} catch {
  console.error('playwright-core is not installed here, so this check cannot run.');
  console.error('It is a check, not a dependency: install it where you keep such things.');
  process.exit(2);
}

let failures = 0;

function expect(what, condition, detail) {
  if (condition) {
    console.log(`  ok    ${what}`);
  } else {
    failures += 1;
    console.log(`  FAIL  ${what}`);
    if (detail) console.log(`        ${detail}`);
  }
}

const browser = await chromium.launch({ channel: 'msedge', headless: !show });
const page = await browser.newPage({ viewport: { width: 1360, height: 1000 }, reducedMotion: 'reduce' });

/**
 * Anything the page THROWS is a failure, even when the screen still looks right.
 *
 * A refused request is not that. Half of what this check does is provoke a 401,
 * a 403 and a 422 on purpose, and the browser logs every one of them to the
 * console as "Failed to load resource" — so counting console errors made the
 * demonstration working look like the demonstration broken. That is a check
 * that fails for the wrong reason, and those get ignored rather than read.
 *
 * What is worth catching is a real exception and a real console error: a
 * property read off undefined, a JSON.parse on half a line.
 */
const thrown = [];
page.on('pageerror', (error) => thrown.push(`threw: ${error.message}`));
page.on('console', (message) => {
  if (message.type() !== 'error') return;
  if (/Failed to load resource/.test(message.text())) return;
  thrown.push(message.text());
});

const transcript = () => page.textContent('#transcript');

async function useClient(id) {
  await page.click(`[data-client="${id}"]`);
  await page.click('#getToken');
  await page.waitForTimeout(600);
}

try {
  console.log(`Driving ${BASE} through the screen\n`);

  await page.goto(BASE, { waitUntil: 'networkidle' });
  await page.waitForTimeout(800);

  // -------------------------------------------------------------- the shell
  console.log('What the page says about the service');

  expect(
    'it says what this copy can actually read',
    /text layers/.test((await page.textContent('#whereItReads')) ?? ''),
    await page.textContent('#whereItReads')
  );

  const engines = await page.locator('.engine').allTextContents();
  expect('and names both engines', engines.length === 2, engines.join(' | '));
  expect(
    'marking the one that cannot run as not ready',
    (await page.locator('.engine[data-ready="false"]').count()) === 1,
    'without a key the pixel engine is not available, and the page should say so before somebody needs it'
  );

  // ------------------------------------------------------------- a token
  console.log('\nGetting a token');

  await useClient('reader-and-writer');
  expect(
    'a good client gets one, and the page says what it may do',
    /ocr:read ocr:write/.test((await page.textContent('#tokenState')) ?? ''),
    await page.textContent('#tokenState')
  );

  // ---------------------------------------------------------- the stream
  console.log('\nWatching it work');

  await page.click('[data-sample="invoice.pdf"]');
  await page.waitForTimeout(700);

  expect(
    'a sample says which file it is, in the language of the page',
    (await page.textContent('#chosen')) === 'invoice.pdf',
    await page.textContent('#chosen')
  );

  await page.click('button[value="live"]');
  await page.waitForFunction(() => document.getElementById('text')?.textContent?.length > 100, {
    timeout: 20000,
  });
  await page.waitForTimeout(400);

  const streamed = await transcript();
  expect('the transcript reports the start', /started/.test(streamed));
  expect(
    'and each step as it happens, not all at the end',
    (streamed.match(/%\s·/g) ?? []).length >= 2,
    'a reader that parses chunks instead of lines shows one step or throws'
  );
  expect('and says which engine read it', /read by text-layer/.test(streamed));

  const shown = await page.textContent('#text');
  expect(
    'the words are on the screen, table and all',
    /Invoice 2026-0184/.test(shown) && /Nitrile gloves, medium 12 6\.20 74\.40/.test(shown),
    shown.split('\n').slice(0, 2).join(' / ')
  );

  const bar = await page.getAttribute('#progressFill', 'style');
  expect('and the progress bar finished', /width:\s*100%/.test(bar ?? ''), bar);

  // ------------------------------------------------------------ the other two
  console.log('\nThe other two ways');

  await page.click('button[value="wait"]');
  await page.waitForTimeout(1500);
  expect('waiting for it gives the same words', /read by text-layer/.test(await transcript()));

  await page.click('button[value="job"]');
  await page.waitForFunction(
    () => /collected after/.test(document.getElementById('transcript')?.textContent ?? ''),
    { timeout: 20000 }
  );
  expect('and so does coming back for it', /collected after/.test(await transcript()));

  // ------------------------------------------------------ what must not work
  console.log('\nThe refusals, which are the point of the scopes');

  await useClient('uploader');
  await page.click('button[value="job"]');
  await page.waitForTimeout(2500);

  const refused = await transcript();
  expect(
    'a client that may only submit is turned away when it tries to collect',
    /403/.test(refused) && /insufficient_scope|this needs ocr:read/.test(refused),
    refused.split('\n').slice(-4).join(' / ')
  );
  expect(
    'and is told what its token actually holds',
    /this token holds: ocr:write/.test(refused),
    'a refusal that does not say what you have is a refusal nobody can act on'
  );

  await useClient('retired');
  expect(
    'a client switched off in the file gets no token at all',
    /401|not accepted/.test((await page.textContent('#tokenState')) ?? ''),
    await page.textContent('#tokenState')
  );

  await useClient('reader-and-writer');
  await page.click('[data-sample="scan.png"]');
  await page.waitForTimeout(700);
  await page.click('button[value="wait"]');
  await page.waitForTimeout(2000);

  const noText = await transcript();
  expect(
    'a page with no text in it is refused with a reason, not answered with nothing',
    /422/.test(noText) && /MISTRAL_API_KEY/.test(noText),
    noText.split('\n').slice(-4).join(' / ')
  );

  // ------------------------------------------------------------ and quietly
  expect(
    'nothing on the page threw along the way',
    thrown.length === 0,
    thrown.join(' | ')
  );

  console.log('');
  if (failures > 0) {
    console.log(`${failures} checks failed.`);
    process.exitCode = 1;
  } else {
    console.log('Somebody can hold this service in their hands, refusals included.');
  }
} catch (error) {
  console.error(`\nThe journey stopped: ${error.message.split('\n')[0]}`);
  process.exitCode = 1;
} finally {
  await browser.close();
}
