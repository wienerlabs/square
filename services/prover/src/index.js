import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import { generateProof } from './prover.js';
import { logEntriesForProof, proofFailedLogEntry } from './logging.js';
import { openapiSpec } from './openapi.js';

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

app.get('/health', (_req, res) => {
  res.json({
    status: 'healthy',
    service: 'mandate-prover',
    version: '0.1.0',
    backend: 'circom+snarkjs',
  });
});

app.post('/prove', async (req, res) => {
  const start = Date.now();
  try {
    const result = await generateProof(req.body);
    const elapsedMs = Date.now() - start;

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
      groth16: result.groth16,
      raw_proof: result.raw_proof,
      raw_public: result.raw_public,
      proof_hash: result.proof_hash,
      verification_timestamp: result.verification_timestamp,
      receipt_bytes: result.receipt_bytes,
      proving_time_ms: elapsedMs,
    });
  } catch (error) {
    const entry = proofFailedLogEntry(error);
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
    console.log(`[mandate prover] listening on ${port}`);
  });
}
