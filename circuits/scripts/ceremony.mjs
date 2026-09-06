#!/usr/bin/env node
// Run and check the phase-2 ceremony.
//
// The ceremony is a chain: a key is created from the circuit and the adopted
// powers of tau, each contributor mixes in randomness and passes it on, and a
// public beacon closes it. It is sound if *at least one* contributor destroyed
// their entropy — which is why the chain is worth nothing if anybody can quietly
// drop a link, and why every step here is verified as it happens rather than at
// the end.
//
//   init                     create the starting key from the circuit + ptau
//   contribute <name>        a contributor's step
//   verify                   check the chain so far against the circuit
//   beacon <round>           close the chain with the announced drand round
//   finalize                 export the verifying key and write the transcript
//   verify-chain             everything a third party runs, from scratch
//
// The beacon round must have been announced BEFORE the first contribution.
// `beacon` refuses a round that resolves to a different chain than the one
// docs/ceremony/beacon.md names, but it cannot know when you decided on it —
// that part is the announcement's job, and the transcript records it so the
// claim is checkable against a dated public post.
//
// Nothing here invents a contributor. A ceremony with contributions this
// project generated is not a ceremony, and the transcript would be a lie about
// the one property the whole exercise exists to establish.

import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ADOPTED, ensurePtau, verifyPtau } from './fetch-ptau.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const BUILD = path.join(ROOT, 'build');
const CEREMONY = path.join(BUILD, 'ceremony');
const TRANSCRIPT = path.join(CEREMONY, 'transcript.json');
const R1CS = path.join(BUILD, 'payment.r1cs');

// drand quicknet, the same parameters docs/ceremony/beacon.md announces.
const DRAND = Object.freeze({
  chainHash: '52db9ba70e0cc0f6eaf7803dd07447a1f5477735fd3f661792ba94600c84e971',
  genesis: 1692803367,
  period: 3,
  api: 'https://api.drand.sh/v2/beacons/quicknet',
});

export const roundAt = (unixSeconds) =>
  Math.floor((unixSeconds - DRAND.genesis) / DRAND.period) + 1;
export const timeOfRound = (round) =>
  DRAND.genesis + (round - 1) * DRAND.period;

function sh(cmd, args) {
  process.stdout.write(`$ ${cmd} ${args.join(' ')}\n`);
  execFileSync(cmd, args, { cwd: ROOT, stdio: 'inherit' });
}

const sha256 = (file) =>
  crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');

function readTranscript() {
  if (!fs.existsSync(TRANSCRIPT)) throw new Error('no ceremony in progress; run `init` first');
  return JSON.parse(fs.readFileSync(TRANSCRIPT, 'utf8'));
}

function writeTranscript(t) {
  fs.mkdirSync(CEREMONY, { recursive: true });
  fs.writeFileSync(TRANSCRIPT, `${JSON.stringify(t, null, 2)}\n`);
}

const keyPath = (n) => path.join(CEREMONY, `payment_${String(n).padStart(4, '0')}.zkey`);
const finalPath = () => path.join(CEREMONY, 'payment_final.zkey');
const vkPath = () => path.join(CEREMONY, 'payment_vk.json');

// Read the contribution list out of a zkey by reusing the inspector, so the
// transcript records what the file says rather than what this script believes.
async function inspect(file) {
  const { execFileSync: exec } = await import('node:child_process');
  const out = exec('node', [path.join(HERE, 'inspect-zkey-setup.mjs'), file, '--json'], {
    encoding: 'utf8',
  });
  return JSON.parse(out);
}

async function fetchRound(round) {
  const response = await fetch(`${DRAND.api}/rounds/${round}`);
  if (!response.ok) {
    throw new Error(`drand round ${round}: ${response.status} ${response.statusText}`);
  }
  return response.json();
}

async function fetchChainInfo() {
  const response = await fetch(`${DRAND.api}/info`);
  if (!response.ok) throw new Error(`drand info: ${response.status}`);
  return response.json();
}

// ---------------------------------------------------------------- subcommands

async function init() {
  if (!fs.existsSync(R1CS)) {
    throw new Error('build/payment.r1cs is missing; run `npm run build -- --no-zkey` first');
  }
  if (fs.existsSync(TRANSCRIPT)) {
    throw new Error(
      `a ceremony already exists at ${path.relative(ROOT, CEREMONY)}.\n`
      + 'Refusing to restart it: the transcript is the only record of what happened.\n'
      + 'Move it aside deliberately if you really are starting over.',
    );
  }

  const ptau = await ensurePtau();
  fs.mkdirSync(CEREMONY, { recursive: true });
  sh('snarkjs', ['groth16', 'setup', R1CS, ptau.file, keyPath(0)]);

  writeTranscript({
    circuit: { file: 'payment.circom', r1cs_sha256: sha256(R1CS) },
    phase1: {
      ceremony: ADOPTED.ceremony,
      contribution: ADOPTED.contribution,
      file: ADOPTED.file,
      sha256: ADOPTED.sha256,
    },
    started_at: new Date().toISOString(),
    contributions: [],
    beacon: null,
    final: null,
  });

  process.stdout.write(
    `\nstarting key: ${path.relative(ROOT, keyPath(0))}\n`
    + 'Hand it to the first contributor. Nothing about it is secret.\n',
  );
}

