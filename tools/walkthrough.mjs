#!/usr/bin/env node
/**
 * The whole service, driven over HTTP against real documents.
 *
 *     npm run walkthrough
 *     npm run walkthrough -- http://localhost:3400
 *
 * This is the check that is **not** written behind the same door as the code.
 * The unit tests call the functions directly and were written beside them,
 * which makes them good at saying the parts still do what they did and blind to
 * a route mounted in the wrong place, a guard that never runs, a header that
 * never reaches the client, or a scope that turns out to permit everything.
 *
 * It uses the sample documents rather than invented buffers, and it states what
 * ought to happen before each step so a failure reads as a sentence rather than
 * as two numbers that differ.
 *
 * Everything it creates, it takes back: the last section puts the client file
 * back exactly as it found it, because a check that leaves its scaffolding
 * behind eventually accuses the service of its own mess.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { matchesTheReadme } from './what-the-readme-claims.mjs';

const BASE = process.argv[2] || process.env.OCR_URL || 'http://localhost:3400';
const here = path.dirname(fileURLToPath(import.meta.url));
const SAMPLES = path.join(here, '..', 'samples');
const CLIENTS = path.join(here, '..', 'config', 'clients.json');

const SECRETS = {
  'reader-and-writer': 'demo-secret-both-1234',
  uploader: 'demo-secret-write-1234',
  collector: 'demo-secret-read-1234',
  impatient: 'demo-secret-slow-1234',
  retired: 'demo-secret-retired-1234',
};

let checks = 0;
let failures = 0;

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

async function token(clientId, scope) {
  const body = new URLSearchParams({
    grant_type: 'client_credentials',
    client_id: clientId,
    client_secret: SECRETS[clientId],
  });
  if (scope) body.set('scope', scope);

  const response = await fetch(`${BASE}/oauth/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  });

  return { status: response.status, body: await response.json() };
}

function documentForm(name) {
  const form = new FormData();
  const bytes = fs.readFileSync(path.join(SAMPLES, name));
  const type = name.endsWith('.pdf') ? 'application/pdf' : 'image/png';
  form.set('document', new Blob([bytes], { type }), name);
  return form;
}

async function send(where, { method = 'POST', bearer, form, headers = {} } = {}) {
  const response = await fetch(`${BASE}${where}`, {
    method,
    headers: { ...(bearer ? { Authorization: `Bearer ${bearer}` } : {}), ...headers },
    body: form,
  });

  const text = await response.text();
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    body = text;
  }

  return { status: response.status, headers: response.headers, body };
}

async function main() {
  console.log(`Driving ${BASE}\n`);

  // ------------------------------------------------------------------ tokens
  console.log('Getting in');

  const both = await token('reader-and-writer');
  expect('a client with the right secret gets a token', both.status === 200 && both.body.access_token);
  expect(
    'and is told when it expires and what it may do',
    both.body.expires_in > 0 && both.body.scope === 'ocr:read ocr:write',
    JSON.stringify({ expires_in: both.body.expires_in, scope: both.body.scope })
  );

  const wrong = await fetch(`${BASE}/oauth/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'client_credentials',
      client_id: 'reader-and-writer',
      client_secret: 'not the secret',
    }),
  });
  expect('a wrong secret does not', wrong.status === 401, `got ${wrong.status}`);

  const nobody = await fetch(`${BASE}/oauth/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'client_credentials',
      client_id: 'no-such-client',
      client_secret: 'anything',
    }),
  });
  const wrongBody = await wrong.clone?.().json?.().catch(() => null);
  const nobodyBody = await nobody.json();
  expect(
    'and an unknown client is refused in exactly the same words',
    nobody.status === 401 && (!wrongBody || wrongBody.error === nobodyBody.error),
    'distinguishing them hands out a list of valid client ids'
  );

  const switchedOff = await token('retired');
  expect(
    'a client that has been switched off is refused with its secret right',
    switchedOff.status === 401,
    `got ${switchedOff.status}`
  );

  const wrongGrant = await fetch(`${BASE}/oauth/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'password', username: 'a', password: 'b' }),
  });
  expect('and there is no grant here for a person', wrongGrant.status === 400, `got ${wrongGrant.status}`);

  // ---------------------------------------------------------------- 1. waiting
  console.log('\nReading a document, and waiting for it');

  const read = await send('/api/read', { bearer: both.body.access_token, form: documentForm('invoice.pdf') });

  expect('an invoice is read', read.status === 200 && read.body.ok, JSON.stringify(read.body).slice(0, 200));
  expect(
    'by the engine that needs nothing',
    read.body.engine === 'text-layer',
    `it used ${read.body.engine}`
  );
  expect(
    'and the words on the page come back',
    /Invoice 2026-0184/.test(read.body.text) && /Total due EUR 128\.10/.test(read.body.text)
  );
  expect(
    'with the table readable rather than run together',
    /Nitrile gloves, medium 12 6\.20 74\.40/.test(read.body.text),
    read.body.text.split('\n').find((line) => /Nitrile/.test(line))
  );
  expect('and every answer carries a request id', Boolean(read.headers.get('x-request-id')));

  const pages = await send('/api/read', {
    bearer: both.body.access_token,
    form: documentForm('two-pages.pdf'),
  });
  expect(
    'a document of two pages gives both of them',
    /Terms of supply/.test(pages.body.text) && /Schedule of charges/.test(pages.body.text),
    'a reader that stops at the first page looks correct on a one-page file'
  );

  // ------------------------------------------------------- what it will not do
  console.log('\nWhat it will not pretend to');

  const scan = await send('/api/read', { bearer: both.body.access_token, form: documentForm('scan.png') });
  expect(
    'a page with no text in it is refused, not answered with nothing',
    scan.status === 422 && !scan.body.ok,
    `got ${scan.status}`
  );
  expect(
    'and it says which engine was missing',
    JSON.stringify(scan.body.tried).includes('MISTRAL_API_KEY'),
    JSON.stringify(scan.body.tried)
  );

  const wrongKind = new FormData();
  wrongKind.set('document', new Blob([Buffer.from('nothing')], { type: 'text/csv' }), 'a.csv');
  const csv = await send('/api/read', { bearer: both.body.access_token, form: wrongKind });
  expect('a kind of file it does not read is refused before it is read', csv.status === 415, `got ${csv.status}`);

  const empty = new FormData();
  empty.set('document', new Blob([], { type: 'application/pdf' }), 'empty.pdf');
  const nothing = await send('/api/read', { bearer: both.body.access_token, form: empty });
  expect('and so is an empty one', nothing.status === 400, `got ${nothing.status}`);

  // ---------------------------------------------------------------- 2. streaming
  console.log('\nWatching it work');

  const live = await fetch(`${BASE}/api/read/live`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${both.body.access_token}` },
    body: documentForm('letter.pdf'),
  });

  expect('the streaming call answers as a stream', live.headers.get('content-type')?.includes('ndjson'));
  expect(
    'and asks the proxy in front not to buffer it',
    live.headers.get('x-accel-buffering') === 'no',
    'without this an nginx delivers the whole thing at the end, which is not streaming'
  );

  const lines = (await live.text()).trim().split('\n').map((line) => JSON.parse(line));
  expect('it starts by saying it has started', lines[0]?.type === 'started');
  expect('reports progress along the way', lines.some((line) => line.type === 'progress'));
  expect(
    'and finishes with the text',
    lines.at(-1)?.type === 'result' && /JD0002234567/.test(lines.at(-1).text),
    JSON.stringify(lines.at(-1)).slice(0, 160)
  );

  // --------------------------------------------------------------- 3. a job
  console.log('\nComing back for it later');

  const opened = await send('/api/jobs', {
    bearer: both.body.access_token,
    form: documentForm('invoice.pdf'),
  });
  expect('a job is accepted straight away', opened.status === 202 && opened.body.job_id, `got ${opened.status}`);

  let job = null;
  for (let tries = 0; tries < 50; tries += 1) {
    const asked = await send(`/api/jobs/${opened.body.job_id}`, {
      method: 'GET',
      bearer: both.body.access_token,
    });
    job = asked.body;
    if (job.state === 'done' || job.state === 'failed') break;
    await new Promise((done) => setTimeout(done, 100));
  }

  expect('and finishes', job?.state === 'done', `it ended as ${job?.state}`);
  expect('with the same text the waiting call gave', job?.result?.text === read.body.text);
  expect('and says how long it will be kept', Boolean(job?.kept_until), JSON.stringify(job).slice(0, 160));

  const missing = await send(`/api/jobs/00000000-0000-0000-0000-000000000000`, {
    method: 'GET',
    bearer: both.body.access_token,
  });
  expect('a job that does not exist is a 404', missing.status === 404, `got ${missing.status}`);

  // -------------------------------------------------------------- the scopes
  console.log('\nA scope is not a formality');

  const uploader = await token('uploader');
  const collector = await token('collector');

  const uploaderOpens = await send('/api/jobs', {
    bearer: uploader.body.access_token,
    form: documentForm('letter.pdf'),
  });
  expect('a client with only ocr:write may submit', uploaderOpens.status === 202, `got ${uploaderOpens.status}`);

  const uploaderReads = await send(`/api/jobs/${uploaderOpens.body.job_id}`, {
    method: 'GET',
    bearer: uploader.body.access_token,
  });
  expect(
    'and may NOT read back what it submitted',
    uploaderReads.status === 403,
    `got ${uploaderReads.status} — the whole reason the scopes are separate`
  );

  const collectorSubmits = await send('/api/read', {
    bearer: collector.body.access_token,
    form: documentForm('letter.pdf'),
  });
  expect('a client with only ocr:read may not submit', collectorSubmits.status === 403, `got ${collectorSubmits.status}`);

  const collectorReadsOther = await send(`/api/jobs/${opened.body.job_id}`, {
    method: 'GET',
    bearer: collector.body.access_token,
  });
  expect(
    'and cannot collect somebody else’s job even with the right scope',
    collectorReadsOther.status === 404,
    `got ${collectorReadsOther.status} — a scope says what, not whose`
  );

  const asked = await token('reader-and-writer', 'ocr:read');
  expect(
    'asking for less than you hold gives you less',
    asked.body.scope === 'ocr:read',
    `got "${asked.body.scope}"`
  );

  const overreach = await token('uploader', 'ocr:read ocr:write');
  expect(
    'and asking for more gives you only what you hold',
    overreach.body.scope === 'ocr:write',
    `got "${overreach.body.scope}"`
  );

  const noToken = await send('/api/read', { form: documentForm('letter.pdf') });
  expect('no token at all is a 401', noToken.status === 401, `got ${noToken.status}`);

  const madeUp = await send('/api/read', { bearer: 'not.a.token', form: documentForm('letter.pdf') });
  expect('and so is a token somebody invented', madeUp.status === 401, `got ${madeUp.status}`);

  // ---------------------------------------------------------- the rate limit
  console.log('\nThe rate limit, per client and not per address');

  const impatient = await token('impatient');
  const answers = [];
  for (let call = 0; call < 5; call += 1) {
    answers.push(await send('/api/read', { bearer: impatient.body.access_token, form: documentForm('letter.pdf') }));
  }

  expect(
    'three calls a minute means the fourth is refused',
    answers.filter((one) => one.status === 429).length >= 2,
    answers.map((one) => one.status).join(' ')
  );

  const refused = answers.find((one) => one.status === 429);
  expect(
    'and it says how long to wait, in seconds it worked out',
    Number(refused?.headers.get('retry-after')) > 0,
    `Retry-After: ${refused?.headers.get('retry-after')}`
  );
  expect(
    'while a different client is unaffected',
    (await send('/api/read', { bearer: both.body.access_token, form: documentForm('letter.pdf') })).status === 200,
    'a limit counted per address would have caught this one too'
  );

  // ------------------------------------------------------ the file is re-read
  console.log('\nThe client file is re-read while it runs');

  const before = fs.readFileSync(CLIENTS, 'utf8');

  try {
    const edited = JSON.parse(before);
    edited.clients.find((one) => one.client_id === 'uploader').enabled = false;
    fs.writeFileSync(CLIENTS, JSON.stringify(edited, null, 2));

    /**
     * Long enough for the interval the service actually has.
     *
     * This waited 21 seconds, and the default interval is 30 — so it passed in
     * continuous integration, which starts the service with
     * `CLIENTS_RELOAD_MS=1000`, and failed for anybody who ran the command the
     * README tells them to run. The service was right every time; the check was
     * measuring against a number only the CI file knew.
     *
     * It waits out the default now, and says what it is waiting for, because
     * thirty-five silent seconds look like a hang.
     */
    await new Promise((done) => setTimeout(done, 1500));

    let stillWorks = true;
    let said = false;

    for (let tries = 0; tries < 68 && stillWorks; tries += 1) {
      if (tries === 8 && !said) {
        said = true;
        console.log('        (waiting for the client file to be re-read — up to 35s at the default');
        console.log('         interval; CLIENTS_RELOAD_MS=1000 makes it immediate, as CI does)');
      }

      const now = await token('uploader');
      stillWorks = now.status === 200;
      if (stillWorks) await new Promise((done) => setTimeout(done, 500));
    }

    expect(
      'switching a client off in the file stops it, with no restart',
      !stillWorks,
      'the point of a file that is re-read is that you can stop a caller that is hammering you now'
    );
  } finally {
    // Put back exactly as found, whatever happened above.
    fs.writeFileSync(CLIENTS, before);
    await new Promise((done) => setTimeout(done, 1500));
  }

  // Same margin as above, and for the same reason: this side of the toggle has
  // to outlast the default interval too, or the check that put a client back
  // fails on the machine of anybody who did not set CLIENTS_RELOAD_MS.
  let restored = false;
  for (let tries = 0; tries < 68 && !restored; tries += 1) {
    restored = (await token('uploader')).status === 200;
    if (!restored) await new Promise((done) => setTimeout(done, 500));
  }
  expect('and switching it back on lets it in again', restored);

  // ------------------------------------------------------------------ the end
  //
  // The README's own claim about this command, checked by this command. A
  // number in a README is a claim about a program sitting right there and able
  // to be asked; until this line existed nobody ever asked it, and a sibling
  // project drifted from 86 to 92 without one red run.
  console.log('');
  if (!matchesTheReadme('npm run walkthrough', checks)) failures += 1;

  console.log('');
  if (failures > 0) {
    console.log(`${failures} of ${checks} checks failed.`);
    process.exitCode = 1;
    return;
  }
  console.log(`All ${checks} checks passed.`);
}

main().catch((error) => {
  console.error(`\n${error.stack}`);
  console.error(`\nIs the service running? ${BASE} did not behave.`);
  process.exit(1);
});
