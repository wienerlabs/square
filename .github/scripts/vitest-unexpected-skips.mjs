#!/usr/bin/env node
// Fail when a vitest run skipped a test it was there to run.
//
// square#259. vitest-summary.mjs names every skip and never fails, on purpose:
// it is visibility, and it sits under `if: always()`. That left the proving job
// green however many of its guarded tests had skipped, and the documents kept a
// hand count of the tests it runs in their place -- "five", while there were
// seven and then eleven -- which nothing checked.
//
// In a job whose preconditions are asserted before the tests run, the only tests
// allowed to skip are the inverse placeholders: the `it('skipped: …')` each
// guarded suite keeps beside itself, which runs only when its artifact is absent.
// Anything else that skipped is a guarded test that did not run. This lists them
// on the run summary and exits 1.
//
//   node .github/scripts/vitest-unexpected-skips.mjs <report.json> <heading>

import fs from 'node:fs';

const [reportPath, heading = 'tests'] = process.argv.slice(2);

function write(text) {
  if (process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, text);
  process.stdout.write(text);
}

if (!reportPath || !fs.existsSync(reportPath)) {
  write(`### ${heading}: skips\n\nNo vitest report at ${reportPath}, so nothing can be said about what ran.\n`);
  process.exit(1);
}

const report = JSON.parse(fs.readFileSync(reportPath, 'utf8'));
const PLACEHOLDER = /^skipped: /;
const SKIPPED = new Set(['skipped', 'pending', 'todo']);

const skipped = report.testResults.flatMap((file) => file.assertionResults
  .filter((t) => SKIPPED.has(t.status))
  .map((t) => ({ name: t.fullName, title: t.title })));
const placeholders = skipped.filter((t) => PLACEHOLDER.test(t.title));
const unexpected = skipped.filter((t) => !PLACEHOLDER.test(t.title));

const lines = [`### ${heading}: skips`, ''];
lines.push(
  `${report.numPassedTests} passed. ${placeholders.length} placeholder(s) skipped, as they should `
  + 'when the artifact they stand in for is present:',
  '',
);
for (const t of placeholders) lines.push(`- ${t.name}`);
lines.push('');
if (unexpected.length > 0) {
  lines.push(`**${unexpected.length} guarded test(s) skipped** that this job exists to run:`, '');
  for (const t of unexpected) lines.push(`- ${t.name}`);
  lines.push('');
} else {
  lines.push('No guarded test skipped.', '');
}

write(`${lines.join('\n')}\n`);
process.exit(unexpected.length > 0 ? 1 : 0);
