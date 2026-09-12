// /health and the prover have to be talking about the same files.
//
// square#235. The directory was derived twice: `prover.js` resolved the
// fallback against the module, `index.js` against the working directory. With
// PROVER_ARTIFACTS_DIR set they agreed; without it they agreed only when the
// process happened to be started from services/prover. Measured, both ways
// round, before the fix:
//
//   artifacts in the working directory, none beside the module
//     GET  /health -> 200 healthy
//     POST /prove  -> 500 ENOENT .../services/prover/artifacts/payment.wasm
//
//   artifacts beside the module, none in the working directory
//     GET  /health -> 503 unhealthy
//     POST /prove  -> 200, a real proof
//
// The first is a container that passes its probe and fails every request; the
// second never satisfies `depends_on: {condition: service_healthy}`.
//
// The service is started as a child process from a different working directory,
// which is the condition under test and cannot be reproduced by importing the
// app into this file.

import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { ARTIFACT_PATHS } from '../src/prover.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const ENTRY = path.join(ROOT, 'src', 'index.js');

const REQUEST = Object.freeze({
  policy_id: '3f2504e0-4f89-11d3-9a0c-0305e82c3301',
  policy_salt: '7777777777777777777777777777777777777777777777777777777777777',
  operator_id: '0x3333333333333333333333333333333333333333',
  max_daily_spend: '100000000',
  max_per_transaction: '10000000',
  allowed_endpoint_categories: ['api-call'],
  blocked_addresses: ['0x2222222222222222222222222222222222222222'],
  token_whitelist: ['0x3600000000000000000000000000000000000000'],
  payment_token: '0x3600000000000000000000000000000000000000',
  payment_recipient: '0x1111111111111111111111111111111111111111',
  payment_amount: '5000000',
  daily_spent_before: '50000000',
  payment_endpoint_category: 'api-call',
  current_unix_timestamp: '1788356730',
});

let nextPort = 3971;

async function withService({ cwd, env = {} }, body) {
  const port = nextPort;
  nextPort += 1;
  const child = spawn(process.execPath, [ENTRY], {
    cwd,
    env: {
      ...process.env,
      // src/index.js listens only when it is run as a process, and vitest sets
      // NODE_ENV=test in ours — which the child would inherit and then never
      // bind a port. What is under test here is a service started from a
      // different working directory, so it has to be a real one.
      NODE_ENV: 'production',
      ...env,
      PROVER_SERVICE_PORT: String(port),
    },
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  let stderr = '';
  child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
  const base = `http://127.0.0.1:${port}`;
  try {
    const deadline = Date.now() + 30_000;
    for (;;) {
      if (Date.now() > deadline) throw new Error(`the service did not answer on ${port}\n${stderr}`);
      try {
        const probe = await fetch(`${base}/health`, { signal: AbortSignal.timeout(1_000) });
        if (probe.status === 200 || probe.status === 503) break;
      } catch {
        // not listening yet
      }
    }
    const health = await fetch(`${base}/health`);
    const healthBody = await health.json();
    const prove = await fetch(`${base}/prove`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body ?? REQUEST),
    });
    const proveBody = await prove.json().catch(() => ({}));
    return { health: { status: health.status, body: healthBody }, prove: { status: prove.status, body: proveBody } };
  } finally {
    child.kill('SIGTERM');
  }
}

// A working directory with its own artifacts/, which is the decoy: before the
// fix the health check looked here and the prover did not.
function decoyWorkingDirectory() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'square-prover-cwd-'));
  fs.mkdirSync(path.join(dir, 'artifacts'));
  fs.writeFileSync(path.join(dir, 'artifacts', 'payment.wasm'), 'not a wasm');
  fs.writeFileSync(path.join(dir, 'artifacts', 'payment.zkey'), 'not a key');
  return dir;
}

describe('the artifact directory has one derivation', () => {
  it('is the one the prover opens, whatever the working directory is', async () => {
    const cwd = decoyWorkingDirectory();
    try {
      const { health } = await withService({ cwd });
      const detail = String(health.body.checks.artifacts.detail);
      // Whichever way the check answers, it has to be answering about the
      // prover's directory and not about the decoy beside the process.
      expect(detail).toContain(ARTIFACT_PATHS.dir);
      expect(detail).not.toContain(path.join(cwd, 'artifacts'));
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  }, 60_000);

  it('makes /health and /prove say the same thing', async () => {
    const cwd = decoyWorkingDirectory();
    try {
      const { health, prove } = await withService({ cwd });
      const missing = prove.status === 500 && /ENOENT/.test(JSON.stringify(prove.body));
      // The claim is the agreement, not a particular outcome: a runner with the
      // artifacts in place is healthy and proves, one without them is unhealthy
      // and cannot. Before the fix this pair was 200 and 500.
      expect(health.status === 200).toBe(!missing);
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  }, 120_000);
});

describe('an artifact that is present but not readable', () => {
  it('is reported as unhealthy', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'square-prover-unreadable-'));
    try {
      const wasm = path.join(dir, 'payment.wasm');
      const zkey = path.join(dir, 'payment.zkey');
      fs.writeFileSync(wasm, 'artifact');
      fs.writeFileSync(zkey, 'artifact');
      fs.chmodSync(wasm, 0o000);

      // Root reads a mode-000 file regardless, so there is nothing to assert.
      let unreadable = true;
      try {
        fs.accessSync(wasm, fs.constants.R_OK);
        unreadable = false;
      } catch {
        unreadable = true;
      }
      if (!unreadable) return;

      const { health } = await withService({ cwd: ROOT, env: { PROVER_ARTIFACTS_DIR: dir } });
      expect(health.status).toBe(503);
      expect(health.body.checks.artifacts.ok).toBe(false);
      expect(String(health.body.checks.artifacts.detail)).toContain('cannot read');
      expect(String(health.body.checks.artifacts.detail)).toContain('EACCES');
    } finally {
      fs.chmodSync(path.join(dir, 'payment.wasm'), 0o600);
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }, 60_000);
});
