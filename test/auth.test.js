import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it, beforeEach, afterEach } from 'node:test';

import { clientList, hashOf } from '../src/auth/clients.js';
import { tokenIssuer, carries } from '../src/auth/tokens.js';
import { rateLimiter } from '../src/auth/rate.js';

/**
 * Time is injected everywhere below.
 *
 * A test that proves a fifteen-minute expiry by waiting fifteen minutes does not
 * get run; a test that proves it by waiting one second gets marked flaky and
 * then deleted. Moving the clock is the only version of these that survives.
 */

const SECRET = 'a-signing-secret-long-enough-to-be-refused-otherwise';

function writeClients(file, clients) {
  fs.writeFileSync(file, JSON.stringify({ clients }, null, 2));
}

describe('who may call', () => {
  let file;

  beforeEach(() => {
    file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'ocr-')), 'clients.json');
    writeClients(file, [
      {
        client_id: 'one',
        client_secrets: [hashOf('the-first-secret')],
        scope: 'ocr:read ocr:write',
        enabled: true,
        rate_limit_per_minute: 10,
      },
    ]);
  });

  afterEach(() => fs.rmSync(path.dirname(file), { recursive: true, force: true }));

  it('lets in a client whose secret matches', () => {
    const list = clientList({ file });
    assert.equal(list.check('one', 'the-first-secret').ok, true);
  });

  it('keeps out a client whose secret does not', () => {
    const list = clientList({ file });
    assert.equal(list.check('one', 'nearly-the-first-secret').ok, false);
  });

  it('accepts either secret while one is being rotated', () => {
    // The reason secrets are a list. Rotation is: add the new hash, let the
    // caller change over, remove the old one — three deploys with no window in
    // which the caller is locked out. With one secret it is a cut, and cuts get
    // postponed until the secret is years old.
    writeClients(file, [
      {
        client_id: 'one',
        client_secrets: [hashOf('the-old-secret'), hashOf('the-new-secret')],
        scope: 'ocr:read',
        enabled: true,
      },
    ]);

    const list = clientList({ file, reloadEveryMs: 0 });

    assert.equal(list.check('one', 'the-old-secret').ok, true);
    assert.equal(list.check('one', 'the-new-secret').ok, true);
  });

  it('refuses a client that has been switched off, secret and all', () => {
    writeClients(file, [
      { client_id: 'one', client_secrets: [hashOf('the-first-secret')], scope: 'ocr:read', enabled: false },
    ]);

    const list = clientList({ file, reloadEveryMs: 0 });
    const said = list.check('one', 'the-first-secret');

    assert.equal(said.ok, false);
    assert.match(said.why, /switched off/);
  });

  it('re-reads the file after the interval, and not before it', () => {
    let now = 1_000_000;
    const list = clientList({ file, reloadEveryMs: 30_000, at: () => now });

    assert.equal(list.check('two', 'a-second-secret').ok, false);

    writeClients(file, [
      { client_id: 'two', client_secrets: [hashOf('a-second-secret')], scope: 'ocr:read', enabled: true },
    ]);

    // Still the old list: the interval has not passed.
    assert.equal(list.check('two', 'a-second-secret').ok, false);

    now += 30_001;
    assert.equal(list.check('two', 'a-second-secret').ok, true);
  });

  it('keeps the previous list when the file cannot be read', () => {
    // A file being edited is momentarily half-written. Dropping every client
    // because somebody saved in the middle of a keystroke is a self-inflicted
    // outage, and it happens at exactly the moment somebody is trying to fix
    // something.
    let now = 1_000_000;
    const list = clientList({ file, reloadEveryMs: 1, at: () => now });
    assert.equal(list.check('one', 'the-first-secret').ok, true);

    fs.writeFileSync(file, '{ "clients": [ this is not json');
    now += 1000;

    assert.equal(list.check('one', 'the-first-secret').ok, true);
    assert.match(list.describe().problem ?? '', /JSON|Unexpected/);
  });

  it('never repeats a secret, or its hash, in what it will say about itself', () => {
    const said = JSON.stringify(clientList({ file }).describe());

    assert.doesNotMatch(said, /the-first-secret/);
    assert.doesNotMatch(said, new RegExp(hashOf('the-first-secret')));
    assert.match(said, /secrets_held/);
  });
});

