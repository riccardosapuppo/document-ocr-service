/**
 * Who may call this service, from a file that is re-read while it runs.
 *
 * A file rather than a database because of what this is: an internal service
 * that a handful of other applications call. The list of them changes when
 * somebody deploys something, not when a user signs up, and a table with three
 * rows in it needs a migration, a connection and a backup to say what a file
 * says outright.
 *
 * Re-read on an interval so a client can be added, have its quota changed, or
 * be switched off **without restarting the service** — which matters when the
 * reason you are switching it off is that it is hammering you right now.
 *
 * Secrets are stored as SHA-256 hashes, and a client may hold more than one.
 * That is not decoration: rotating a secret means adding the new hash, letting
 * the caller change over, and removing the old one — three separate deploys
 * with no window in which the caller is locked out. With a single secret the
 * rotation is a cut, and cuts get postponed until the secret is years old.
 */

import crypto from 'node:crypto';
import fs from 'node:fs';

/**
 * Reads and remembers the client list.
 *
 * `at` is injectable so the tests can move time without sleeping. A test that
 * proves a reload interval by waiting for it is a test somebody deletes.
 */
export function clientList({ file, reloadEveryMs = 60_000, at = () => Date.now(), warn = () => {} }) {
  let clients = new Map();
  let readAt = 0;
  let readFrom = null;
  let lastProblem = null;

  function reload({ force = false } = {}) {
    const now = at();
    if (!force && now - readAt < reloadEveryMs) return { changed: false, reason: 'not due yet' };

    let parsed;
    try {
      parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch (error) {
      // The previous list stays in force. A file that is being edited is
      // momentarily half-written, and dropping every client because somebody
      // saved in the middle of a keystroke would be a self-inflicted outage.
      lastProblem = error.message;
      warn('the client file could not be read; the previous list stays in force', error.message);
      readAt = now;
      return { changed: false, reason: 'unreadable' };
    }

    const next = new Map();
    for (const entry of parsed.clients ?? []) {
      if (!entry?.client_id) continue;
      next.set(entry.client_id, {
        id: entry.client_id,
        secrets: (entry.client_secrets ?? []).map((one) => String(one).toLowerCase()),
        scope: String(entry.scope ?? '').split(/\s+/).filter(Boolean),
        enabled: entry.enabled !== false,
        tokenTtlSeconds: Number(entry.token_ttl_seconds) || 900,
        perMinute: Number(entry.rate_limit_per_minute) || 60,
      });
    }

    const changed = describe(next) !== describe(clients);
    clients = next;
    readAt = now;
    readFrom = file;
    lastProblem = null;

    return { changed, reason: changed ? 'the list changed' : 'unchanged', count: clients.size };
  }

  return {
    reload,

    /** The client, if the secret matches one it holds and it is switched on. */
    check(clientId, secret) {
      reload();

      const client = clients.get(clientId);
      if (!client) return { ok: false, why: 'no such client' };
      if (!client.enabled) return { ok: false, why: 'this client is switched off' };

      const offered = crypto.createHash('sha256').update(String(secret ?? '')).digest('hex');

      // Compared in constant time, over every secret the client holds rather
      // than stopping at the first match. Returning early on a mismatch leaks,
      // through timing, how many secrets a client has and how far down the list
      // the right one is.
      let matched = false;
      for (const held of client.secrets) matched = same(offered, held) || matched;

      if (!matched) return { ok: false, why: 'that secret does not match' };
      return { ok: true, client };
    },

    get(clientId) {
      reload();
      return clients.get(clientId) ?? null;
    },

    /** What the service will admit to about its clients. Never a secret. */
    describe() {
      reload();
      return {
        file: readFrom,
        read_at: new Date(readAt).toISOString(),
        reload_every_ms: reloadEveryMs,
        problem: lastProblem,
        clients: [...clients.values()].map((client) => ({
          client_id: client.id,
          scope: client.scope,
          enabled: client.enabled,
          secrets_held: client.secrets.length,
          token_ttl_seconds: client.tokenTtlSeconds,
          rate_limit_per_minute: client.perMinute,
        })),
      };
    },
  };
}

/** A stable summary, so "did the file change" is not "is the mtime different". */
function describe(clients) {
  return JSON.stringify(
    [...clients.values()]
      .map((client) => [client.id, client.secrets, client.scope, client.enabled, client.perMinute])
      .sort()
  );
}

function same(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  return crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));
}

/** The hash to put in the file for a given secret. Used by `tools/add-client`. */
export function hashOf(secret) {
  return crypto.createHash('sha256').update(String(secret)).digest('hex');
}
