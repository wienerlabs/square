import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import { generateProof, validateRequest } from './prover.js';
import { logEntriesForProof, proofFailedLogEntry, requestRejectedLogEntry } from './logging.js';
import { openapiSpec } from './openapi.js';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { createHealth, createMetrics, mountObservability } from '@squaresdk/observability';

const app = express();
const port = Number(process.env.PROVER_SERVICE_PORT ?? 3003);

const extraOrigins = (process.env.CORS_ORIGINS ?? '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

app.use(helmet());
app.use(
  cors({
    origin: [/^http:\/\/localhost:\d+$/, ...extraOrigins],
    methods: ['GET', 'POST'],
  }),
);
app.use(express.json({ limit: '256kb' }));

app.get('/api-docs.json', (_req, res) => {
  res.json(openapiSpec);
});

const artifactsDir = process.env.PROVER_ARTIFACTS_DIR
  ? path.resolve(process.env.PROVER_ARTIFACTS_DIR)
  : path.resolve('artifacts');
const metrics = createMetrics({ service: 'square-prover' });
const health = createHealth({
  service: 'square-prover',
  version: '0.1.0',
  checks: {
    artifacts: {
      check: () => {
        const present = existsSync(path.join(artifactsDir, 'payment.wasm')) && existsSync(path.join(artifactsDir, 'payment.zkey'));
        return { ok: present, detail: present ? 'payment.wasm and payment.zkey present' : `no circuit artifacts under ${artifactsDir}` };
      },
      critical: true,
    },
  },
});
mountObservability(app, { health, metrics });

app.post('/prove', async (req, res) => {
  // The request is checked before anything else happens, and a request the
  // caller got wrong is answered 400 rather than 500.
  //
  // square#148 asked for this for the hour range, and the reason generalises to
  // everything validateRequest checks: a 500 tells a caller the service broke,
  // so a client retries it, an operator reads it as an incident, and a monitor
  // counts it against the service. None of that is true of a policy with an
  // hour of 25 in it. Errors raised later -- inside hashing, witness generation
  // or snarkjs -- are still 500, because that is where this service's own
  // failures live.
  //
  // The proof metrics are untouched on this path: nothing was proved, and
  // counting a refused policy as a proof failure would be the same conflation
  // in a different place.
  try {
    validateRequest(req.body);
  } catch (error) {
    const entry = requestRejectedLogEntry(error);
    console.error(JSON.stringify(entry));
    res.status(400).json({ error: entry.error });
    return;
  }

  const start = Date.now();
  const timer = metrics.startProof();
  try {
    const result = await generateProof(req.body);
    const elapsedMs = Date.now() - start;
    timer.success();

    // Which entries to write is decided in logging.js, not here. On the
    // violation path that decision is the whole point of #4: the ceilings, the
    // lists and the category are exactly what the circuit exists to hide, and a
    // log file is not a privileged place. Keeping the decision in one pure
    // function is what lets the tests assert that no request field can reach a
    // log line.
    for (const entry of logEntriesForProof({ result, elapsedMs })) {
      const line = JSON.stringify(entry);
      if (entry.event === 'proof_generated') console.log(line);
      else console.error(line);
    }

    res.json({
      is_compliant: result.is_compliant,
      // Returned so an operator can see why their payment was rejected. This
      // is the legitimate channel the leaked log line was standing in for: the
      // caller supplied the policy these names refer to, so a name tells them
      // nothing they did not already know.
      violated_rules: result.rules_agree ? result.violated_rules : null,
      policy_data_hash: result.policy_data_hash,
      policy_data_hash_hex: result.policy_data_hash_hex,
      public_signals: result.public_signals,
      solidity: result.solidity,
      raw_proof: result.raw_proof,
      raw_public: result.raw_public,
      verification_timestamp: result.verification_timestamp,
      proving_time_ms: elapsedMs,
    });
  } catch (error) {
    const entry = proofFailedLogEntry(error);
    timer.failure(entry.error);
    console.error(JSON.stringify(entry));
    res.status(500).json({ error: entry.error });
  }
});

// Exported for the tests, which drive the route through supertest rather than
// binding a port.
export { app };

// Only listen when run as a process, not when imported by a test.
if (process.env.NODE_ENV !== 'test') {
  app.listen(port, '0.0.0.0', () => {
    console.log(`[square prover] listening on ${port}`);
  });
}
