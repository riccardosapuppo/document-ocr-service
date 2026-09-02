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

const BASE = process.env.OCR_URL || 'http://localhost:3400';
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

  // The page before anything has happened: the controls, and a console with
  // nothing in it yet.
  await page.screenshot({ path: path.join(DOCS, 'panel.png'), fullPage: true });
  say('panel.png');

  // The whole journey, ending with the stream having run. This is the picture
  // that says what the project is.
  await page.click('[data-client="reader-and-writer"]');
  await page.click('#getToken');
  await page.waitForTimeout(600);
  await page.click('[data-sample="invoice.pdf"]');
  await page.waitForTimeout(600);
  await page.click('button[value="live"]');
  await page.waitForFunction(() => document.getElementById('text')?.textContent?.length > 100, {
    timeout: 20000,
  });
  await page.waitForTimeout(500);

  await page.screenshot({ path: path.join(DOCS, 'read.png'), fullPage: true });
  say('read.png');

  // The refusals, which are the demonstration rather than a failure of it.
  await page.click('[data-client="uploader"]');
  await page.click('#getToken');
  await page.waitForTimeout(500);
  await page.click('button[value="job"]');
  await page.waitForTimeout(2500);

  await page.click('[data-client="reader-and-writer"]');
  await page.click('#getToken');
  await page.waitForTimeout(400);
  await page.click('[data-sample="scan.png"]');
  await page.waitForTimeout(500);
  await page.click('button[value="wait"]');
  await page.waitForTimeout(1800);

  await page.locator('.card.console').screenshot({ path: path.join(DOCS, 'refusals.png') });
  say('refusals.png');
  await page.close();

  // On a phone, where the two answers stack and the console keeps its height.
  const phone = await browser.newPage({
    viewport: { width: 390, height: 900 },
    deviceScaleFactor: 2,
    reducedMotion: 'reduce',
  });
  await phone.goto(BASE, { waitUntil: 'networkidle' });
  await phone.waitForTimeout(700);
  await phone.click('#getToken');
  await phone.waitForTimeout(500);
  await phone.click('[data-sample="letter.pdf"]');
  await phone.waitForTimeout(500);
  await phone.click('button[value="live"]');
  await phone.waitForTimeout(2000);
  await phone.screenshot({ path: path.join(DOCS, 'phone.png'), fullPage: true });
  say('phone.png');
  await phone.close();

  console.log('\nThe pictures in the README are of the service as it is now.');
} catch (error) {
  console.error(`\nThe pictures could not be retaken: ${error.message.split('\n')[0]}`);
  process.exitCode = 1;
} finally {
  await browser.close();
}
