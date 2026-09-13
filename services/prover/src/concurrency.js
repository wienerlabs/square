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

/**
 * This limiter's own deadline, recognised by identity rather than by wording.
 *
 * square#236's review: the outcome was decided with `/timed out/` against the
 * error message, so `ETIMEDOUT: socket timed out` and `zkey read timed out` --
 * this service's own failures, which no retry will fix -- were reported as
 * `timeout` and answered 504, telling the caller to try again. The limiter
 * builds this error two lines from where it catches it, so there is nothing
 * left to guess at.
 */
export class ProofTimeout extends Error {
  constructor(timeoutMs) {
    super(`proof timed out after ${timeoutMs} ms`);
    this.name = 'ProofTimeout';
    this.timeoutMs = timeoutMs;
  }
}

// A setting that is not a positive whole number falls back to the default, and
// says which one it ignored. Silence made `PROVER_MAX_CONCURRENCY=0`, `2.5` and
// a typo indistinguishable from leaving it unset, so an operator who thought
// they had pinned the ceiling had not (square#236's review). The value itself
// is not logged -- only the name of the setting and what was used instead.
const positiveInteger = (value, fallback, setting) => {
  if (value === undefined || value === null || value === '') return fallback;
  const parsed = Number(value);
  if (Number.isInteger(parsed) && parsed > 0) return parsed;
  console.error(JSON.stringify({ event: 'config_ignored', setting, using: fallback }));
  return fallback;
};

// Two, measured, rather than one per core.
//
// The first version of this followed `os.availableParallelism()`. square#236's
// review asked why, when snarkjs proves on the main thread: N admitted proofs
// share one event loop, not N cores. Measured here against the real artifacts,
// 16 proofs offered at once, four ceilings:
//
//   ceiling   wall clock   peak RSS   /health worst
//     1        11 216 ms      975 MB      179 ms
//     2        10 462 ms      994 MB      348 ms
//     4         9 893 ms    1 123 MB      348 ms
//     8        10 418 ms    1 269 MB      455 ms
//
// Throughput is flat. Sixteen proofs cost about ten seconds at every ceiling,
// because the work is one thread's however many are admitted. Memory is not
// flat: each further slot costs roughly 42 MB of peak RSS, since every proof in
// flight holds its own read of the proving key. A ceiling past the point where
// throughput stops improving therefore buys nothing and pays for it in the
// bound that actually matters.
//
// Two is that point. On the ten-core machine this was measured on, the old
// default paid about 380 MB for it. `/health` is comfortable throughout -- 455
// ms at worst against the Dockerfile's five-second probe timeout -- so the
// ceiling is not what keeps the container alive; it is what keeps it from being
// killed for memory.
//
// An operator with a larger machine, a smaller circuit, or a prover moved into
// workers can raise it with PROVER_MAX_CONCURRENCY.
export const DEFAULT_CONCURRENCY = 2;
export const defaultConcurrency = () => DEFAULT_CONCURRENCY;

/**
 * A counting semaphore with a bounded waiting room.
 *
 * `run` either starts the work now, waits for a slot, or is refused. Refusal is
 * the point: a queue with no bound is the same failure as no queue at all,
 * arriving later and with the sockets still held.
 */