async function contribute(name) {
  if (!name) throw new Error('usage: ceremony.mjs contribute "<contributor name>"');
  const transcript = readTranscript();
  const index = transcript.contributions.length;
  const from = keyPath(index);
  const to = keyPath(index + 1);
  if (!fs.existsSync(from)) throw new Error(`${path.relative(ROOT, from)} is missing`);

  // Entropy from the OS. A contributor running this on their own machine is the
  // point; if they would rather pipe in their own, snarkjs takes -e.
  const entropy = Buffer.from(crypto.getRandomValues(new Uint8Array(64))).toString('base64');
  sh('snarkjs', ['zkey', 'contribute', from, to, `--name=${name}`, `-e=${entropy}`]);

  const report = await inspect(to);
  const last = report.contributions[report.contributions.length - 1];
  transcript.contributions.push({
    index: index + 1,
    name,
    recorded_name: last.name,
    transcript_hash: last.transcriptHash,
    zkey_sha256: sha256(to),
    at: new Date().toISOString(),
  });
  writeTranscript(transcript);

  process.stdout.write(
    `\ncontribution ${index + 1} recorded as ${JSON.stringify(last.name)}\n`
    + `  transcript hash ${last.transcriptHash}\n`
    + `  zkey sha256     ${sha256(to)}\n\n`
    + 'Destroy the entropy. On most machines that means closing this shell and\n'
    + 'not writing anything down; the security of the whole chain is one\n'
    + 'contributor doing exactly that.\n',
  );
}

async function verify() {
  const transcript = readTranscript();
  const index = transcript.contributions.length;
  const key = fs.existsSync(finalPath()) ? finalPath() : keyPath(index);
  const ptau = path.join(BUILD, ADOPTED.file);
  verifyPtau(ptau);
  sh('snarkjs', ['zkey', 'verify', R1CS, ptau, key]);
  process.stdout.write(`\n${path.relative(ROOT, key)} verifies against the circuit and the adopted ptau.\n`);
}

async function beacon(roundArg) {
  const transcript = readTranscript();
  if (transcript.beacon) throw new Error('the beacon has already been applied');
  if (transcript.contributions.length === 0) {
    throw new Error(
      'no contributions yet. A beacon over an empty chain is a setup this project\n'
      + 'generated by itself, which is what the ceremony exists to avoid.',
    );
  }
  const round = Number(roundArg);
  if (!Number.isInteger(round) || round <= 0) {
    throw new Error('usage: ceremony.mjs beacon <announced drand round>');
  }

  // Confirm we are talking to the chain the announcement named. The round
  // number is only meaningful relative to a chain's genesis and period, so all
  // three are checked, not just the hash.
  const info = await fetchChainInfo();
  const chainHash = info.chain_hash ?? info.hash;
  if (chainHash !== DRAND.chainHash) {
    throw new Error(
      `drand chain hash is ${chainHash}, expected ${DRAND.chainHash}.\n`
      + 'That is a different chain than docs/ceremony/beacon.md announces.',
    );
  }
  if (info.genesis_time !== DRAND.genesis || info.period !== DRAND.period) {
    throw new Error(
      `drand reports genesis ${info.genesis_time} period ${info.period}, `
      + `expected ${DRAND.genesis} and ${DRAND.period}. `
      + 'The announced round number would not mean what it says.',
    );
  }

  const beaconValue = await fetchRound(round);
  const landsAt = new Date(timeOfRound(round) * 1000).toISOString();
  const index = transcript.contributions.length;

  // The randomness is the round's BLS signature: unpredictable before the round
  // and verifiable by anyone against the public chain afterwards.
  sh('snarkjs', [
    'zkey', 'beacon', keyPath(index), finalPath(), beaconValue.signature, '10',
    `--name=drand quicknet round ${round}`,
  ]);

  transcript.beacon = {
    source: 'drand quicknet',
    chain_hash: DRAND.chainHash,
    round,
    lands_at: landsAt,
    signature: beaconValue.signature,
    num_iterations_exp: 10,
    applied_at: new Date().toISOString(),
  };
  writeTranscript(transcript);
  process.stdout.write(`\nbeacon applied: drand quicknet round ${round} (${landsAt})\n`);
}

async function finalize() {
  const transcript = readTranscript();
  if (!transcript.beacon) throw new Error('apply the beacon before finalising');
  sh('snarkjs', ['zkey', 'export', 'verificationkey', finalPath(), vkPath()]);

  const report = await inspect(finalPath());
  transcript.final = {
    zkey_sha256: sha256(finalPath()),
    vk_sha256: sha256(vkPath()),
    public_signals: report.nPublic,
    phase1_recognised: report.phase1.recognisedCeremony,
    phase2_contributions: report.phase2ContributionCount,
    beacon_applied: report.beaconApplied,
    finalised_at: new Date().toISOString(),
  };
  writeTranscript(transcript);

  process.stdout.write(
    `\nfinal key   ${path.relative(ROOT, finalPath())}  sha256 ${transcript.final.zkey_sha256}\n`
    + `verifying key ${path.relative(ROOT, vkPath())}  sha256 ${transcript.final.vk_sha256}\n`
    + `transcript  ${path.relative(ROOT, TRANSCRIPT)}\n`,
  );
}

