#!/usr/bin/env node
/**
 * The pictures in the README, taken from the running service.
 *
 *     npm run screenshots
 *
 * In the repository as a script rather than as files somebody cropped by hand,
 * for the same reason the mark is drawn and not exported: a picture made once
 * drifts from the thing it is a picture of, and a README showing a screen that
 * no longer exists is worse than a README with no pictures.
 */

import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

import { startTheService } from './with-the-service.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const DOCS = path.join(here, '..', 'docs');

let chromium;
try {
  const require = createRequire(import.meta.url);
  ({ chromium } = require('playwright-core'));
} catch {
  console.error('playwright-core is not installed here, so the pictures cannot be retaken.');
  process.exit(2);
}

fs.mkdirSync(DOCS, { recursive: true });

// Its own service, so the pictures in the README are always of THIS
// commit -- not of whatever was left running on 3400.
const service = await startTheService();
const BASE = service.base;

const browser = await chromium.launch({ channel: 'msedge' });
const say = (name) => console.log(`  docs/${name}`);

try {
  const page = await browser.newPage({
    viewport: { width: 1360, height: 1000 },
    deviceScaleFactor: 2,
    reducedMotion: 'reduce',
  });

  await page.goto(BASE, { waitUntil: 'networkidle' });
  await page.waitForTimeout(900);

  const readIt = async (target, way) => {
    await target.selectOption('#way', way);
    await target.click('#readIt');
  };

  const signInAs = async (who) => {
    await page.evaluate(() => {
      document.getElementById('boundaryFold').open = true;
    });
    await page.click(`[data-client="${who}"]`);
    await page.waitForTimeout(700);
  };

  // The page as somebody arrives at it: what it can read, said at the top, and
  // one place to put a document. Nothing asked for first.
  await page.screenshot({ path: path.join(DOCS, 'panel.png'), fullPage: true });
  say('panel.png');

  // The whole journey, ending with the stream having run and the engine chain
  // showing which one read it. This is the picture that says what the project is.
  await page.click('[data-sample="invoice.pdf"]');
  await page.waitForTimeout(600);
  await readIt(page, 'live');
  await page.waitForFunction(() => document.getElementById('text')?.textContent?.length > 100, {
    timeout: 20000,
  });
  await page.waitForTimeout(500);

  await page.screenshot({ path: path.join(DOCS, 'read.png'), fullPage: true });
  say('read.png');

  // A scan with no key: the expected answer, and said as one. This is the
  // picture that stops somebody concluding the service is broken.
  await page.click('[data-sample="scan.png"]');
  await page.waitForTimeout(600);
  await readIt(page, 'wait');
  await page.waitForTimeout(2000);

  await page.locator('#howCard').screenshot({ path: path.join(DOCS, 'needs-a-key.png') });
  say('needs-a-key.png');

  // The refusals, which are the demonstration rather than a failure of it.
  await signInAs('uploader');
  await page.click('[data-sample="invoice.pdf"]');
  await page.waitForTimeout(500);
  await readIt(page, 'job');
  await page.waitForTimeout(2500);

  await page.evaluate(() => {
    document.getElementById('wireFold').open = true;
  });
  await page.waitForTimeout(300);

  await page.locator('#wireFold').screenshot({ path: path.join(DOCS, 'refusals.png') });
  say('refusals.png');
  await page.close();

  // On a phone, where the controls stack and the drop zone keeps its size.
  const phone = await browser.newPage({
    viewport: { width: 390, height: 900 },
    deviceScaleFactor: 2,
    reducedMotion: 'reduce',
  });
  await phone.goto(BASE, { waitUntil: 'networkidle' });
  await phone.waitForTimeout(900);
  await phone.click('[data-sample="letter.pdf"]');
  await phone.waitForTimeout(500);
  await readIt(phone, 'live');
  await phone.waitForTimeout(2500);
  await phone.screenshot({ path: path.join(DOCS, 'phone.png'), fullPage: true });
  say('phone.png');
  await phone.close();

  console.log('\nThe pictures in the README are of the service as it is now.');
} catch (error) {
  console.error(`\nThe pictures could not be retaken: ${error.message.split('\n')[0]}`);
  process.exitCode = 1;
} finally {
  await browser.close();
  await service.stop();
}