export function createProofLimiter(options = {}) {
  const limit = positiveInteger(options.limit, defaultConcurrency(), 'PROVER_MAX_CONCURRENCY');
  const queueLimit = positiveInteger(options.queueLimit, limit, 'PROVER_MAX_QUEUE');
  const timeoutMs = positiveInteger(options.timeoutMs, 30_000, 'PROVER_PROOF_TIMEOUT_MS');

  let active = 0;
  let peak = 0;
  const waiting = [];

  // Saturation is only worth anything if something outside can see it.
  //
  // square#236's review: `active` and `queued` were read in one place, to build
  // a log line on the shed path, so there was no gauge to alert on and nothing
  // at all to see while the service was merely busy. This fires on every
  // transition rather than on a timer, so a scrape reads the state as it is.
  const notify = () => options.onChange?.({ active, queued: waiting.length, limit });

  const release = () => {
    active -= 1;
    const next = waiting.shift();
    if (next) {
      active += 1;
      peak = Math.max(peak, active);
      next();
    }
    notify();
  };

  // A ticket rather than a bare promise: a request whose deadline passes while
  // it is still queued has to be able to leave the queue. Without `cancel` it
  // would be admitted later, take a slot, and hold it for work nobody is
  // waiting for any more.
  const acquire = () => {
    if (active < limit) {
      active += 1;
      peak = Math.max(peak, active);
      notify();
      return { admitted: Promise.resolve(true), cancel() {} };
    }
    if (waiting.length >= queueLimit) return { admitted: Promise.resolve(false), cancel() {} };
    let entry;
    const admitted = new Promise((admit) => { entry = () => admit(true); waiting.push(entry); });
    notify();
    return {
      admitted,
      cancel() {
        const at = waiting.indexOf(entry);
        if (at >= 0) {
          waiting.splice(at, 1);
          notify();
        }
      },
    };
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
     * Resolves `{ ok: true, value }`; `{ ok: false, reason: 'shed' }` when the
     * ceiling and the queue are both full; or
     * `{ ok: false, reason: 'timeout', error, started }` when `timeoutMs`
     * passed, where `started` says whether the work was ever begun or the
     * request was still waiting for a slot.
     *
     * On a timeout the caller is answered and the work is not stopped, because
     * `snarkjs.groth16.fullProve` takes no abort signal. What it does *not* do
     * is release the slot: the proof is still running and still holding its
     * read of the proving key, so the ceiling goes on counting it. Releasing
     * there was measured in the review of square#236 to let a ceiling of 2 hold
     * 60 proofs at once, which is the memory bound failing at precisely the
     * moment it is needed. Stopping the arithmetic itself needs the proof in a
     * worker, which is a larger change than this issue asks for.
     */
    async run(work) {
      // The deadline is the caller's, so it runs from when the request arrives
      // rather than from when a slot frees.
      //
      // square#236 asked for a bound per request. Started at admission, it was
      // not one: with a ceiling of 1, a queue of 50 and a 5 000 ms bound, the
      // last caller was answered after 5 147 ms and nothing was ever shed,
      // because each request's clock began only once it reached the front.
      let timer;
      let abandoned = false;
      const deadline = new Promise((_, reject) => {
        timer = setTimeout(() => {
          abandoned = true;
          reject(new ProofTimeout(timeoutMs));
        }, timeoutMs);
      });
      // It may reject with nobody listening -- when the work finished first --
      // and an unhandled rejection takes the process down.
      deadline.catch(() => {});

      const ticket = acquire();
      let admitted;
      try {
        admitted = await Promise.race([ticket.admitted, deadline]);
      } catch (error) {
        // Out of time while still waiting for a slot. Leave the queue, and if
        // admission happened in the same turn, hand the slot straight back.
        ticket.cancel();
        ticket.admitted.then((got) => { if (got) release(); });
        clearTimeout(timer);
        return { ok: false, reason: 'timeout', error, started: false };
      }
      if (!admitted) {
        clearTimeout(timer);
        return { ok: false, reason: 'shed' };
      }

      // The slot follows the work, not the caller's patience.
      //
      // Releasing it at the deadline was measured in the review of square#236
      // and it undoes the ceiling: snarkjs takes no abort signal, so a proof
      // past its deadline is still running and still holding its read of the
      // proving key, and freeing the slot admits another one on top of it. A
      // steady arrival against a ceiling of 2 reached 60 proofs at once that
      // way, with `peak` still reading 2. Timeouts fire when the machine is
      // already too slow, which is when the memory bound matters most.
      //
      // The caller is still answered at the deadline; only the slot waits.
      const settled = Promise.resolve().then(work);
      settled.then(release, release);

      try {
        const value = await Promise.race([
          // A rejection the caller is no longer waiting for has nobody left to
          // catch it, and an unhandled rejection takes the process down.
          settled.catch((error) => { if (abandoned) return undefined; throw error; }),
          // The same deadline that was already running while this request
          // queued -- not a second one started on admission, which is what made
          // the bound per slot rather than per request.
          deadline,
        ]);
        return { ok: true, value };
      } catch (error) {
        if (error instanceof ProofTimeout) return { ok: false, reason: 'timeout', error, started: true };
        throw error;
      } finally {
        clearTimeout(timer);
      }
    },
  };
}
