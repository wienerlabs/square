/**
 * did:aip driver for the DIF Universal Resolver.
 *
 *   GET /1.0/identifiers/{did}  → 200 application/did+ld+json, or a mapped error
 *   GET /health                 → 200 { status, chains }
 *
 * All resolution lives in @mandate/did-resolver; this is a thin HTTP shell.
 */
import { createApp } from "./app.js";
import { readConfig } from "./config.js";

let config;
try {
  config = readConfig();
} catch (err) {
  // Fail at boot rather than answering every request with 501. A driver with no
  // chains configured is misconfigured, and a container that starts anyway hides
  // that until someone tries to resolve something.
  console.error(`[did:aip-driver] ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
}

createApp(config).listen(config.port, () => {
  console.log(
    `[did:aip-driver] listening on :${config.port} — chains ${Object.keys(config.rpc).join(", ")}`
  );
});
