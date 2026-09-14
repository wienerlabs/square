import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import { ARTIFACT_PATHS, generateProof, validateRequest } from './prover.js';
import { logEntriesForProof, proofFailedLogEntry, requestFailedLogEntry, requestRejectedLogEntry } from './logging.js';
import { openapiSpec } from './openapi.js';
import { accessSync, constants } from 'node:fs';
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
// One value, so the limit and the message that reports it cannot disagree.
const BODY_LIMIT = '256kb';
app.use(express.json({ limit: BODY_LIMIT }));

app.get('/api-docs.json', (_req, res) => {
  res.json(openapiSpec);
});

const metrics = createMetrics({ service: 'square-prover' });
const health = createHealth({
  service: 'square-prover',
  version: '0.1.0',
  checks: {
    artifacts: {
      // The paths the prover opens, not a second derivation of them.
      //
      // square#235: this used to resolve `artifacts` against the working
      // directory while prover.js resolved it against the module, so a service
      // started from anywhere else answered for one directory and proved from
      // another — healthy with every request failing, or unhealthy while
      // proving fine.
      //
      // Readable, not merely present: the Dockerfile says this check is what
      // turns an empty or unmounted /artifacts into an unhealthy container, and
      // a volume mounted with the wrong ownership is the same failure with the
      // files in place.
      check: () => {
        for (const file of [ARTIFACT_PATHS.wasm, ARTIFACT_PATHS.zkey]) {
          try {
            accessSync(file, constants.R_OK);
          } catch (error) {
            return { ok: false, detail: `cannot read ${file}: ${error.code ?? error.message}` };
          }
        }
        return { ok: true, detail: `payment.wasm and payment.zkey readable under ${ARTIFACT_PATHS.dir}` };
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

// A body the service could not read, answered the way every other refusal is.
//
// square#252. With no four-argument handler, what express.json raises -- a body
// that is not JSON, one over the limit, a charset it will not decode -- went to
// Express's default handler: an HTML page, with the stack trace in development,
// and `<pre>Bad Request</pre>` in production with the stack written to stderr as
// bare lines. The OpenAPI spec promises JSON on the error path, the log pipeline
// reads one JSON object per line, and the stack carried the first bytes of the raw
// body, because body-parser's SyntaxError quotes them ("max_daily_"... is not
// valid JSON).
//
// So the status body-parser chose is kept, the message is picked here by the kind
// of error rather than read off it, and the log line has the shape of every other
// one. No part of the request reaches either.
const UNREADABLE_BODY = Object.freeze({
  'entity.parse.failed': 'the request body is not valid JSON',
  'entity.too.large': `the request body is larger than the ${BODY_LIMIT} this service accepts`,
  'request.aborted': 'the request body ended before it was complete',
  'request.size.invalid': 'the request body is not the length its Content-Length declares',
  'charset.unsupported': 'the request body is in a charset this service does not read',
  'encoding.unsupported': 'the request body uses a content encoding this service does not read',
});

app.use((error, _req, res, _next) => {
  const declared = Number(error?.status ?? error?.statusCode);
  const status = Number.isInteger(declared) && declared >= 400 && declared < 600 ? declared : 500;
  if (status < 500) {
    const entry = requestRejectedLogEntry(UNREADABLE_BODY[error?.type] ?? 'the request could not be read');
    console.error(JSON.stringify(entry));
    res.status(status).json({ error: entry.error });
    return;
  }
  // Not the caller's mistake, and not a proof that failed: the route catches its
  // own. Named as neither, and still without anything the error carried.
  const entry = requestFailedLogEntry('the request could not be handled');
  console.error(JSON.stringify(entry));
  res.status(500).json({ error: entry.error });
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
