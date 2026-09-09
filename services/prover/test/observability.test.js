import { describe, expect, it } from 'vitest';
import request from 'supertest';
import { app } from '../src/index.js';

describe('observability endpoints', () => {
  it('serves health with the artifact check, and the check is critical', async () => {
    const response = await request(app).get('/health');
    expect([200, 503]).toContain(response.status);
    expect(response.body.service).toBe('square-prover');
    expect(response.body.checks.artifacts).toBeDefined();
    expect(response.body.checks.artifacts.critical).toBe(true);
    expect(response.status).toBe(response.body.checks.artifacts.ok ? 200 : 503);
    expect(response.body.status).toBe(response.body.checks.artifacts.ok ? 'healthy' : 'unhealthy');
  });

  it('serves Prometheus metrics with the proof signals', async () => {
    const response = await request(app).get('/metrics');
    expect(response.status).toBe(200);
    expect(response.headers['content-type']).toContain('text/plain');
    expect(response.text).toContain('square_proof_duration_seconds');
    expect(response.text).toContain('square_proof_failures_total');
  });

  it('serves version', async () => {
    const response = await request(app).get('/version');
    expect(response.status).toBe(200);
    expect(response.body.service).toBe('square-prover');
    expect(response.body.version).toBe('0.1.0');
  });

  it('counts a failed proof', async () => {
    await request(app).post('/prove').send({});
    const response = await request(app).get('/metrics');
    expect(response.text).toMatch(/square_proof_failures_total\{[^}]*\} [1-9]/);
  });
});