// Everything a third party runs. Takes nothing on trust from this repository
// except the circuit source, which they can compile themselves.
async function verifyChain() {
  const transcript = readTranscript();
  const problems = [];
  const ok = (line) => process.stdout.write(`  ok    ${line}\n`);
  const bad = (line) => { problems.push(line); process.stdout.write(`  FAIL  ${line}\n`); };

  process.stdout.write('phase 1\n');
  const ptau = path.join(BUILD, ADOPTED.file);
  try {
    verifyPtau(ptau);
    ok(`${ADOPTED.file} matches the adopted ${ADOPTED.ceremony} contribution ${ADOPTED.contribution}`);
  } catch (error) {
    bad(error.message);
  }

  process.stdout.write('\ncircuit\n');
  if (fs.existsSync(R1CS) && sha256(R1CS) === transcript.circuit.r1cs_sha256) {
    ok('the compiled circuit matches the one the ceremony started from');
  } else {
    bad('the compiled circuit does NOT match the one the ceremony started from');
  }

  process.stdout.write('\nchain\n');
  if (!fs.existsSync(finalPath())) {
    bad('no final key');
  } else {
    try {
      execFileSync('snarkjs', ['zkey', 'verify', R1CS, ptau, finalPath()], { cwd: ROOT, stdio: 'pipe' });
      ok('the final key verifies against the circuit and the adopted ptau');
    } catch {
      bad('the final key does NOT verify against the circuit and the adopted ptau');
    }

    const report = await inspect(finalPath());
    const contributions = report.contributions.filter((c) => c.kind === 'contribute');
    const beacons = report.contributions.filter((c) => c.kind === 'beacon');

    if (contributions.length === transcript.contributions.length) {
      ok(`${contributions.length} contribution(s), matching the transcript`);
    } else {
      bad(`key holds ${contributions.length} contribution(s), transcript claims ${transcript.contributions.length}`);
    }
    if (contributions.length < 2) {
      bad('fewer than two independent contributions — this is not a multi-party ceremony');
    }

    process.stdout.write('\nbeacon\n');
    if (beacons.length !== 1) {
      bad(`expected exactly one beacon, found ${beacons.length}`);
    } else if (!transcript.beacon) {
      bad('the key carries a beacon the transcript does not record');
    } else {
      const announced = transcript.beacon;
      // The beacon hash in the key must be the signature the public chain
      // publishes for that round. This is the check that makes "announced in
      // advance" mean something: anybody can fetch the round and compare.
      //
      // A round the chain cannot produce is a failed check, not a crashed run —
      // a verifier that stops on the first surprise tells you less than one
      // that finishes and hands you the whole picture.
      let live = null;
      try {
        live = await fetchRound(announced.round);
      } catch (error) {
        bad(`could not fetch drand round ${announced.round}: ${error.message}`);
      }
      if (live && beacons[0].beaconHash?.toLowerCase() === live.signature.toLowerCase()) {
        ok(`beacon is drand quicknet round ${announced.round}, matching the public chain`);
      } else if (live) {
        bad(`beacon in the key does not match drand round ${announced.round}`);
      }
      if (roundAt(Date.parse(announced.lands_at) / 1000) === announced.round) {
        ok(`round ${announced.round} corresponds to ${announced.lands_at}`);
      } else {
        bad('the recorded round and time disagree');
      }
    }

    process.stdout.write('\nkeys\n');
    if (fs.existsSync(vkPath()) && transcript.final
        && sha256(vkPath()) === transcript.final.vk_sha256) {
      ok('the verifying key is the one the transcript records');
    } else {
      bad('the verifying key does not match the transcript');
    }
  }

  process.stdout.write(
    problems.length === 0
      ? '\nAll checks passed. The chain is what the transcript says it is.\n'
      : `\n${problems.length} check(s) failed.\n`,
  );
  return problems.length === 0 ? 0 : 1;
}

async function main(argv) {
  const [command, ...rest] = argv;
  switch (command) {
    case 'init': await init(); return 0;
    case 'contribute': await contribute(rest.join(' ').trim()); return 0;
    case 'verify': await verify(); return 0;
    case 'beacon': await beacon(rest[0]); return 0;
    case 'finalize': await finalize(); return 0;
    case 'verify-chain': return verifyChain();
    case 'round-at': {
      const t = rest[0] ? Date.parse(rest[0]) / 1000 : Date.now() / 1000;
      process.stdout.write(`${roundAt(Math.floor(t))}\n`);
      return 0;
    }
    default:
      process.stderr.write(
        'usage: node scripts/ceremony.mjs <init|contribute|verify|beacon|finalize|verify-chain|round-at>\n',
      );
      return 2;
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  try {
    process.exit(await main(process.argv.slice(2)));
  } catch (error) {
    process.stderr.write(`error: ${error.message}\n`);
    process.exit(1);
  }
}
