import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { jobStore } from '../src/jobs/store.js';
import { engineRegistry } from '../src/ocr/engines.js';
import { mistralEngine } from '../src/ocr/mistral.js';

describe('jobs somebody comes back for', () => {
  const opening = { clientId: 'one', filename: 'a.pdf', size: 10, mimetype: 'application/pdf' };

  it('gives back what the client that opened it put in', () => {
    const jobs = jobStore();
    const id = jobs.open(opening);

    jobs.done(id, { text: 'the words' });

    assert.equal(jobs.read(id, 'one').result.text, 'the words');
  });

  it('says nothing at all to a different client', () => {
    // And says the SAME nothing as for a job that never existed. A scope says
    // what a caller may do, never whose; without this a client holding
    // `ocr:read` and a list of ids could read everybody's results.
    const jobs = jobStore();
    const id = jobs.open(opening);
    jobs.done(id, { text: 'the words' });

    assert.equal(jobs.read(id, 'someone-else'), null);
    assert.equal(jobs.read('00000000-0000-0000-0000-000000000000', 'one'), null);
  });

  it('gives ids nobody can walk', () => {
    // A sequential id turns "may read a job" into "may read every job".
    const jobs = jobStore();
    const ids = Array.from({ length: 20 }, () => jobs.open(opening));

    assert.equal(new Set(ids).size, 20);
    for (const id of ids) assert.match(id, /^[0-9a-f-]{36}$/);
  });

  it('throws a finished job away once its time is up', () => {
    let now = 0;
    const jobs = jobStore({ retentionMs: 60_000, at: () => now });
    const id = jobs.open(opening);

    jobs.done(id, { text: 'the words' });
    now += 30_000;
    assert.ok(jobs.read(id, 'one'), 'thrown away while somebody might still collect it');

    now += 31_000;
    assert.equal(jobs.read(id, 'one'), null);
  });

  it('does not throw away a job that is still running, however long it takes', () => {
    // Forty scanned pages take longer than the retention window, and a job that
    // vanishes while it is working is the worst of both shapes.
    let now = 0;
    const jobs = jobStore({ retentionMs: 1_000, at: () => now });
    const id = jobs.open(opening);

    jobs.progress(id, 0.5, 'halfway');
    now += 600_000;

    assert.equal(jobs.read(id, 'one').state, 'running');
  });

  it('says when a finished job will stop being available', () => {
    let now = 0;
    const jobs = jobStore({ retentionMs: 60_000, at: () => now });
    const id = jobs.open(opening);
    jobs.done(id, { text: 'x' });

    assert.equal(jobs.read(id, 'one').kept_until, new Date(60_000).toISOString());
  });

  it('refuses to take on more than it can hold, rather than filling memory', () => {
    const jobs = jobStore({ max: 3 });
    for (let open = 0; open < 3; open += 1) jobs.open(opening);

    assert.throws(() => jobs.open(opening), /too many jobs/);
  });

  it('carries a failure back rather than losing it', () => {
    const jobs = jobStore();
    const id = jobs.open(opening);

    jobs.failed(id, { error: 'nothing could read it' });

    const said = jobs.read(id, 'one');
    assert.equal(said.state, 'failed');
    assert.equal(said.problem.error, 'nothing could read it');
  });
});

