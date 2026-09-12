// The ceiling itself, without a server in the way.
//
// square#236 measured the shape of the gap with a stub standing in for snarkjs:
// 250 concurrent POST /prove produced a peak of 243 simultaneous proofs, 250
// responses of 200, and no back-pressure at all. The same shape is asserted
// here against the limiter, which is where the property lives.

import { describe, it, expect } from 'vitest';
import { createProofLimiter, defaultConcurrency } from '../src/concurrency.js';

const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

// A stub proof: it reports when it starts and finishes so the test can watch
// how many are in flight, which is the number the issue measured.
function tracker(durationMs = 20) {
  const state = { active: 0, peak: 0, started: 0 };
  return {
    state,
    work: async () => {
      state.active += 1;
      state.started += 1;
      state.peak = Math.max(state.peak, state.active);
      await sleep(durationMs);
      state.active -= 1;
      return 'proved';
    },
  };
}

describe('the ceiling', () => {
  it('never runs more proofs at once than it was given', async () => {
    const limiter = createProofLimiter({ limit: 4, queueLimit: 1_000, timeoutMs: 10_000 });
    const { state, work } = tracker();

    const results = await Promise.all(Array.from({ length: 250 }, () => limiter.run(work)));

    expect(state.peak).toBe(4);
    expect(limiter.peak).toBe(4);
    expect(state.started).toBe(250);
    expect(results.every((r) => r.ok && r.value === 'proved')).toBe(true);
  }, 60_000);

  it('runs them, rather than serialising everything', async () => {
    const limiter = createProofLimiter({ limit: 8, queueLimit: 1_000, timeoutMs: 10_000 });
    const { state, work } = tracker(30);

    const started = Date.now();
    await Promise.all(Array.from({ length: 16 }, () => limiter.run(work)));
    const elapsed = Date.now() - started;

    expect(state.peak).toBe(8);
    // Two batches of eight, not sixteen in a row.
    expect(elapsed).toBeLessThan(16 * 30);
  }, 60_000);

  it('defaults the ceiling to what the environment can actually run', () => {
    const limiter = createProofLimiter();
    expect(limiter.limit).toBe(defaultConcurrency());
    expect(limiter.limit).toBeGreaterThanOrEqual(1);
  });
});

describe('the waiting room', () => {
  it('refuses what it cannot hold rather than queueing it silently', async () => {
    const limiter = createProofLimiter({ limit: 2, queueLimit: 2, timeoutMs: 10_000 });
    const { state, work } = tracker(50);

    // Two run, two wait, the rest are refused.
    const outcomes = await Promise.all(Array.from({ length: 10 }, () => limiter.run(work)));
    const shed = outcomes.filter((o) => !o.ok && o.reason === 'shed');
    const done = outcomes.filter((o) => o.ok);

    expect(state.peak).toBe(2);
    expect(done).toHaveLength(4);
    expect(shed).toHaveLength(6);
  }, 60_000);

  it('lets the queue drain and accepts again afterwards', async () => {
    const limiter = createProofLimiter({ limit: 1, queueLimit: 1, timeoutMs: 10_000 });
    const { work } = tracker(20);

    const first = await Promise.all([limiter.run(work), limiter.run(work), limiter.run(work)]);
    expect(first.filter((o) => o.ok)).toHaveLength(2);
    expect(first.filter((o) => !o.ok && o.reason === 'shed')).toHaveLength(1);

    // Nothing is left holding a slot.
    expect(limiter.active).toBe(0);
    expect(limiter.queued).toBe(0);
    const later = await limiter.run(work);
    expect(later.ok).toBe(true);
  }, 60_000);
});

