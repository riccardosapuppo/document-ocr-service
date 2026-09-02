/**
 * How often one client may call, counted per client and not per address.
 *
 * Per address is the usual shortcut and it is wrong for this: every caller here
 * is a server, several of them sit behind the same egress address, and the one
 * that matters — the one whose retry loop has gone wrong at three in the
 * morning — is identified by the token it presents, not by where it came from.
 *
 * A sliding window rather than a fixed one. A fixed window lets a client spend
 * its whole minute in the last second of one window and the whole of the next
 * in the first second of the following, which is twice the quota back to back —
 * exactly the burst the limit exists to prevent, arriving at the worst moment.
 *
 * The timestamps are kept in memory, which is honest about what this is: one
 * process. Behind two of them the quota is per process, and the README says so
 * rather than leaving somebody to discover it.
 */

export function rateLimiter({ windowMs = 60_000, at = () => Date.now() } = {}) {
  /** @type {Map<string, number[]>} */
  const calls = new Map();

  return {
    /**
     * Records a call and says whether it is allowed.
     *
     * `retryAfterSeconds` is real, not a constant: it is when the oldest call
     * in the window falls out of it. A caller told to wait exactly as long as
     * it needs to stops guessing, and a caller told "60" every time re-arrives
     * in a herd.
     */
    take(clientId, perMinute) {
      const now = at();
      const from = now - windowMs;

      const seen = (calls.get(clientId) ?? []).filter((when) => when > from);

      if (seen.length >= perMinute) {
        calls.set(clientId, seen);
        const oldest = seen[0];
        return {
          ok: false,
          limit: perMinute,
          remaining: 0,
          retryAfterSeconds: Math.max(1, Math.ceil((oldest + windowMs - now) / 1000)),
        };
      }

      seen.push(now);
      calls.set(clientId, seen);

      return { ok: true, limit: perMinute, remaining: perMinute - seen.length, retryAfterSeconds: 0 };
    },

    /**
     * Drops clients that have not called for a while.
     *
     * Without this the map grows once per client id ever seen, and a caller
     * that generates a fresh id per deployment turns a rate limiter into a leak
     * that takes a fortnight to become visible.
     */
    forgetIdle() {
      const from = at() - windowMs;
      for (const [clientId, seen] of calls) {
        if (seen.every((when) => when <= from)) calls.delete(clientId);
      }
      return calls.size;
    },

    watching() {
      return calls.size;
    },
  };
}