describe('the tokens', () => {
  const client = { id: 'one', scope: ['ocr:read', 'ocr:write'], tokenTtlSeconds: 900 };

  it('refuses to start with a secret short enough to guess', () => {
    assert.throws(() => tokenIssuer({ secret: 'short', issuer: 'a', audience: 'b' }), /at least 32/);
  });

  it('issues a token that reads back as the client it was for', () => {
    const tokens = tokenIssuer({ secret: SECRET, issuer: 'a', audience: 'b' });
    const read = tokens.read(tokens.issue(client).access_token);

    assert.equal(read.ok, true);
    assert.equal(read.clientId, 'one');
  });

  it('grants only what the client holds, however much it asks for', () => {
    const tokens = tokenIssuer({ secret: SECRET, issuer: 'a', audience: 'b' });
    const only = { ...client, scope: ['ocr:write'] };

    assert.equal(tokens.issue(only, 'ocr:read ocr:write').scope, 'ocr:write');
  });

  it('grants less when less is asked for', () => {
    // So a caller can hold a broad credential and use a narrow token for the
    // part of its work that does not need the rest.
    const tokens = tokenIssuer({ secret: SECRET, issuer: 'a', audience: 'b' });

    assert.equal(tokens.issue(client, 'ocr:read').scope, 'ocr:read');
  });

  it('stops honouring a token once it has expired', () => {
    // The clock is moved for the ISSUER and not for the reader, because that is
    // the asymmetry that exists in production: a token was minted an hour ago
    // and is being presented now.
    //
    // The first version of this made both tokens on an injected clock set to
    // 2023 and then asserted the fresh one was still good. It was not — it was
    // two years old — and the test failed for a reason that had nothing to do
    // with expiry. A check that fails for the wrong reason teaches you to
    // ignore it.
    const tokens = tokenIssuer({ secret: SECRET, issuer: 'a', audience: 'b' });

    const fresh = tokens.issue({ ...client, tokenTtlSeconds: 60 }).access_token;
    assert.equal(tokens.read(fresh).ok, true);

    const anHourAgo = tokenIssuer({
      secret: SECRET,
      issuer: 'a',
      audience: 'b',
      at: () => Date.now() - 3600_000,
    });
    const stale = anHourAgo.issue({ ...client, tokenTtlSeconds: 60 }).access_token;

    const said = tokens.read(stale);
    assert.equal(said.ok, false);
    assert.match(said.why, /expired/);
  });

  it('refuses a token signed with a different secret', () => {
    const mine = tokenIssuer({ secret: SECRET, issuer: 'a', audience: 'b' });
    const theirs = tokenIssuer({ secret: `${SECRET}-but-different`, issuer: 'a', audience: 'b' });

    assert.equal(mine.read(theirs.issue(client).access_token).ok, false);
  });

  it('refuses a token that says it needs no signature', () => {
    // The oldest hole in JWT, and still open by default in several libraries: a
    // verifier that honours the token's own `alg` header will accept `none`,
    // which lets anybody who can write JSON mint an administrator.
    const header = Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url');
    const body = Buffer.from(
      JSON.stringify({ sub: 'one', scope: 'ocr:read ocr:write', iss: 'a', aud: 'b', exp: 9_999_999_999 })
    ).toString('base64url');

    const tokens = tokenIssuer({ secret: SECRET, issuer: 'a', audience: 'b' });
    assert.equal(tokens.read(`${header}.${body}.`).ok, false);
  });

  it('refuses a token minted for another audience', () => {
    const elsewhere = tokenIssuer({ secret: SECRET, issuer: 'a', audience: 'somewhere-else' });
    const here = tokenIssuer({ secret: SECRET, issuer: 'a', audience: 'b' });

    assert.equal(here.read(elsewhere.issue(client).access_token).ok, false);
  });

  it('knows when a scope is missing', () => {
    assert.equal(carries(['ocr:read'], ['ocr:read']), true);
    assert.equal(carries(['ocr:read'], ['ocr:write']), false);
    assert.equal(carries(['ocr:read', 'ocr:write'], ['ocr:read', 'ocr:write']), true);
  });
});

describe('how often one client may call', () => {
  it('allows the quota and refuses what follows it', () => {
    let now = 0;
    const limiter = rateLimiter({ windowMs: 60_000, at: () => now });

    for (let call = 0; call < 3; call += 1) assert.equal(limiter.take('one', 3).ok, true);
    assert.equal(limiter.take('one', 3).ok, false);
  });

  it('counts each client on its own', () => {
    // The reason this is keyed on the client and not on the address: several of
    // these callers are servers behind the same egress address, and the one
    // whose retry loop has gone wrong must not take the others down with it.
    let now = 0;
    const limiter = rateLimiter({ windowMs: 60_000, at: () => now });

    for (let call = 0; call < 3; call += 1) limiter.take('noisy', 3);

    assert.equal(limiter.take('noisy', 3).ok, false);
    assert.equal(limiter.take('quiet', 3).ok, true);
  });

  it('lets a client back in as its calls fall out of the window', () => {
    let now = 0;
    const limiter = rateLimiter({ windowMs: 60_000, at: () => now });

    for (let call = 0; call < 3; call += 1) limiter.take('one', 3);
    assert.equal(limiter.take('one', 3).ok, false);

    now += 60_001;
    assert.equal(limiter.take('one', 3).ok, true);
  });

  it('does not let a burst through on the boundary of a window', () => {
    // What a fixed window gets wrong: the whole quota in the last second of one
    // window and the whole of the next in the first second of the following is
    // twice the limit back to back, arriving exactly when it hurts.
    let now = 0;
    const limiter = rateLimiter({ windowMs: 60_000, at: () => now });

    now = 59_000;
    for (let call = 0; call < 3; call += 1) assert.equal(limiter.take('one', 3).ok, true);

    now = 61_000;
    assert.equal(
      limiter.take('one', 3).ok,
      false,
      'a fixed window would have let three more through two seconds later'
    );
  });

  it('says how long to wait, and means it', () => {
    let now = 0;
    const limiter = rateLimiter({ windowMs: 60_000, at: () => now });

    for (let call = 0; call < 3; call += 1) limiter.take('one', 3);
    now += 20_000;

    const refused = limiter.take('one', 3);
    assert.equal(refused.ok, false);
    assert.equal(refused.retryAfterSeconds, 40);
  });

  it('forgets a client that has stopped calling', () => {
    // Otherwise the map grows once per client id ever seen, and a caller that
    // generates a fresh id per deployment is a leak that takes a fortnight to
    // become visible.
    let now = 0;
    const limiter = rateLimiter({ windowMs: 60_000, at: () => now });

    limiter.take('gone', 10);
    assert.equal(limiter.watching(), 1);

    now += 120_000;
    assert.equal(limiter.forgetIdle(), 0);
  });
});
