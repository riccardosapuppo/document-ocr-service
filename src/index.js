#!/usr/bin/env node
/**
 * Starts the service.
 *
 *     npm start
 *     npm start -- --port 3400 --clients ./config/clients.json
 *
 * Bound to localhost unless told otherwise, and it says which. A service that
 * reads documents somebody has uploaded and listens on every interface the
 * moment it starts has made a decision on their behalf.
 *
 * 3400, and not 3000. That is the port every project on a machine uses in turn,
 * and this one has already talked to another project's server left running on
 * it — answering questions about a system it has nothing to do with.
 */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

import { buildService } from './server.js';

const here = path.dirname(fileURLToPath(import.meta.url));

function argument(name, fallback) {
  const at = process.argv.indexOf(`--${name}`);
  return at !== -1 && process.argv[at + 1] ? process.argv[at + 1] : fallback;
}

function number(name, fallback) {
  const value = Number(argument(name, process.env[name.toUpperCase().replace(/-/g, '_')]));
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

const port = number('port', Number(process.env.PORT) || 3400);
const host = argument('host', process.env.HOST ?? '127.0.0.1');
const clientsFile = path.resolve(
  argument('clients', process.env.CLIENTS_FILE ?? path.join(here, '..', 'config', 'clients.json'))
);

/**
 * The signing secret.
 *
 * Generated per start when nothing is set, and it says so loudly. The
 * alternative — a default baked into the file — is a service that looks
 * configured, verifies tokens anybody can mint from the source, and gives no
 * sign of it. A secret that changes on restart invalidates outstanding tokens,
 * which is a nuisance in development and correct everywhere else.
 */
const jwtSecret = process.env.OAUTH_JWT_SECRET ?? crypto.randomBytes(32).toString('hex');
const invented = !process.env.OAUTH_JWT_SECRET;

function log(level, message, detail = {}) {
  // One JSON object per line. A log a person greps and a log a machine parses
  // are the same log, and the moment they are not, one of them stops being kept.
  process.stdout.write(
    `${JSON.stringify({ at: new Date().toISOString(), level, message, ...detail })}\n`
  );
}

if (!fs.existsSync(clientsFile)) {
  log('error', 'there is no client file, so nobody could call this', { file: clientsFile });
  process.exit(1);
}

const { api } = buildService({
  clientsFile,
  reloadEveryMs: number('reload-every-ms', Number(process.env.CLIENTS_RELOAD_MS) || 30_000),
  jwtSecret,
  retentionMs: number('job-retention-ms', Number(process.env.JOB_RETENTION_MS) || 30 * 60_000),
  rateWindowMs: number('rate-window-ms', Number(process.env.RATE_WINDOW_MS) || 60_000),
  maxUploadBytes: number('max-upload-bytes', Number(process.env.MAX_UPLOAD_BYTES) || 20 * 1024 * 1024),
  log,
});

const server = api.listen(port, host, () => {
  log('info', 'listening', {
    url: `http://${host}:${port}/`,
    clients_file: clientsFile,
    reads_pixels: Boolean(process.env.MISTRAL_API_KEY),
  });

  if (invented) {
    log('warn', 'OAUTH_JWT_SECRET was not set, so one was invented for this run', {
      meaning: 'every token stops working when this process restarts',
    });
  }

  if (!process.env.MISTRAL_API_KEY) {
    log('info', 'no engine that reads pixels is configured', {
      meaning: 'PDFs with a text layer are read; scans and photographs are refused with a reason',
      to_enable: 'set MISTRAL_API_KEY',
    });
  }
});

/**
 * A port that is already taken is a sentence, not a stack trace.
 *
 * Node's default for this is eleven lines of `at Server.setupListenHandle`
 * ending in EADDRINUSE, which says what happened to somebody who already knows
 * and nothing at all to anybody else. It happens on every second start during
 * development, and the thing the reader needs is the flag that fixes it.
 */
server.on('error', (error) => {
  if (error.code === 'EADDRINUSE') {
    log('error', `something is already listening on ${host}:${port}`, {
      likely: 'another copy of this service, or another project using the same port',
      try: `npm start -- --port ${port + 1}`,
    });
    process.exit(1);
  }

  if (error.code === 'EACCES') {
    log('error', `not allowed to listen on port ${port}`, {
      likely: 'ports below 1024 need privileges this process does not have',
    });
    process.exit(1);
  }

  throw error;
});

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    log('info', 'stopping', { signal });
    // Finishes what is in flight rather than cutting it off. A synchronous read
    // that is most of the way through a forty-page document should not be lost
    // because a deploy started.
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 5_000).unref();
  });
}
