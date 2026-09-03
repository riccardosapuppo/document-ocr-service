/**
 * Start the service a check needs, and stop it again.
 *
 * ── Why this exists ──────────────────────────────────────────────────────────
 *
 * `npm run walkthrough` and `npm run check:screen` used to fetch
 * `http://localhost:3400` and expect somebody to have started the service
 * first. Two failure modes, and the second is much worse.
 *
 * On a clean machine they fail, which is honest — and means the publication
 * gate cannot run them, so they run only when somebody remembers, which is the
 * arrangement every rule in this repository exists to avoid.
 *
 * And on a machine where anything *is* listening on 3400 they pass, **against
 * whatever that is**. A copy left running from an hour ago on an older commit
 * answers exactly like a fresh one. That has already happened here: a green
 * gate run passed because a service from a manual test was still up. It was
 * green by luck, which is not a property anybody should rely on twice.
 *
 * So a check starts its own, on a port nothing else uses, and takes it away
 * afterwards. `--against <url>` points one at something already running: a
 * deliberate act, with a flag on it, which is the whole difference.
 */

import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, '..');

/** A port for checks and nothing else. Not 3400: that is where a person runs it. */
export const CHECK_PORT = 3499;

/** `--against http://…`, when somebody means to test a running instance. */
export function against(argv = process.argv) {
  const at = argv.indexOf('--against');
  return at !== -1 && argv[at + 1] ? argv[at + 1] : null;
}

/**
 * Starts the service and returns where to talk to it.
 *
 * @returns {Promise<{base: string, stop: () => Promise<void>, mine: boolean}>}
 */
export async function startTheService({ quiet = true } = {}) {
  const already = against();

  if (already) {
    console.log(`Against ${already}, which somebody else started.\n`);
    return { base: already, mine: false, stop: async () => {} };
  }

  const child = spawn(
    process.execPath,
    [path.join(root, 'src', 'index.js'), '--port', String(CHECK_PORT), '--no-open'],
    {
      cwd: root,
      stdio: ['ignore', 'pipe', 'pipe'],
      // A signing secret of its own, so a check never mints a token that some
      // other copy of the service would accept, and never accepts one minted
      // elsewhere.
      //
      // Padded to the length the service insists on. It refuses to start below
      // 32 characters, which is the right thing to insist on and cost this
      // helper one run to discover — a run that said so in one line, because it
      // watches for the child exiting rather than only for the port.
      env: { ...process.env, OAUTH_JWT_SECRET: `checks-only-${process.pid}`.padEnd(48, '0') },
    }
  );

  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');

  if (!quiet) {
    child.stdout.on('data', (chunk) => process.stderr.write(`[service] ${chunk}`));
    child.stderr.on('data', (chunk) => process.stderr.write(`[service] ${chunk}`));
  }

  const stop = async () => {
    if (child.exitCode === null && child.signalCode === null) child.kill();
    // A moment for the socket to go, so a check run twice does not meet the
    // previous one.
    await new Promise((done) => setTimeout(done, 300));
  };

  try {
    const base = `http://127.0.0.1:${CHECK_PORT}`;
    await untilItAnswers(child, `${base}/api/health`, 30_000);
    return { base, mine: true, stop };
  } catch (error) {
    await stop();
    throw error;
  }
}

/**
 * Runs `body(base)` with a service of its own, stopped afterwards however the
 * body ended — a check that leaves a service running is a check that makes the
 * next one lie.
 */
export async function withTheService(body, options = {}) {
  const service = await startTheService(options);

  try {
    return await body(service.base);
  } finally {
    await service.stop();
  }
}

/**
 * Poll until it answers, and give up early if it has died.
 *
 * Watching for the exit matters: without it, a service that cannot bind its
 * port makes this wait the full thirty seconds and then report a timeout, when
 * what actually happened was `EADDRINUSE` in the first fifty milliseconds and
 * it said so.
 */
async function untilItAnswers(child, url, ms) {
  const until = Date.now() + ms;
  let said = '';

  child.stdout.on('data', (chunk) => {
    said += chunk;
  });
  child.stderr.on('data', (chunk) => {
    said += chunk;
  });

  for (;;) {
    if (child.exitCode !== null) {
      throw new Error(`the service exited with ${child.exitCode} before answering. It said: ${said.trim()}`);
    }

    try {
      const response = await fetch(url);
      if (response.ok) return;
    } catch {
      /* not up yet */
    }

    if (Date.now() > until) throw new Error(`${url} never answered within ${ms / 1000}s. It said: ${said.trim()}`);
    await new Promise((done) => setTimeout(done, 200));
  }
}
