#!/usr/bin/env node
/**
 * The page, driven with a browser.
 *
 *     npm run check:screen
 *     npm run check:screen -- --show      with a visible browser
 *
 * A third layer, and it is not the same claim as the other two. `npm test` says
 * the parts work; `npm run walkthrough` says the API behaves over HTTP; only
 * this says a person can arrive, read a document, and see what happened.
 *
 * ── The check this file exists for now ───────────────────────────────────────
 *
 * The first assertion below — **arriving and reading, having touched nothing
 * else** — is here because of a real report. The page used to open with
 * "1 — Get a token", and somebody who came to try it read that as the service
 * asking for an API key it had not been given, which is the opposite of what
 * this project demonstrates: it reads most PDFs with no account anywhere.
 *
 * Nothing in `npm test` or the walkthrough could have caught that. The API was
 * right the whole time. What was wrong was the order of the page, and the only
 * way to check the order of a page is to arrive at it.
 *
 * Two other things live only here.
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

import { startTheService } from './with-the-service.mjs';

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
let checks = 0;

function expect(what, condition, detail) {
  checks += 1;

  if (condition) {
    console.log(`  ok    ${what}`);
  } else {
    failures += 1;
    console.log(`  FAIL  ${what}`);
    if (detail) console.log(`        ${detail}`);
  }
}

// A service of its own, on a port nothing else uses. This used to expect
// somebody to have started one -- which meant it could not run on a clean
// machine, and passed against whatever was on 3400 when it could.
const service = await startTheService();
const BASE = service.base;

const browser = await chromium.launch({ channel: 'msedge', headless: !show });
const page = await browser.newPage({ viewport: { width: 1360, height: 1100 }, reducedMotion: 'reduce' });

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

/** Sign in as one of the demonstration clients. The fold has to be open first. */
async function useClient(id) {
  await page.evaluate(() => {
    document.getElementById('boundaryFold').open = true;
  });
  await page.click(`[data-client="${id}"]`);
  await page.waitForTimeout(800);
}

async function readIt(way = 'wait') {
  await page.selectOption('#way', way);
  await page.click('#readIt');
}

try {
  console.log(`Driving ${BASE} through the screen\n`);

  await page.goto(BASE, { waitUntil: 'networkidle' });
  await page.waitForTimeout(900);

  // ---------------------------------------------- arriving, and just reading
  //
  // Before anything else, because it is what everybody else does first.
  console.log('Arriving, and reading something, having touched nothing else');

  expect(
    'the token is taken on arrival, so nothing is in the way',
    /ocr:read ocr:write/.test((await page.textContent('#tokenState')) ?? ''),
    await page.textContent('#tokenState')
  );

  expect(
    'and the page does not put authenticating in front of anybody',
    !/1\s*—\s*Get a token/.test((await page.textContent('main')) ?? ''),
    'a first step that says "get a token" reads as "this service wants a key"'
  );

  await page.click('[data-sample="invoice.pdf"]');
  await page.waitForTimeout(700);

  expect(
    'a sample says which file it is, in the language of the page',
    (await page.textContent('#chosen')) === 'invoice.pdf',
    await page.textContent('#chosen')
  );

  await readIt('wait');
  await page.waitForFunction(() => document.getElementById('text')?.textContent?.length > 100, { timeout: 20000 });

  expect(
    'a document is read with two clicks and nothing set up',
    /Invoice 2026-0184/.test((await page.textContent('#text')) ?? ''),
    'this is the whole claim of the project: no account, no key, it reads the text that is already there'
  );

  // --------------------------------------------------- saying what it can do
  console.log('\nWhat the page says about the service');

  const mode = (await page.textContent('#mode')) ?? '';
  expect(
    'it says up front whether a key is set, before anybody needs one',
    /No API key is set/.test(mode) || /An API key is set/.test(mode),
    mode.slice(0, 140)
  );
  expect(
    'and, with no key, what that does and does not stop',
    !/No API key is set/.test(mode) || (/carries its own text/.test(mode) && /MISTRAL_API_KEY/.test(mode)),
    mode.slice(0, 240)
  );

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

  // ------------------------------------------------------------ the decision
  console.log('\nThe decision, shown');

  const chain = await page.locator('#chain li').allTextContents();
  expect('the engine chain is drawn', chain.length >= 1, chain.join(' | '));
  expect(
    'and the one that read it is marked as such',
    (await page.locator('#chain li[data-outcome="read"] .who').first().textContent()) === 'text-layer',
    chain.join(' | ')
  );
  expect(
    'with a line saying what read it',
    /Read by/.test((await page.textContent('#howSays')) ?? ''),
    await page.textContent('#howSays')
  );

  // --------------------------------------------------------------- the stream
  console.log('\nWatching it work');

  await readIt('live');
  await page.waitForFunction(() => document.getElementById('text')?.textContent?.length > 100, { timeout: 20000 });
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

  // ------------------------------------------------------------- the third way
  console.log('\nThe third way');

  await readIt('job');
  await page.waitForFunction(() => /collected after/.test(document.getElementById('transcript')?.textContent ?? ''), {
    timeout: 20000,
  });
  expect('taking an id and coming back gives the same words', /collected after/.test(await transcript()));

  // -------------------------------------------- the scan, which is not a fault
  console.log('\nA page with no text in it');

  await page.click('[data-sample="scan.png"]');
  await page.waitForTimeout(700);
  await readIt('wait');
  await page.waitForTimeout(2500);

  const noText = await transcript();
  expect(
    'it is refused with a reason and the variable that changes it',
    /422/.test(noText) && /MISTRAL_API_KEY/.test(noText),
    noText.split('\n').slice(-4).join(' / ')
  );

  const howSays = (await page.textContent('#howSays')) ?? '';
  expect(
    'and the page calls it the EXPECTED answer rather than a breakage',
    /expected answer/i.test(howSays) && /MISTRAL_API_KEY/.test(howSays),
    'a service with no key refusing a scan is doing exactly what it says it does; showing that as an ' +
      'error teaches the visitor the project is broken'
  );

  // -------------------------------------------------------- what must not work
  console.log('\nThe refusals, which are the point of the scopes');

  await useClient('uploader');
  await page.click('[data-sample="invoice.pdf"]');
  await page.waitForTimeout(600);
  await readIt('job');
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

  // -------------------------------------------------------------- and quietly
  expect('nothing on the page threw along the way', thrown.length === 0, thrown.join(' | '));

  console.log('');
  if (failures > 0) {
    console.log(`${failures} of ${checks} checks failed.`);
    process.exitCode = 1;
  } else {
    console.log(`${checks} checks: somebody can arrive, read a document, and see why — refusals included.`);
  }
} catch (error) {
  console.error(`\nThe journey stopped: ${error.message.split('\n')[0]}`);
  process.exitCode = 1;
} finally {
  await browser.close();
  await service.stop();
}
