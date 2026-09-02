/**
 * The service: one pipeline, offered three ways.
 *
 * Synchronous, streaming, and a job to poll. They are the same work — the same
 * engines, the same progress, the same result — behind three different shapes
 * of promise, and that is the point of building them together:
 *
 *   `POST /api/read`         wait for it. Simple, and fine for a text layer.
 *   `POST /api/read/live`    NDJSON, one line per step. For a person watching.
 *   `POST /api/jobs`         an id to come back for. For work that takes a while.
 *
 * A caller picks by how long it can afford to wait and whether anybody is
 * looking at a screen. Nothing else differs.
 *
 * Every answer carries `X-Request-Id`, including the failures. It is the only
 * thing a caller can put in a support message that lets somebody find the
 * request in a log, and adding it after the fact means adding it to the
 * successes and forgetting the errors.
 */

import crypto from 'node:crypto';
import express from 'express';
import multer from 'multer';

import { clientList } from './auth/clients.js';
import { carries, tokenIssuer } from './auth/tokens.js';
import { rateLimiter } from './auth/rate.js';
import { engineRegistry } from './ocr/engines.js';
import { jobStore } from './jobs/store.js';

/** What this will accept. Anything else is refused before it is read. */
const ACCEPTS = new Set([
  'application/pdf',
  'image/png',
  'image/jpeg',
  'image/tiff',
  'image/webp',
]);

