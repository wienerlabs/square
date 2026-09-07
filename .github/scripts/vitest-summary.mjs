#!/usr/bin/env node
// Turn a vitest JSON report into a line on the run summary.
//
// The number that matters is not "green" but "how many tests actually ran".
// Several suites in this repository are guarded by skipIf(): the circuit tests
// skip without compiled artifacts, the prover's end-to-end tests skip without a
// proving key. Those guards are correct locally and dangerous in CI, so every
// skip is named here rather than folded into a count nobody reads.
//
//   node .github/scripts/vitest-summary.mjs <report.json> <heading>

import fs from 'node:fs';

const [reportPath, heading = 'tests'] = process.argv.slice(2);

if (!reportPath || !fs.existsSync(reportPath)) {
  const line = `### ${heading}\n\nNo vitest report at ${reportPath} — the run did not get far enough to write one.\n`;
  if (process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, line);
  process.stdout.write(line);
  process.exit(0);
}

const report = JSON.parse(fs.readFileSync(reportPath, 'utf8'));

const skipped = report.testResults.flatMap((file) =>
  file.assertionResults
    .filter((t) => t.status === 'skipped' || t.status === 'pending')
    .map((t) => t.fullName));

const lines = [
  `### ${heading}`,
  '',
  `**${report.numPassedTests} passed**, ${report.numFailedTests} failed, `
  + `${report.numPendingTests} skipped, of ${report.numTotalTests} in `
  + `${report.numTotalTestSuites} suites.`,
  '',
];

if (skipped.length) {
  lines.push('Skipped:', '');
  for (const name of skipped) lines.push(`- ${name}`);
  lines.push('');
}

const out = `${lines.join('\n')}\n`;
if (process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, out);
process.stdout.write(out);
