// Every status this service answers is one openapi.js declares, with the body it
// declares.
//
// square#254 measured the drift against the running service. /health answered
// 503 and the spec declared only 200. Health declared a `backend` no response
// carried and left out `checks` and `uptimeSeconds`. /metrics and /version were
// served and absent from `paths`. And a missing proving key came back as a 500
// whose body was the filesystem's error, with the file's absolute path in it,
// under a description that promised a field name and never a value.
//
// Nothing here is stubbed. The service is loaded twice, over an empty artifact
// directory and over one holding two readable files, the way observability.test.js
// loads it; everything else is real requests. The 200 and the 503 that POST /prove
// only gives with a real proof in flight are held to the same declaration in
// prove-route.e2e.test.js and prove-backpressure.e2e.test.js.

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import { openapiSpec } from '../src/openapi.js';
import { expectDeclared, schemaProblems } from './openapi-declared.js';

const VALID = Object.freeze({
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

async function serviceOver(artifactsDir) {
  vi.stubEnv('PROVER_ARTIFACTS_DIR', artifactsDir);
  vi.resetModules();
  return (await import('../src/index.js')).app;
}

function unloadService() {
  vi.unstubAllEnvs();
  vi.resetModules();
}

// What the service wrote to stderr while `send` ran, so a log line can be held
// to the same rule as the body.
async function capturing(send) {
  const lines = [];
  const original = console.error;
  console.error = (...args) => { lines.push(args.join(' ')); };
  try {
    return { response: await send(), lines };
  } finally {
    console.error = original;
  }
}

describe('a service whose circuit artifacts are missing', () => {
  let dir;
  let app;

  beforeAll(async () => {
    dir = mkdtempSync(path.join(os.tmpdir(), 'square-prover-openapi-missing-'));
    app = await serviceOver(dir);
  });

  afterAll(() => {
    unloadService();
    rmSync(dir, { recursive: true, force: true });
  });

  it('answers GET /health with a declared 503, in the body Health declares', async () => {
    const response = await request(app).get('/health');
    expect(response.status).toBe(503);
    const schema = expectDeclared('GET', '/health', response);
    expect(schemaProblems(response.body, schema)).toEqual([]);
    expect(response.body.status).toBe('unhealthy');
  });

  it('declares no Health field the body does not carry', async () => {
    const response = await request(app).get('/health');
    for (const field of Object.keys(openapiSpec.components.schemas.Health.properties)) {
      expect(response.body, `Health declares ${field}`).toHaveProperty(field);
    }
  });

  it('declares /metrics and /version, and what they answer', async () => {
    const metrics = await request(app).get('/metrics');
    expect(metrics.status).toBe(200);
    expectDeclared('GET', '/metrics', metrics);

    const version = await request(app).get('/version');
    expect(version.status).toBe(200);
    expect(schemaProblems(version.body, expectDeclared('GET', '/version', version))).toEqual([]);
  });

  it('answers each refusal of POST /prove with a declared status', async () => {
    const { response: missingFields } = await capturing(() => request(app).post('/prove').send({}));
    expect(missingFields.status).toBe(400);
    expectDeclared('POST', '/prove', missingFields);

    const { response: tooLarge } = await capturing(() => request(app)
      .post('/prove')
      .set('Content-Type', 'application/json')
      .send(JSON.stringify({ padding: 'x'.repeat(300 * 1024) })));
    expect(tooLarge.status).toBe(413);
    expectDeclared('POST', '/prove', tooLarge);

    const { response: charset } = await capturing(() => request(app)
      .post('/prove')
      .set('Content-Type', 'application/json; charset=latin1')
      .send('{}'));
    expect(charset.status).toBe(415);
    expectDeclared('POST', '/prove', charset);
  });

  it('answers a proof it cannot open its key for with a declared 500 that names no path', async () => {
    const { response, lines } = await capturing(() => request(app).post('/prove').send(VALID));
    expect(response.status).toBe(500);
    expect(schemaProblems(response.body, expectDeclared('POST', '/prove', response))).toEqual([]);
    expect(response.body).toEqual({ error: 'circuit artifacts are not available' });

    const everything = `${response.text}\n${lines.join('\n')}`;
    for (const leak of [dir, os.tmpdir(), 'payment.wasm', 'payment.zkey', 'ENOENT', 'no such file']) {
      expect(everything, `leaked ${leak}`).not.toContain(leak);
    }
    expect(lines.map((line) => JSON.parse(line))).toEqual([
      { event: 'proof_failed', error: 'circuit artifacts are not available' },
    ]);
  });

  it('still counts that proof under artifacts_missing', async () => {
    const reason = async () => {
      const text = (await request(app).get('/metrics')).text;
      const match = /square_proof_failures_total\{[^}]*reason="artifacts_missing"[^}]*\} (\d+)/.exec(text);
      return match ? Number(match[1]) : 0;
    };
    const before = await reason();
    await capturing(() => request(app).post('/prove').send(VALID));
    expect(await reason()).toBe(before + 1);
  });
});

describe('a service whose circuit artifacts are readable', () => {
  let dir;
  let app;

  beforeAll(async () => {
    // The health check asks whether the two files can be read, not what is in
    // them, so two readable files are a healthy service as far as it can tell.
    dir = mkdtempSync(path.join(os.tmpdir(), 'square-prover-openapi-readable-'));
    writeFileSync(path.join(dir, 'payment.wasm'), 'readable');
    writeFileSync(path.join(dir, 'payment.zkey'), 'readable');
    app = await serviceOver(dir);
  });

  afterAll(() => {
    unloadService();
    rmSync(dir, { recursive: true, force: true });
  });

  it('answers GET /health with a declared 200, in the body Health declares', async () => {
    const response = await request(app).get('/health');
    expect(response.status).toBe(200);
    expect(schemaProblems(response.body, expectDeclared('GET', '/health', response))).toEqual([]);
    expect(response.body.status).toBe('healthy');
  });
});