export function buildService(settings) {
  const {
    clientsFile,
    reloadEveryMs,
    jwtSecret,
    issuer = 'document-ocr-service',
    audience = 'document-ocr-service',
    maxUploadBytes = 20 * 1024 * 1024,
    retentionMs,
    rateWindowMs,
    mistral = {},
    log = () => {},
    at = () => Date.now(),
  } = settings;

  const clients = clientList({
    file: clientsFile,
    reloadEveryMs,
    at,
    warn: (message, detail) => log('warn', message, { detail }),
  });
  clients.reload({ force: true });

  const tokens = tokenIssuer({ secret: jwtSecret, issuer, audience, at });
  const limiter = rateLimiter({ windowMs: rateWindowMs, at });
  const jobs = jobStore({ retentionMs, at });
  const engines = engineRegistry({ mistral, log });

  const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: maxUploadBytes, files: 1 },
  });

  const api = express();
  api.disable('x-powered-by');
  api.use(express.json({ limit: '64kb' }));
  api.use(express.urlencoded({ extended: false, limit: '64kb' }));

  // Every request gets an id before anything can go wrong with it.
  api.use((req, res, next) => {
    req.id = String(req.get('X-Request-Id') ?? crypto.randomUUID()).slice(0, 64);
    res.setHeader('X-Request-Id', req.id);
    next();
  });

  // ------------------------------------------------------------------- token

  api.post('/oauth/token', (req, res) => {
    const grant = req.body?.grant_type;

    if (grant !== 'client_credentials') {
      return res.status(400).json({
        error: 'unsupported_grant_type',
        error_description: 'this service issues tokens to software, not to people',
        supported: ['client_credentials'],
      });
    }

    // Credentials may arrive in the body or in a Basic header. Both are in the
    // specification and callers use both; supporting one means somebody's HTTP
    // library cannot talk to this at all.
    const fromHeader = basicCredentials(req.get('Authorization'));
    const clientId = req.body?.client_id ?? fromHeader?.id;
    const secret = req.body?.client_secret ?? fromHeader?.secret;

    const found = clients.check(clientId, secret);
    if (!found.ok) {
      log('warn', 'a token was refused', { request_id: req.id, client_id: clientId, why: found.why });
      // One answer for every reason. Distinguishing "no such client" from
      // "wrong secret" hands an attacker a list of valid client ids.
      return res.status(401).json({
        error: 'invalid_client',
        error_description: 'those credentials were not accepted',
      });
    }

    return res.json(tokens.issue(found.client, req.body?.scope));
  });

  // ---------------------------------------------------------------- the guard

  function needs(...scopes) {
    return (req, res, next) => {
      const header = req.get('Authorization') ?? '';
      const token = header.startsWith('Bearer ') ? header.slice(7).trim() : '';

      if (!token) {
        return res
          .status(401)
          .set('WWW-Authenticate', 'Bearer')
          .json({ error: 'no token', error_description: 'send an access token' });
      }

      const read = tokens.read(token);
      if (!read.ok) {
        return res
          .status(401)
          .set('WWW-Authenticate', 'Bearer error="invalid_token"')
          .json({ error: 'invalid_token', error_description: read.why });
      }

      if (!carries(read.scope, scopes)) {
        return res.status(403).json({
          error: 'insufficient_scope',
          error_description: `this needs ${scopes.join(' and ')}`,
          you_have: read.scope,
        });
      }

      // The client is re-read from the file on every call rather than trusted
      // from the token. A token lives fifteen minutes; switching a client off
      // has to take effect now, not when its last token expires.
      const client = clients.get(read.clientId);
      if (!client || !client.enabled) {
        return res.status(403).json({
          error: 'client_disabled',
          error_description: 'this client is no longer permitted',
        });
      }

      const allowed = limiter.take(client.id, client.perMinute);
      res.setHeader('X-RateLimit-Limit', String(allowed.limit));
      res.setHeader('X-RateLimit-Remaining', String(allowed.remaining));

      if (!allowed.ok) {
        res.setHeader('Retry-After', String(allowed.retryAfterSeconds));
        return res.status(429).json({
          error: 'too_many_requests',
          error_description: `${client.perMinute} calls a minute for this client`,
          retry_after_seconds: allowed.retryAfterSeconds,
        });
      }

      req.client = client;
      req.token = read;
      return next();
    };
  }

  /** A file that is missing, empty, or of a kind nothing here can read. */
  function refuse(file) {
    if (!file) return { status: 400, error: 'send a file in a field called "document"' };
    if (file.size === 0) return { status: 400, error: 'that file is empty' };
    if (!ACCEPTS.has(file.mimetype)) {
      return {
        status: 415,
        error: `this service does not read ${file.mimetype}`,
        it_reads: [...ACCEPTS],
      };
    }
    return null;
  }

  // ------------------------------------------------------------ 1. wait for it

  api.post('/api/read', needs('ocr:write'), upload.single('document'), async (req, res) => {
    const no = refuse(req.file);
    if (no) return res.status(no.status).json({ ok: false, request_id: req.id, ...no });

    const started = at();

    try {
      const got = await engines.read(req.file, { only: req.body?.engine ?? null });

      log('info', 'read', {
        request_id: req.id,
        client_id: req.client.id,
        engine: got.engine,
        ms: at() - started,
      });

      return res.json({
        ok: true,
        request_id: req.id,
        engine: got.engine,
        why: got.why,
        pages: got.pages,
        characters: got.text.length,
        took_ms: at() - started,
        tried: got.tried,
        text: got.text,
      });
    } catch (error) {
      return res.status(error.status ?? 500).json({
        ok: false,
        request_id: req.id,
        error: error.message,
        tried: error.tried ?? [],
      });
    }
  });

  // ---------------------------------------------------------- 2. watch it work

  api.post('/api/read/live', needs('ocr:write'), upload.single('document'), async (req, res) => {
    const no = refuse(req.file);
    if (no) return res.status(no.status).json({ ok: false, request_id: req.id, ...no });

    // NDJSON: one JSON object per line. Chosen over server-sent events because
    // the caller here is usually another program, and a program parsing NDJSON
    // needs `split('\n')` where SSE needs a client library.
    res.status(200);
    res.setHeader('Content-Type', 'application/x-ndjson; charset=utf-8');
    res.setHeader('Cache-Control', 'no-store');
    // Without this an nginx in front will buffer the whole response and deliver
    // it in one piece at the end, which is a streaming endpoint that does not
    // stream and looks like a hung request.
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders?.();

    const line = (event) => res.write(`${JSON.stringify(event)}\n`);
    const started = at();

    line({ type: 'started', request_id: req.id, filename: req.file.originalname, at: nowIso(at) });

    try {
      const got = await engines.read(req.file, {
        only: req.body?.engine ?? null,
        onProgress: (progress, step) =>
          line({ type: 'progress', request_id: req.id, progress, step, at: nowIso(at) }),
      });

      line({
        type: 'result',
        ok: true,
        request_id: req.id,
        engine: got.engine,
        why: got.why,
        pages: got.pages,
        characters: got.text.length,
        took_ms: at() - started,
        text: got.text,
      });
    } catch (error) {
      // The error goes in the body, not in the status: the status line went out
      // with the first byte. A streaming endpoint that tries to fail with a 500
      // after it has begun sends a 200 with nothing in it.
      line({
        type: 'error',
        ok: false,
        request_id: req.id,
        error: error.message,
        tried: error.tried ?? [],
      });
    } finally {
      res.end();
    }
  });

  // --------------------------------------------------------- 3. come back for it

  api.post('/api/jobs', needs('ocr:write'), upload.single('document'), (req, res) => {
    const no = refuse(req.file);
    if (no) return res.status(no.status).json({ ok: false, request_id: req.id, ...no });

    let id;
    try {
      id = jobs.open({
        clientId: req.client.id,
        filename: req.file.originalname,
        size: req.file.size,
        mimetype: req.file.mimetype,
      });
    } catch (error) {
      return res.status(error.status ?? 500).json({ ok: false, request_id: req.id, error: error.message });
    }

    const file = req.file;
    const only = req.body?.engine ?? null;

    // Answered before the work starts, deliberately. The promise of this shape
    // is "I have it", and a caller kept waiting for the answer to a request
    // whose whole point is not waiting has been given the worst of both.
    res.status(202).json({
      ok: true,
      request_id: req.id,
      job_id: id,
      state: 'waiting',
      collect_from: `/api/jobs/${id}`,
    });

    engines
      .read(file, { only, onProgress: (progress, step) => jobs.progress(id, progress, step) })
      .then((got) =>
        jobs.done(id, {
          engine: got.engine,
          why: got.why,
          pages: got.pages,
          characters: got.text.length,
          text: got.text,
        })
      )
      .catch((error) => jobs.failed(id, { error: error.message, tried: error.tried ?? [] }));
  });

  api.get('/api/jobs/:id', needs('ocr:read'), (req, res) => {
    const job = jobs.read(req.params.id, req.client.id);

    if (!job) {
      return res.status(404).json({
        ok: false,
        request_id: req.id,
        error: 'no such job',
        error_description: 'it never existed, it was not yours, or it has been thrown away',
      });
    }

    return res.json({ ok: true, request_id: req.id, ...job });
  });

  // ------------------------------------------------------------------- itself

  api.get('/api/health', (req, res) => {
    res.json({
      status: 'ok',
      engines: engines.all(),
      jobs: jobs.counts(),
      clients_watched_for_rate: limiter.watching(),
      reads_pixels: Boolean(mistral.apiKey ?? process.env.MISTRAL_API_KEY),
    });
  });

  /**
   * What the service knows about its clients — never a secret, and never the
   * hash of one either. A hash is not a password and is also not nothing:
   * published, it is an offline guessing target.
   */
  api.get('/api/clients', needs('ocr:read'), (req, res) => {
    res.json({ request_id: req.id, ...clients.describe() });
  });

  api.use(express.static(new URL('../public', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')));

  api.use((req, res) => {
    res.status(404).json({
      error: 'no such endpoint',
      you_asked_for: `${req.method} ${req.originalUrl}`,
      it_starts_at: '/api/health',
    });
  });

  // eslint-disable-next-line no-unused-vars
  api.use((error, req, res, next) => {
    if (error?.code === 'LIMIT_FILE_SIZE') {
      return res.status(413).json({
        ok: false,
        request_id: req.id,
        error: `that file is larger than this service accepts`,
        limit_bytes: maxUploadBytes,
      });
    }

    log('error', 'unhandled', { request_id: req.id, error: error?.message });
    if (res.headersSent) return next(error);
    return res.status(500).json({ ok: false, request_id: req.id, error: 'something went wrong here' });
  });

  return { api, clients, jobs, limiter, engines };
}

function basicCredentials(header) {
  if (!header?.startsWith('Basic ')) return null;
  const decoded = Buffer.from(header.slice(6), 'base64').toString('utf8');
  const at = decoded.indexOf(':');
  if (at === -1) return null;
  return { id: decoded.slice(0, at), secret: decoded.slice(at + 1) };
}

function nowIso(at) {
  return new Date(at()).toISOString();
}
