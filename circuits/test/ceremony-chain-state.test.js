// The chain on disk and the transcript are two states, and the tool now refuses
// to move when they disagree.
//
// square#234. `snarkjs zkey contribute` is irreversible and prints the
// contributor their hash before this script records anything: the order was
// contribute, inspect, write. An interruption in between — a failing inspect, a
// Ctrl-C, a full disk — left `payment_NNNN.zkey` on disk with no entry in the
// transcript, and the transcript was the only thing consulted about where the
// chain ended. Re-running `contribute` overwrote that contributor's work from
// the previous key; running `beacon` sealed the chain one link short. Either
// way `verify-chain` then reported a key and a transcript agreeing with each
// other, while the hash that contributor had already published appeared in no
// artefact at all.
//
// The scripts are copied into a sandbox, as entrypoint.test.js does, so these
// run against their own `build/ceremony` and can never touch a real one.

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { ADOPTED, ptauPath } from '../scripts/fetch-ptau.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const R1CS = path.join(ROOT, 'build', 'payment.r1cs');
const ZKEY = path.join(ROOT, 'build', 'payment.zkey');

const HAVE_CIRCUIT = fs.existsSync(R1CS) && fs.existsSync(ptauPath());
const HAVE_ZKEY = HAVE_CIRCUIT && fs.existsSync(ZKEY);

let sandbox;
let scripts;
let ceremony;

function run(args, options = {}) {
  try {
    const stdout = execFileSync('node', [path.join(scripts, 'ceremony.mjs'), ...args], {
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
      input: options.input ?? '',
      timeout: options.timeout ?? 120_000,
    });
    return { code: 0, stdout, stderr: '' };
  } catch (error) {
    return {
      code: error.status ?? 1,
      stdout: error.stdout ?? '',
      stderr: error.stderr ?? String(error),
    };
  }
}

const transcriptPath = () => path.join(ceremony, 'transcript.json');
const readTranscript = () => JSON.parse(fs.readFileSync(transcriptPath(), 'utf8'));

// A transcript of the shape `init` writes, with `n` contributions already in it.
function writeTranscript(n) {
  const contributions = [];
  for (let i = 1; i <= n; i += 1) {
    contributions.push({
      index: i,
      name: `contributor ${i}`,
      recorded_name: `contributor ${i}`,
      transcript_hash: String(i).repeat(128),
      zkey_sha256: String(i).repeat(64),
      at: `2026-09-0${i}T00:00:00.000Z`,
    });
  }
  fs.mkdirSync(ceremony, { recursive: true });
  fs.writeFileSync(
    transcriptPath(),
    `${JSON.stringify({
      circuit: { file: 'payment.circom', r1cs_sha256: 'a'.repeat(64) },
      phase1: { ceremony: ADOPTED.ceremony, contribution: ADOPTED.contribution, file: ADOPTED.file },
      started_at: '2026-09-01T00:00:00.000Z',
      contributions,
      beacon: null,
      final: null,
    }, null, 2)}\n`,
  );
}

// Key files, by index. Their contents do not matter to the checks under test:
// every refusal here happens before snarkjs is invoked, which is the point —
// nothing irreversible runs on a directory the tool does not understand.
function writeKeys(...indices) {
  fs.mkdirSync(ceremony, { recursive: true });
  for (const i of indices) {
    fs.writeFileSync(path.join(ceremony, `payment_${String(i).padStart(4, '0')}.zkey`), 'not a real key');
  }
}

beforeAll(() => {
  sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'square-chain-state-'));
  scripts = path.join(sandbox, 'scripts');
  ceremony = path.join(sandbox, 'build', 'ceremony');
  fs.mkdirSync(scripts, { recursive: true });
  for (const file of fs.readdirSync(path.join(ROOT, 'scripts'))) {
    fs.copyFileSync(path.join(ROOT, 'scripts', file), path.join(scripts, file));
  }
  fs.symlinkSync(path.join(ROOT, 'node_modules'), path.join(sandbox, 'node_modules'), 'dir');
  fs.mkdirSync(path.join(sandbox, 'build'), { recursive: true });
});

afterAll(() => {
  if (sandbox) fs.rmSync(sandbox, { recursive: true, force: true });
});

beforeEach(() => {
  fs.rmSync(ceremony, { recursive: true, force: true });
  // The scripts too, not only the ceremony: one test below replaces the
  // inspector with a stub that fails on purpose, and every other test needs the
  // real one back.
  for (const file of fs.readdirSync(path.join(ROOT, 'scripts'))) {
    fs.copyFileSync(path.join(ROOT, 'scripts', file), path.join(scripts, file));
  }
});

describe('a chain that has moved further than the transcript', () => {
  it('stops `contribute` and names both ends', () => {
    writeTranscript(0);
    writeKeys(0, 1);

    const result = run(['contribute', 'Someone']);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain('disagree');
    expect(result.stderr).toContain('payment_0001.zkey');
    expect(result.stderr).toContain('overwrite their work');

    // And it stopped before snarkjs: the key it would have overwritten is
    // untouched, and nothing was recorded.
    expect(fs.readFileSync(path.join(ceremony, 'payment_0001.zkey'), 'utf8')).toBe('not a real key');
    expect(readTranscript().contributions).toHaveLength(0);
  });

  it('stops `beacon` before it reaches drand', () => {
    writeTranscript(1);
    writeKeys(0, 1, 2);

    const result = run(['beacon', '31968374']);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain('disagree');
    expect(result.stderr).toContain('payment_0002.zkey');
    // No final key, and the transcript still records no beacon.
    expect(fs.existsSync(path.join(ceremony, 'payment_final.zkey'))).toBe(false);
    expect(readTranscript().beacon).toBeNull();
  });
});

