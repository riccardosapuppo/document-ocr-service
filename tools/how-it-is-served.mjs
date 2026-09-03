#!/usr/bin/env node
/**
 * How the control panel is served, checked against the running service.
 *
 *     npm run check:serving
 *
 * This exists because a caching header is the kind of thing that is right in
 * the source and wrong in the response, and because it was wrong here for
 * weeks. `express.static(dir, { etag: false })` reads as "no revalidation" and
 * is not: `lastModified` is a separate option that defaults to true, so every
 * file went out with a `Last-Modified`, every reload was a conditional request,
 * and a browser is entitled to answer one from its own cache with a 304.
 *
 * That is how somebody presses reload after a rebuild and is served the page
 * from before it. The advice it produces is "press Ctrl+F5", which sends people
 * looking at the server while the page is coming from their own browser.
 *
 * It asserts, against a service that is really running:
 *
 *   - the page is `no-store`, with no `ETag` and no `Last-Modified`
 *   - so is everything it loads, since nothing here is fingerprinted
 *   - a request that NAMES A FILE and has not got one is a 404, never the
 *     application dressed up as a file
 */

import { spawn } from 'node:child_process';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const PORT = 3466;
const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

let child = null;
let checks = 0;
let bad = 0;

try {
  child = await start();
  console.log(`  asking http://127.0.0.1:${PORT} how it serves things\n`);

  const page = await fetch(`http://127.0.0.1:${PORT}/`);

  is('the page comes back', page.status, 200);
  has('and it is never stored', page.headers.get('cache-control') ?? '', 'no-store');
  is('it has no ETag to revalidate against', page.headers.get('etag'), null);
  is('and no Last-Modified either', page.headers.get('last-modified'), null);

  for (const file of await whatThePageLoads(`http://127.0.0.1:${PORT}/`)) {
    const asset = await fetch(`http://127.0.0.1:${PORT}${file}`);

    is(`${file} comes back`, asset.status, 200);
    has(`${file} is never stored either`, asset.headers.get('cache-control') ?? '', 'no-store');
    is(`${file} has no Last-Modified`, asset.headers.get('last-modified'), null);
  }

  // The failure this guards against: a request for `/ngsw.json` answered with
  // 200 and a page of HTML, which a service worker then treats as its manifest.
  for (const missing of ['/ngsw.json', '/panel.old.js', '/samples/nothing.pdf']) {
    const said = await fetch(`http://127.0.0.1:${PORT}${missing}`);
    const body = await said.text();

    is(`${missing} is a 404`, said.status, 404);
    is(`and ${missing} is not a page of HTML`, /<html|<!doctype/i.test(body), false);
  }
} catch (error) {
  bad += 1;
  checks += 1;
  console.log(`\n  NO    the check could not be carried out\n          ${error.message}`);
} finally {
  if (child) await gone(child);
}

console.log(`\n${bad === 0 ? `All ${checks} checks passed.` : `${bad} of ${checks} checks failed.`}`);
process.exitCode = bad === 0 ? 0 : 1;

// ---------------------------------------------------------------------------

/**
 * The files the page actually asks for, read out of the page.
 *
 * Not a list written here: a list written here goes stale the moment somebody
 * renames a stylesheet, and then this check passes while checking nothing.
 */
async function whatThePageLoads(url) {
  const html = await (await fetch(url)).text();
  const found = [...html.matchAll(/(?:src|href)="(\/?[^"#:]+\.(?:js|css|svg|png|webmanifest))"/g)].map((one) => one[1]);

  const paths = [...new Set(found.map((one) => `/${one.replace(/^\.?\//, '')}`))];
  if (paths.length === 0) throw new Error('the page loads nothing at all — has the pattern stopped matching?');

  return paths;
}

function is(what, got, wanted) {
  checks += 1;

  if (got === wanted) {
    console.log(`  ok    ${what}`);
    return;
  }

  bad += 1;
  console.log(`  NO    ${what}\n          wanted ${JSON.stringify(wanted)}, got ${JSON.stringify(got)}`);
}

function has(what, got, wanted) {
  checks += 1;

  if (String(got ?? '').includes(wanted)) {
    console.log(`  ok    ${what}`);
    return;
  }

  bad += 1;
  console.log(`  NO    ${what}\n          wanted something containing ${JSON.stringify(wanted)}, got ${JSON.stringify(got)}`);
}

async function start() {
  const one = spawn(process.execPath, ['src/index.js', '--port', String(PORT)], {
    cwd: root,
    env: { ...process.env, PORT: String(PORT) },
    stdio: ['ignore', 'ignore', 'pipe'],
  });

  one.stderr.on('data', (chunk) => process.stderr.write(chunk));

  // Forty seconds, not six. The collector binds a little over six seconds
  // after it is spawned, and a limit set at exactly six turns "slow to start"
  // into "never came up" — a false failure that blames the service.
  for (let attempt = 0; attempt < 400; attempt += 1) {
    const up = await new Promise((done) => {
      const socket = net.createConnection({ host: '127.0.0.1', port: PORT });
      socket.once('connect', () => {
        socket.destroy();
        done(true);
      });
      socket.once('error', () => done(false));
    });

    if (up) return one;
    if (one.exitCode !== null) throw new Error(`the service exited with ${one.exitCode} before answering`);
    await new Promise((done) => setTimeout(done, 100));
  }

  throw new Error(`the service never came up on ${PORT}`);
}

function gone(one) {
  if (one.exitCode !== null) return null;

  return new Promise((done) => {
    const impatient = setTimeout(() => {
      one.kill('SIGKILL');
      done();
    }, 3000);

    one.once('exit', () => {
      clearTimeout(impatient);
      done();
    });

    one.kill();
  });
}
