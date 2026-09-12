// How many proofs may be in flight, how many may wait, and how long one may run.
//
// square#236. `POST /prove` started a Groth16 proof per request and nothing
// bounded how many ran at once: no semaphore, no queue, no per-request
// deadline, and no authentication in front of any of it. Measured with a stub
// standing in for snarkjs, 250 concurrent requests produced a peak of 243
// simultaneous proofs and zero back-pressure responses.
//
// With the real artifacts each of those re-reads the proving key: snarkjs opens
// the zkey per proof with a 32 MiB read cache (`readBinFile(..., 1<<25, 1<<23)`)
// and loads the coefficient section into memory, and there is no cache between
// requests. So the arithmetic that matters is memory, and the failure is the
// container being OOM-killed or falling far enough behind that its health probe
// gives up — taking every proof in flight with it.
//
// Two measurements shaped the defaults, both on this repository's circuit:
//
//   one proof                              1 158 ms
//   worst event-loop stall while it ran      159 ms
//
// A proof is mostly asynchronous work rather than one long block, which is why
// a ceiling is enough to keep /health and /metrics answering while the service
// is saturated — they do not need a thread of their own, only a loop that is
// not hopelessly oversubscribed.
//
// Nothing here is a rate limiter. It bounds concurrent work, not requests per
// caller; `packages/hardening` has the second thing and speaks Hono rather than
// Express, so its conventions are followed (a 503 with `Retry-After`) rather
// than its code imported.

import os from 'node:os';

const positiveInteger = (value, fallback) => {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
};

// One proof per unit of parallelism the environment reports. A proof is
// CPU-bound in wasm for part of its run, so more than that buys queueing
// dressed up as concurrency, and each one in flight holds its own copy of the
// key's coefficients.
export const defaultConcurrency = () => Math.max(1, os.availableParallelism?.() ?? os.cpus().length ?? 1);

/**
 * A counting semaphore with a bounded waiting room.
 *
 * `run` either starts the work now, waits for a slot, or is refused. Refusal is
 * the point: a queue with no bound is the same failure as no queue at all,
 * arriving later and with the sockets still held.
 */
export function createProofLimiter(options = {}) {
  const limit = positiveInteger(options.limit, defaultConcurrency());
  const queueLimit = positiveInteger(options.queueLimit, limit);
  const timeoutMs = positiveInteger(options.timeoutMs, 30_000);

  let active = 0;
  let peak = 0;
  const waiting = [];

  const release = () => {
    active -= 1;
    const next = waiting.shift();
    if (next) {
      active += 1;
      peak = Math.max(peak, active);
      next();
    }
  };

  const acquire = () => {
    if (active < limit) {
      active += 1;
      peak = Math.max(peak, active);
      return Promise.resolve(true);
    }
    if (waiting.length >= queueLimit) return Promise.resolve(false);
    return new Promise((admit) => waiting.push(() => admit(true)));
  };

  return {
    limit,
    queueLimit,
    timeoutMs,
    get active() { return active; },
    get queued() { return waiting.length; },
    get peak() { return peak; },

    /**
     * Run `work` under the ceiling.
     *
     * Resolves `{ ok: true, value }`, `{ ok: false, reason: 'shed' }` when the
     * ceiling and the queue are both full, or `{ ok: false, reason: 'timeout' }`
     * when the work outran `timeoutMs`.
     *
     * On a timeout the slot is released and the response is sent; the work
     * itself keeps running to completion in the background, because
     * `snarkjs.groth16.fullProve` takes no abort signal. That is the cheaper of
     * the two shapes square#236 describes, and it is honest about what it does:
     * the caller stops waiting, the slot stops being held, and the process
     * finishes the arithmetic it already started. Terminating mid-proof needs
     * the proof to run in a worker, which is a larger change than this issue
     * asks for.
     */
    async run(work) {
      const admitted = await acquire();
      if (!admitted) return { ok: false, reason: 'shed' };

      let timer;
      let released = false;
      const free = () => {
        if (released) return;
        released = true;
        release();
      };
      try {
        const timeout = new Promise((_, reject) => {
          timer = setTimeout(() => reject(new Error(`proof timed out after ${timeoutMs} ms`)), timeoutMs);
        });
        const value = await Promise.race([
          Promise.resolve()
            .then(work)
            // A rejection after the race is lost has nobody left to catch it,
            // and an unhandled rejection takes the process down.
            .catch((error) => { if (released) return undefined; throw error; }),
          timeout,
        ]);
        return { ok: true, value };
      } catch (error) {
        if (/timed out/.test(String(error?.message))) return { ok: false, reason: 'timeout', error };
        throw error;
      } finally {
        clearTimeout(timer);
        free();
      }
    },
  };
}