describe('the time bound', () => {
  it('answers the caller at the deadline, and holds the slot until the work stops', async () => {
    const limiter = createProofLimiter({ limit: 1, queueLimit: 1, timeoutMs: 60 });
    let settled = false;
    const forever = () => new Promise((done) => setTimeout(() => { settled = true; done('late'); }, 300));

    const outcome = await limiter.run(forever);
    expect(outcome.ok).toBe(false);
    expect(outcome.reason).toBe('timeout');
    expect(String(outcome.error.message)).toContain('timed out');

    // The caller has been answered and the proof is still running, so the slot
    // is still taken. snarkjs accepts no abort signal: the work goes on holding
    // its read of the proving key whatever the caller was told, and a ceiling
    // that let go here would stop bounding the thing it exists to bound.
    expect(settled).toBe(false);
    expect(limiter.active).toBe(1);

    await sleep(400);
    expect(settled).toBe(true);
    expect(limiter.active).toBe(0);
    const next = await limiter.run(async () => 'proved');
    expect(next).toEqual({ ok: true, value: 'proved' });
  }, 60_000);

  it('keeps bounding the work when every proof outruns the deadline', async () => {
    // The failure this exists for, measured in the review of square#236: with
    // the slot released at the deadline rather than at the work's own end, a
    // steady arrival of proofs that each outrun the bound admitted a new one on
    // top of every one still running -- limiter.peak stayed at the ceiling
    // while the real number of proofs inside snarkjs reached 60 against a
    // ceiling of 2. Timeouts fire when the machine is already too slow, which
    // is exactly when the memory bound matters most.
    const limiter = createProofLimiter({ limit: 2, queueLimit: 1_000, timeoutMs: 40 });
    const { state, work } = tracker(400);

    const outcomes = await Promise.all(Array.from({ length: 12 }, () => limiter.run(work)));

    expect(outcomes.every((o) => !o.ok && o.reason === 'timeout')).toBe(true);
    // Not limiter.peak, which counts slots: this counts work bodies actually
    // running, which is what holds the memory.
    expect(state.peak).toBe(2);

    // Only the two that were admitted ever started. The other ten were still
    // in the queue when their own deadline passed, and a deadline that runs
    // from arrival answers them there rather than starting a proof nobody is
    // waiting for any more. `started` is the difference between a bound per
    // request and a bound per slot.
    expect(state.started).toBe(2);
    expect(outcomes.filter((o) => o.started === false)).toHaveLength(10);
    expect(outcomes.filter((o) => o.started === true)).toHaveLength(2);

    // The two that did start are still proving when their callers are answered.
    await sleep(500);
    expect(limiter.active).toBe(0);
    expect(limiter.queued).toBe(0);
  }, 60_000);

  it('does not read a failure that merely says "timed out" as its own deadline', async () => {
    // `zkey read timed out` and `ETIMEDOUT` are this service's own failures and
    // belong in the 500 the caller should not retry, not in the 504 that means
    // "we ran out of time, try a less loaded service". The deadline is the
    // limiter's own, so it is recognised by identity rather than by wording.
    const limiter = createProofLimiter({ limit: 1, queueLimit: 1, timeoutMs: 5_000 });

    const outcome = await limiter
      .run(async () => { throw new Error('ETIMEDOUT: reading the proving key timed out'); })
      .then((value) => ({ value }), (error) => ({ error }));

    expect(outcome.error).toBeInstanceOf(Error);
    expect(String(outcome.error.message)).toContain('ETIMEDOUT');
    expect(limiter.active).toBe(0);
  }, 60_000);

  it('does not take the process down when the abandoned work fails later', async () => {
    const limiter = createProofLimiter({ limit: 1, queueLimit: 1, timeoutMs: 40 });
    const rejectsLate = () => new Promise((_, reject) => {
      setTimeout(() => reject(new Error('snarkjs gave up')), 120);
    });

    const outcome = await limiter.run(rejectsLate);
    expect(outcome.reason).toBe('timeout');

    // An unhandled rejection here would kill the service; wait past the point
    // where the abandoned work settles and assert the process is still fine.
    await sleep(200);
    expect(limiter.active).toBe(0);
  }, 60_000);

  it('leaves a proof that finishes in time alone', async () => {
    const limiter = createProofLimiter({ limit: 1, queueLimit: 1, timeoutMs: 5_000 });
    const outcome = await limiter.run(async () => { await sleep(20); return 'proved'; });
    expect(outcome).toEqual({ ok: true, value: 'proved' });
  }, 60_000);
});
