// Is this module the one node was asked to run?
//
// The two callers used to answer it inline, with the same line in both:
//
//   if (import.meta.url === `file://${process.argv[1]}`)
//
// which is wrong the same way in both, and square#150 measured what that costs.
// `import.meta.url` is a percent-encoded URL and `process.argv[1]` is a raw
// path, so the two stop matching the moment the path holds anything a URL has
// to encode. Measured with the real scripts:
//
//   plain          RUNS
//   with space     DOES NOT RUN   .../with%20space/probe.mjs   vs  .../with space/
//   Çalışma        DOES NOT RUN   .../%C3%87al%C4%B1%C5%9Fma/  vs  .../Çalışma/
//   Belgeler-ü     DOES NOT RUN
//   a#b            DOES NOT RUN
//
// The failure is silent, which is what makes it serious rather than annoying:
// the block never runs, nothing is printed, and the process exits 0. For
// `fetch-ptau.mjs --verify` and `ceremony.mjs verify-chain` — whose entire job
// is to answer a question with an exit code — that reads as "verified".
//
// Turkish directory names are not a hypothetical for this team, and square#16
// is a public ceremony: contributors run these commands on their own machines,
// under their own paths.
//
// One module rather than a corrected line in each file, because a line that was
// subtly wrong in two places is a line that should exist in one.

import { realpathSync } from 'node:fs';
import { basename } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

/**
 * @param {string} moduleUrl `import.meta.url` of the calling module.
 * @returns {boolean} true when node was asked to run that module directly.
 *
 * `pathToFileURL` puts both sides in the same encoding. `realpathSync` covers
 * the second failure, also measured: invoked through a symbolic link,
 * `process.argv[1]` is the link and `import.meta.url` is its target, so
 * encoding alone still says no.
 *
 *   direct           pathToFileURL RUNS   +realpath RUNS
 *   through a link   pathToFileURL NO     +realpath RUNS
 *
 * A path that cannot be resolved falls back to the unresolved one rather than
 * throwing: failing to answer this question must not be how a script dies.
 */
export function isMain(moduleUrl) {
  const invoked = process.argv[1];
  if (!invoked) return false;
  let resolved;
  try {
    resolved = realpathSync(invoked);
  } catch {
    resolved = invoked;
  }
  if (moduleUrl === pathToFileURL(resolved).href) return true;

  // Not main. Usually that is the truth -- the module was imported -- and the
  // caller carries on. But if node was asked to run a file with this module's
  // own name and the two still disagree, the comparison is wrong again in some
  // way this code has not thought of, and the caller is about to do what
  // square#150 found: print nothing and exit 0.
  //
  // For `fetch-ptau.mjs --verify` and `ceremony.mjs verify-chain`, whose whole
  // output is an exit code, an auditor reads that as "verified". So it stops
  // here, loudly, rather than answering a question it never asked.
  if (basename(resolved) === basename(fileURLToPath(moduleUrl))) {
    process.stderr.write(
      `error: ${basename(resolved)} was invoked directly but did not recognise itself as the entry point.\n`
      + `  argv[1]         ${resolved}\n`
      + `  import.meta.url ${moduleUrl}\n`
      + '  Refusing to exit 0 without doing the work that was asked for.\n',
    );
    process.exit(1);
  }
  return false;
}
