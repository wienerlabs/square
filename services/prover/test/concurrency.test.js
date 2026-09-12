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
  it('gives up on a proof that outruns it, and frees the slot', async () => {
    const limiter = createProofLimiter({ limit: 1, queueLimit: 1, timeoutMs: 60 });
    let settled = false;
    const forever = () => new Promise((done) => setTimeout(() => { settled = true; done('late'); }, 5_000));

    const outcome = await limiter.run(forever);
    expect(outcome.ok).toBe(false);
    expect(outcome.reason).toBe('timeout');
    expect(String(outcome.error.message)).toContain('timed out');

    // The slot is back immediately, which is the point: the next caller does
    // not wait for work nobody is listening to any more.
    expect(limiter.active).toBe(0);
    expect(settled).toBe(false);
    const next = await limiter.run(async () => 'proved');
    expect(next).toEqual({ ok: true, value: 'proved' });
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