describe('a chain that is behind the transcript', () => {
  it('stops rather than starting over on top of it', () => {
    writeTranscript(2);
    writeKeys(0);

    const result = run(['contribute', 'Someone']);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain('disagree');
    expect(result.stderr).toContain('missing from disk');
  });

  it('says so plainly when there is no key at all', () => {
    writeTranscript(1);

    const result = run(['contribute', 'Someone']);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain('The chain is missing');
  });
});

// The failure the issue is about: the contribution is finished and the
// contributor has their hash, and the step that reads it back fails.
describe.skipIf(!HAVE_CIRCUIT)('a contribution whose read-back fails', () => {
  it('is recorded anyway, with the two fields it could not fill left empty', () => {
    fs.copyFileSync(R1CS, path.join(sandbox, 'build', 'payment.r1cs'));
    fs.copyFileSync(ptauPath(), path.join(sandbox, 'build', ADOPTED.file));
    // `init` records the circuit's provenance, which means reading the sources
    // themselves — the transcript identifies the circuit by what compiled and
    // what was compiled, not by the r1cs digest alone.
    fs.mkdirSync(path.join(sandbox, 'lib'), { recursive: true });
    fs.copyFileSync(path.join(ROOT, 'payment.circom'), path.join(sandbox, 'payment.circom'));
    fs.copyFileSync(path.join(ROOT, 'lib', 'timestamp.circom'), path.join(sandbox, 'lib', 'timestamp.circom'));

    const started = run(['init'], { timeout: 300_000 });
    expect(started.code, started.stderr).toBe(0);
    expect(fs.existsSync(path.join(ceremony, 'payment_0000.zkey'))).toBe(true);

    // Break the read-back, and only that. snarkjs still runs, so the
    // contribution is real and irreversible by the time this fails.
    fs.writeFileSync(
      path.join(scripts, 'inspect-zkey-setup.mjs'),
      'process.stderr.write("inspector unavailable\\n");\nprocess.exit(1);\n',
    );

    const contributed = run(['contribute', 'Alice'], { input: 'rehearsal entropy\n', timeout: 300_000 });
    expect(contributed.code).toBe(1);
    expect(contributed.stderr).toContain('the contribution is recorded');

    // The key exists and the transcript knows about it — which is the whole
    // claim. Before square#234 the transcript was written after the read-back,
    // so this contribution would have been absent and the next `contribute`
    // would have overwritten it.
    expect(fs.existsSync(path.join(ceremony, 'payment_0001.zkey'))).toBe(true);
    const [entry, ...rest] = readTranscript().contributions;
    expect(rest).toHaveLength(0);
    expect(entry.index).toBe(1);
    expect(entry.name).toBe('Alice');
    expect(entry.zkey_sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(entry.recorded_name).toBeNull();
    expect(entry.transcript_hash).toBeNull();
  }, 600_000);
});

describe.skipIf(HAVE_CIRCUIT)('a contribution whose read-back fails', () => {
  it('skipped: compile the circuit first (npm run build -- --no-zkey)', () => {
    expect(HAVE_CIRCUIT).toBe(false);
  });
});

// The final key cannot speak for the intermediate ones: a contribution that
// finished without being recorded leaves a payment_NNNN.zkey the transcript does
// not mention, and if the chain was then sealed one link short the final key and
// the transcript agree with each other while leaving that contributor out. So
// verify-chain reads the directory too.
describe.skipIf(!HAVE_ZKEY)('verify-chain, against the keys on disk', () => {
  const prepare = (contributions, keyIndices) => {
    writeTranscript(contributions);
    writeKeys(...keyIndices);
    fs.copyFileSync(R1CS, path.join(sandbox, 'build', 'payment.r1cs'));
    fs.copyFileSync(ptauPath(), path.join(sandbox, 'build', ADOPTED.file));
    // A real key, so the report the chain section reads is a real report.
    fs.copyFileSync(ZKEY, path.join(ceremony, 'payment_final.zkey'));
  };

  it('reports keys the transcript does not account for', () => {
    prepare(1, [0, 1, 2]);
    const result = run(['verify-chain'], { timeout: 300_000 });
    expect(result.stdout).toContain('the keys on disk end at payment_0002.zkey');
    expect(result.stdout).toContain('transcript records 1 contribution(s)');
    expect(result.code).toBe(1);
  }, 600_000);

  it('is quiet when the two ends agree', () => {
    prepare(1, [0, 1]);
    const result = run(['verify-chain'], { timeout: 300_000 });
    expect(result.stdout).toContain('the keys on disk end at payment_0001.zkey, where the transcript ends');
  }, 600_000);
});

describe.skipIf(HAVE_ZKEY)('verify-chain, against the keys on disk', () => {
  it('skipped: build the development key first (npm run build)', () => {
    expect(HAVE_ZKEY).toBe(false);
  });
});