describe('choosing an engine', () => {
  const pdfWith = (name) => ({ mimetype: 'application/pdf', buffer: Buffer.from(name) });

  it('reads a PDF with a text layer without needing anything', async () => {
    const engines = engineRegistry();
    const fs = await import('node:fs');
    const path = await import('node:path');
    const { fileURLToPath } = await import('node:url');

    const here = path.dirname(fileURLToPath(import.meta.url));
    const buffer = fs.readFileSync(path.join(here, '..', 'samples', 'invoice.pdf'));

    const got = await engines.read({ mimetype: 'application/pdf', buffer, originalname: 'invoice.pdf' });

    assert.equal(got.engine, 'text-layer');
    assert.match(got.text, /Invoice 2026-0184/);
  });

  it('says which engines were tried and what each one said', async () => {
    // An engine declining is a result, not a silence. A caller that gets no
    // text has to be able to tell "this page has no text in it" from "the
    // engine that could have read it is not configured" — only one of those is
    // fixed by uploading a better file.
    const engines = engineRegistry();

    await assert.rejects(
      engines.read({ mimetype: 'image/png', buffer: Buffer.from('not a png'), originalname: 'a.png' }),
      (error) => {
        assert.equal(error.status, 422);
        assert.match(JSON.stringify(error.tried), /MISTRAL_API_KEY/);
        assert.match(JSON.stringify(error.tried), /not for this kind of file/);
        return true;
      }
    );
  });

  it('refuses an engine name nobody has', async () => {
    const engines = engineRegistry();

    await assert.rejects(
      engines.read(pdfWith('%PDF-1.4'), { only: 'tesseract' }),
      /no engine called "tesseract"/
    );
  });
});

describe('the engine that has to go out to the network', () => {
  const png = { mimetype: 'image/png', buffer: Buffer.from('pixels'), originalname: 'a.png' };

  it('says what is missing rather than failing obscurely', async () => {
    const engine = mistralEngine({ apiKey: '' });

    await assert.rejects(engine.read(png, {}), (error) => {
      assert.equal(error.code, 'ENGINE_NOT_CONFIGURED');
      assert.match(error.message, /MISTRAL_API_KEY/);
      return true;
    });
  });

  it('tries again after a failure that might not repeat', async () => {
    let calls = 0;
    const engine = mistralEngine({
      apiKey: 'a-key',
      wait: async () => {},
      send: async () => {
        calls += 1;
        if (calls < 3) return { ok: false, status: 503 };
        return { ok: true, json: async () => ({ pages: [{ markdown: 'read from the pixels' }] }) };
      },
    });

    const got = await engine.read(png, {});

    assert.equal(calls, 3);
    assert.equal(got.text, 'read from the pixels');
  });

  it('does not try again after a failure that certainly will', async () => {
    // Retrying a rejected key is how a wrong credential becomes a lockout, and
    // retrying a malformed request is three identical malformed requests.
    let calls = 0;
    const engine = mistralEngine({
      apiKey: 'the-wrong-key',
      wait: async () => {},
      send: async () => {
        calls += 1;
        return { ok: false, status: 401 };
      },
    });

    await assert.rejects(engine.read(png, {}));
    assert.equal(calls, 1);
  });

  it('waits longer each time, and not the same amount as everybody else', async () => {
    // Doubling alone brings every caller back in the same second, and the
    // service that was wobbling is knocked over by the people waiting politely.
    const waits = [];
    let calls = 0;

    const engine = mistralEngine({
      apiKey: 'a-key',
      maxRetries: 3,
      baseDelayMs: 1000,
      maxDelayMs: 30_000,
      wait: async (ms) => waits.push(ms),
      send: async () => {
        calls += 1;
        if (calls <= 3) return { ok: false, status: 500 };
        return { ok: true, json: async () => ({ pages: [{ markdown: 'eventually' }] }) };
      },
    });

    await engine.read(png, {});

    assert.equal(waits.length, 3);
    assert.ok(waits[1] > waits[0], `waits were ${waits.join(', ')}`);
    assert.ok(waits[2] > waits[1], `waits were ${waits.join(', ')}`);
    // Spread, not exact: half the doubled delay plus a random half.
    assert.ok(waits.every((ms) => ms >= 500 && ms <= 30_000));
  });

  it('gives up rather than trying forever', async () => {
    let calls = 0;
    const engine = mistralEngine({
      apiKey: 'a-key',
      maxRetries: 2,
      wait: async () => {},
      send: async () => {
        calls += 1;
        return { ok: false, status: 500 };
      },
    });

    await assert.rejects(engine.read(png, {}));
    assert.equal(calls, 3, 'one attempt and two retries');
  });
});
