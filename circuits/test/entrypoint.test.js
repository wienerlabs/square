// The two CLIs run from a path a URL has to encode.
//
// square#150. `import.meta.url === \`file://${process.argv[1]}\`` compares a
// percent-encoded URL against a raw path, so a space or a Turkish character
// anywhere in the path made the entry block never run: no output, exit 0. For
// `fetch-ptau.mjs --verify` and `ceremony.mjs verify-chain`, whose whole
// contribution is an exit code, that reads as "verified".
//
// The runner's own path is clean, which is exactly why this failure could not
// show up in CI. So these tests copy the scripts somewhere it is not.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { isMain } from '../scripts/entrypoint.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');

// A space, a Turkish dotted and dotless i, a c-cedilla and a hash: every one of
// them is a character `pathToFileURL` encodes and a raw path does not.
const AWKWARD = 'Çalışma Klasörü #1';

let sandbox;
let scripts;

function run(script, args) {
  try {
    const stdout = execFileSync('node', [path.join(scripts, script), ...args], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return { code: 0, stdout };
  } catch (error) {
    return { code: error.status ?? 1, stdout: error.stdout ?? '', stderr: error.stderr ?? '' };
  }
}

beforeAll(() => {
  sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'square-entrypoint-'));
  scripts = path.join(sandbox, AWKWARD, 'scripts');
  fs.mkdirSync(scripts, { recursive: true });
  for (const file of fs.readdirSync(path.join(ROOT, 'scripts'))) {
    fs.copyFileSync(path.join(ROOT, 'scripts', file), path.join(scripts, file));
  }
  // circomlib and snarkjs live beside the scripts in the real tree; ceremony.mjs
  // only needs them once it does work, and the commands below stop before that.
  fs.symlinkSync(path.join(ROOT, 'node_modules'), path.join(sandbox, AWKWARD, 'node_modules'), 'dir');
});

afterAll(() => {
  fs.rmSync(sandbox, { recursive: true, force: true });
});

describe('the entry guard holds on an awkward path', () => {
  it('puts the scripts somewhere a URL has to encode', () => {
    // Without this the rest of the file would pass by testing nothing.
    expect(scripts).toContain(AWKWARD);
    expect(encodeURI(scripts)).not.toBe(scripts);
  });

  // The reported failure, in the command an auditor is told to run.
  it('fetch-ptau.mjs --print does its work rather than exiting 0 in silence', () => {
    const { code, stdout } = run('fetch-ptau.mjs', ['--print']);
    expect(code).toBe(0);
    expect(stdout, 'the CLI printed nothing: the entry guard did not hold').not.toBe('');
    const record = JSON.parse(stdout);
    expect(record.ceremony).toBe('Perpetual Powers of Tau');
    expect(record.contribution).toBe(80);
  });

  // The two commands whose only output is an exit code. Neither has the files
  // it needs in the sandbox, so both must fail — and failing is the point: an
  // exit 0 here would be the silent pass the issue is about.
  it('fetch-ptau.mjs --verify refuses rather than reporting success', () => {
    const { code, stdout, stderr } = run('fetch-ptau.mjs', ['--verify']);
    expect(code, 'exit 0 with no ptau present is the silent pass').not.toBe(0);
    expect(`${stdout}${stderr}`).not.toBe('');
  });

  it('ceremony.mjs verify-chain refuses rather than reporting success', () => {
    const { code, stdout, stderr } = run('ceremony.mjs', ['verify-chain']);
    expect(code, 'exit 0 with no transcript is the silent pass').not.toBe(0);
    expect(`${stdout}${stderr}`).not.toBe('');
  });

  it('an unknown subcommand is still an error, not a quiet 0', () => {
    const { code } = run('ceremony.mjs', ['not-a-subcommand']);
    expect(code).not.toBe(0);
  });
});

describe('isMain, the comparison itself', () => {
  it('says no when the module was imported rather than run', () => {
    // This test file is what node was asked to run, not entrypoint.mjs.
    expect(isMain(new URL('../scripts/entrypoint.mjs', import.meta.url).href)).toBe(false);
  });

  it('says yes for the file node was actually given', () => {
    const probe = path.join(scripts, 'direct.mjs');
    fs.writeFileSync(
      probe,
      "import { isMain } from './entrypoint.mjs';\n"
      + 'process.stdout.write(isMain(import.meta.url) ? "MAIN" : "NOT MAIN");\n',
    );
    expect(execFileSync('node', [probe], { encoding: 'utf8' })).toBe('MAIN');
  });

  // If the comparison is ever wrong again, it has to be loud. A module whose
  // own name is the file node was given, and which still does not match, is the
  // shape of this bug; answering "not main" there would exit 0 having done
  // nothing, which is what an auditor reads as a pass.
  it('refuses loudly rather than returning false when it cannot recognise itself', () => {
    const probe = path.join(scripts, 'unrecognised.mjs');
    fs.writeFileSync(
      probe,
      "import { isMain } from './entrypoint.mjs';\n"
      + "const elsewhere = new URL('./elsewhere/unrecognised.mjs', import.meta.url).href;\n"
      + 'process.stdout.write(String(isMain(elsewhere)));\n',
    );
    const { code, stdout, stderr } = run('unrecognised.mjs', []);
    expect(code, 'a comparison that fails must not exit 0').toBe(1);
    expect(stdout, 'it must not fall through to the caller').toBe('');
    expect(stderr).toContain('did not recognise itself as the entry point');
    expect(stderr).toContain('Refusing to exit 0');
  });

  // The second failure, measured while fixing the first: through a symbolic
  // link argv[1] is the link and import.meta.url is its target, so matching the
  // encoding alone still says no.
  it('says yes through a symbolic link', () => {
    const probe = path.join(scripts, 'linked.mjs');
    fs.writeFileSync(
      probe,
      "import { isMain } from './entrypoint.mjs';\n"
      + 'process.stdout.write(isMain(import.meta.url) ? "MAIN" : "NOT MAIN");\n',
    );
    const linkDir = path.join(sandbox, 'link dir');
    fs.mkdirSync(linkDir, { recursive: true });
    const link = path.join(linkDir, 'linked.mjs');
    fs.symlinkSync(probe, link);
    expect(execFileSync('node', [link], { encoding: 'utf8' })).toBe('MAIN');
  });
});
