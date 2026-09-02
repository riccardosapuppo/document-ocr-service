/**
 * The hosted engine: for documents that have no text in them to read.
 *
 * A scan, a photograph of a delivery note, a fax. There is nothing in the file
 * but pixels, and something has to look at them. This sends the page to
 * Mistral's OCR model and returns what comes back.
 *
 * It is **not configured by default** and that is deliberate. Without a key the
 * service still starts, still serves, and still reads every PDF that carries
 * its text — which is most of them. The moment somebody uploads a scan they are
 * told, in the answer, that this needs an engine that can read pixels and that
 * none is configured. A service that refuses to start without a key it may
 * never use is a service nobody evaluates.
 *
 * Written with `fetch` rather than an HTTP library. It is one POST with a JSON
 * body; a dependency to do that is a dependency to audit, to update, and to
 * explain.
 */

const ENDPOINT = 'https://api.mistral.ai/v1/ocr';

export function mistralEngine({
  apiKey = process.env.MISTRAL_API_KEY ?? '',
  model = process.env.MISTRAL_MODEL ?? 'mistral-ocr-latest',
  endpoint = process.env.MISTRAL_ENDPOINT ?? ENDPOINT,
  timeoutMs = Number(process.env.MISTRAL_TIMEOUT_MS ?? 120_000),
  maxRetries = Number(process.env.MISTRAL_MAX_RETRIES ?? 2),
  baseDelayMs = Number(process.env.MISTRAL_RETRY_BASE_DELAY_MS ?? 700),
  maxDelayMs = Number(process.env.MISTRAL_RETRY_MAX_DELAY_MS ?? 5_000),
  send = fetch,
  wait = (ms) => new Promise((done) => setTimeout(done, ms)),
  log = () => {},
} = {}) {
  return {
    name: 'mistral',
    needs: 'MISTRAL_API_KEY',

    canTry: (file) =>
      file.mimetype === 'application/pdf' || file.mimetype.startsWith('image/'),

    async read(file, { onProgress }) {
      if (!apiKey) {
        const missing = new Error(
          'this document needs an engine that can read pixels, and none is configured — set MISTRAL_API_KEY'
        );
        missing.code = 'ENGINE_NOT_CONFIGURED';
        throw missing;
      }

      const body = {
        model,
        document:
          file.mimetype === 'application/pdf'
            ? { type: 'document_url', document_url: asDataUrl(file) }
            : { type: 'image_url', image_url: asDataUrl(file) },
      };

      onProgress?.(0.3, 'sending the page to be recognised');

      const answer = await withRetries(
        async (attempt) => {
          if (attempt > 0) onProgress?.(0.4, `attempt ${attempt + 1}`);

          const stop = AbortSignal.timeout(timeoutMs);
          const response = await send(endpoint, {
            method: 'POST',
            headers: {
              Authorization: `Bearer ${apiKey}`,
              'Content-Type': 'application/json',
              Accept: 'application/json',
            },
            body: JSON.stringify(body),
            signal: stop,
          });

          if (!response.ok) {
            const trouble = new Error(`the recognition service answered ${response.status}`);
            trouble.status = response.status;
            // 408, 429 and 5xx are worth trying again. 400 and 401 are not:
            // the request will be just as wrong the second time, and retrying
            // an authentication failure is how a wrong key becomes a lockout.
            trouble.worthRetrying =
              response.status === 408 || response.status === 429 || response.status >= 500;
            throw trouble;
          }

          return response.json();
        },
        { maxRetries, baseDelayMs, maxDelayMs, wait, log }
      );

      onProgress?.(0.9, 'recognised');

      const pages = (answer.pages ?? []).map((page) => page.markdown ?? page.text ?? '');
      const text = pages.join('\n\n').trim();

      return {
        text,
        why: `recognised from the page by ${model}`,
        pages: pages.length,
        fonts: 0,
      };
    },
  };
}

function asDataUrl(file) {
  return `data:${file.mimetype};base64,${file.buffer.toString('base64')}`;
}

/**
 * Tries again, waiting longer each time, with the wait spread out.
 *
 * Doubling alone is not enough. When a service comes back after a wobble every
 * caller that backed off in the same second returns in the same second, and the
 * thing that was struggling is knocked over by the people waiting politely for
 * it. The randomness is the part that stops that, and it is the part usually
 * left out.
 */
async function withRetries(attempt, { maxRetries, baseDelayMs, maxDelayMs, wait, log }) {
  let last;

  for (let tries = 0; tries <= maxRetries; tries += 1) {
    try {
      return await attempt(tries);
    } catch (error) {
      last = error;

      const timedOut = error.name === 'TimeoutError' || error.name === 'AbortError';
      const worth = error.worthRetrying === true || timedOut;

      if (!worth || tries === maxRetries) break;

      const doubled = Math.min(maxDelayMs, baseDelayMs * 2 ** tries);
      const spread = Math.floor(doubled / 2 + Math.random() * (doubled / 2));

      log('info', 'trying again', { after_ms: spread, attempt: tries + 1, why: error.message });
      await wait(spread);
    }
  }

  throw last;
}
