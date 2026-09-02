/**
 * Jobs that outlive the request that made them.
 *
 * The third of the three ways to call this service. A synchronous call holds a
 * connection for as long as the work takes, which is fine for a text layer and
 * not fine for forty scanned pages: proxies close idle connections, browsers
 * give up, and the caller has no way to ask again. So: submit, get an id, come
 * back.
 *
 * In memory, and the README says so. A job that has to survive a restart wants
 * a queue, and a queue wants a broker, a worker and a way to run them — all of
 * which is the right answer for a busy deployment and none of which is the
 * subject here. What IS the subject is that the three ways are the same work
 * behind three different shapes of promise, which is visible when they share a
 * pipeline and invisible when the asynchronous one is a separate program.
 *
 * Finished jobs are thrown away after a while. Keeping them forever turns a
 * service into a leak; throwing them away at once means a caller who was
 * disconnected at the wrong moment can never collect a result that exists. The
 * retention window is the answer to both and it is configurable.
 */

import crypto from 'node:crypto';

export function jobStore({ retentionMs = 30 * 60_000, at = () => Date.now(), max = 1000 } = {}) {
  /** @type {Map<string, object>} */
  const jobs = new Map();

  function sweep() {
    const now = at();
    for (const [id, job] of jobs) {
      if (job.state === 'running' || job.state === 'waiting') continue;
      if (now - job.finishedAt > retentionMs) jobs.delete(id);
    }
  }

  return {
    /**
     * Takes a job on. The id is random, not sequential.
     *
     * A sequential id lets anybody holding one guess the others, and the scope
     * that reads a job does not say WHICH jobs — so a caller with `ocr:read`
     * and a counter could walk the results of every other caller. That is a
     * real hole and the id is where it is closed.
     */
    open({ clientId, filename, size, mimetype }) {
      sweep();

      if (jobs.size >= max) {
        const full = new Error('too many jobs are being held; try again shortly');
        full.status = 503;
        throw full;
      }

      const id = crypto.randomUUID();

      jobs.set(id, {
        id,
        clientId,
        filename,
        size,
        mimetype,
        state: 'waiting',
        progress: 0,
        step: 'accepted',
        openedAt: at(),
        finishedAt: null,
        result: null,
        problem: null,
      });

      return id;
    },

    progress(id, progress, step) {
      const job = jobs.get(id);
      if (!job) return;
      job.state = 'running';
      job.progress = Math.max(0, Math.min(1, progress));
      job.step = step;
    },

    done(id, result) {
      const job = jobs.get(id);
      if (!job) return;
      job.state = 'done';
      job.progress = 1;
      job.step = 'finished';
      job.result = result;
      job.finishedAt = at();
    },

    failed(id, problem) {
      const job = jobs.get(id);
      if (!job) return;
      job.state = 'failed';
      job.step = 'stopped';
      job.problem = problem;
      job.finishedAt = at();
    },

    /**
     * A job, to the client that opened it.
     *
     * The client id is checked here rather than by the caller. A permission
     * that has to be remembered at every call site is a permission that will be
     * forgotten at one of them, and this is the call site.
     */
    read(id, clientId) {
      sweep();

      const job = jobs.get(id);
      // The same answer for "no such job" and "not yours". Distinguishing them
      // turns the id into an oracle for which jobs exist.
      if (!job || job.clientId !== clientId) return null;

      return {
        job_id: job.id,
        state: job.state,
        progress: job.progress,
        step: job.step,
        filename: job.filename,
        size: job.size,
        opened_at: new Date(job.openedAt).toISOString(),
        finished_at: job.finishedAt === null ? null : new Date(job.finishedAt).toISOString(),

        // Compared against null, not tested for truth. A job that finished at
        // the epoch has a timestamp of 0, and `0 ? a : b` says it never
        // finished — which is exactly what a test with an injected clock
        // starting at zero found, and exactly what nothing would have found in
        // production until a clock somewhere was wrong.
        kept_until:
          job.finishedAt === null ? null : new Date(job.finishedAt + retentionMs).toISOString(),
        result: job.result,
        problem: job.problem,
      };
    },

    counts() {
      sweep();
      const counted = { waiting: 0, running: 0, done: 0, failed: 0 };
      for (const job of jobs.values()) counted[job.state] += 1;
      return { ...counted, held: jobs.size, retention_ms: retentionMs };
    },
  };
}
