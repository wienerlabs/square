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
import { isMain } from './entrypoint.mjs';
import { ADOPTED, ensurePtau, verifyPtau } from './fetch-ptau.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const BUILD = path.join(ROOT, 'build');
const CEREMONY = path.join(BUILD, 'ceremony');
const TRANSCRIPT = path.join(CEREMONY, 'transcript.json');
const R1CS = path.join(BUILD, 'payment.r1cs');

// drand quicknet, the same parameters docs/ceremony/beacon.md announces.
//
// quicknet is `bls-unchained-g1-rfc9380`: signatures on G1, group key on G2,
// and the signed message is sha256 of the round number alone — unchained, so a
// round does not depend on its predecessor.
export const DRAND = Object.freeze({
  chainHash: '52db9ba70e0cc0f6eaf7803dd07447a1f5477735fd3f661792ba94600c84e971',
  // The group public key, pinned here rather than taken from /info. Verifying a
  // signature against a key the same host supplied proves only that the host is
  // self-consistent; a party who can answer for api.drand.sh could serve its own
  // key and a signature valid under it, and the check would pass. quicknet is
  // bls-unchained-g1-rfc9380: signatures in G1, so the group key is in G2, 96
  // bytes compressed.
  publicKey:
    '83cf0f2896adee7eb8b5f01fcad3912212c437e0073e911fb90022d3e760183c'
    + '8c4b450b6a0a6c3ac6a5776a2d1064510d1fec758c921cc22b0e17e63aaf4bcb'
    + '5ed66304de9cf809bd274ca73bab4af5a6e9c76a4bc09e76eae8991ef5ece45a',
  genesisSeed: 'f477d5c89f21a17c863a7f937c6a6d15859414d2be09cd448d4279af331c5d3e',
  beaconId: 'quicknet',
  genesis: 1692803367,
  period: 3,
  api: 'https://api.drand.sh/v2/beacons/quicknet',
  dst: 'BLS_SIG_BLS12381G1_XMD:SHA-256_SSWU_RO_NUL_',
});

// drand's chain hash, recomputed from the parameters a chain reports.
//
// This is what makes the pin above self-checking. The hash is a digest over the
// group parameters, so reproducing it from the fields /info returned binds the
// public key, the genesis time, the period and the group seed to one 32-byte
// value that is announced in docs/ceremony/beacon.md. A host cannot substitute a
// key without also breaking the hash, and comparing the *presented* chain_hash
// string — which is what this script did before — checks nothing at all, since
// the same host supplies both sides of that comparison.
//
// The construction is drand's own (chain/info.go, Hash): big-endian uint32
// period, big-endian uint64 genesis, the marshalled public key, the group hash,
// and the beacon id for every scheme except the original chained one.
export async function chainHashOf(info) {
  const { sha256 } = await import('@noble/hashes/sha2');
  const header = new Uint8Array(12);
  const view = new DataView(header.buffer);
  view.setUint32(0, Number(info.period));
  view.setBigUint64(4, BigInt(info.genesis_time));
  const hex = (value) => Uint8Array.from(Buffer.from(String(value), 'hex'));
  return Buffer.from(sha256(Buffer.concat([
    Buffer.from(header),
    Buffer.from(hex(info.public_key)),
    Buffer.from(hex(info.genesis_seed)),
    Buffer.from(String(info.beacon_id), 'utf8'),
  ]))).toString('hex');
}

// Everything that has to be true about the chain before its randomness is worth
// anything, checked in one place so beacon() and verify-chain cannot drift.
export async function assertQuicknet(info) {
  const recomputed = await chainHashOf(info);
  if (recomputed !== DRAND.chainHash) {
    throw new Error(
      `the chain parameters served do not hash to the announced chain.\n`
      + `  recomputed ${recomputed}\n`
      + `  announced  ${DRAND.chainHash}\n`
      + 'Something about this chain differs from the one docs/ceremony/beacon.md names.',
    );
  }
  if (info.public_key !== DRAND.publicKey) {
    throw new Error(
      'the served group public key is not the pinned one, though the chain hash\n'
      + 'recomputed. That should be impossible; treat it as a bug here, not as a\n'
      + 'reason to proceed.',
    );
  }
  if (info.genesis_time !== DRAND.genesis || info.period !== DRAND.period) {
    throw new Error(
      `drand reports genesis ${info.genesis_time} period ${info.period}, `
      + `expected ${DRAND.genesis} and ${DRAND.period}. `
      + 'The announced round number would not mean what it says.',
    );
  }
}

// Verify a round's BLS signature against the chain's group public key.
//
// The key is DRAND.publicKey, pinned above, never the one /info returned. That
// is the difference between "the host is self-consistent" and "drand's threshold
// produced this value": an auditor whose DNS or TLS path to api.drand.sh is
// compromised gets the right answer, because the key the check runs against
// came from this file and is bound to the announced chain hash.
export async function verifyDrandSignature(round, signature, groupPublicKey = DRAND.publicKey) {
  const { bls12_381: bls } = await import('@noble/curves/bls12-381');
  const { sha256 } = await import('@noble/hashes/sha2');
  const roundBytes = new Uint8Array(8);
  new DataView(roundBytes.buffer).setBigUint64(0, BigInt(round));
  const message = bls.shortSignatures.hash(sha256(roundBytes), DRAND.dst);
  return bls.shortSignatures.verify(signature, message, groupPublicKey);
}

export const roundAt = (unixSeconds) =>
  Math.floor((unixSeconds - DRAND.genesis) / DRAND.period) + 1;
export const timeOfRound = (round) =>
  DRAND.genesis + (round - 1) * DRAND.period;

// The comparison `verify-chain` makes between the beacon in the key and the
// signature the public chain published, in one place.
//
// square#227's review: the round-trip test wrote this out by hand and called it
// "verify-chain's, character for character". It was, until it was not -- a
// change to the real comparison could not turn that test red. There is one of
// it now, and both ends call it.
//
// Case-insensitive because the two sources spell hex differently: snarkjs
// stores what it was handed, drand's API returns lower case. Length is not
// checked here on purpose; a 64-character sha256 spelling simply does not equal
// the 96-character signature, which is the failure #227 is about.
export const beaconMatchesRound = (beaconHash, signature) =>
  typeof beaconHash === 'string'
  && typeof signature === 'string'
  && beaconHash.toLowerCase() === signature.toLowerCase();

// Echoing the command is worth keeping: a ceremony tool that hides what it runs
// is hard to audit, and every argument here is meant to be public.
//
// "Meant to be" is not a guarantee, so it is enforced. An argument carrying
// entropy is redacted before printing, and nothing in this file passes one any
// more — snarkjs prompts the contributor directly. The redaction stays as a
// floor: the first version of this script echoed a contributor's toxic waste to
// their terminal, and the property that stopped being true was "no caller
// passes a secret", not anything about the printing.
const SECRET_ARG = /^(-e|--entropy)=/;

function redact(arg) {
  const match = arg.match(SECRET_ARG);
  return match ? `${match[1]}=<redacted>` : arg;
}

function sh(cmd, args, options = {}) {
  process.stdout.write(`$ ${cmd} ${args.map(redact).join(' ')}\n`);
  execFileSync(cmd, args, { cwd: ROOT, stdio: 'inherit', ...options });
}

const sha256 = (file) =>
  crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');

// What compiled the circuit, and what it compiled.
//
// The transcript used to identify the circuit by `r1cs_sha256` alone. That is a
// digest of the compiler's *output*, so an auditor handed it can confirm two
// r1cs files are identical and nothing else: to reproduce it they have to
// compile the source, and the transcript did not say which source or which
// compiler. circom is pinned for CI in .github/actions/circom, but a pin in
// this repository is not a fact in the published record, and
// docs/ceremony/verifying.md told auditors circom was optional.
//
// circomlib's resolved version comes from the lockfile rather than the range in
// package.json: `^2.0.5` is not a compiler input, the file it resolves to is.
function circuitProvenance() {
  const version = execFileSync('circom', ['--version'], { encoding: 'utf8' }).trim();

  const sources = {};
  for (const rel of ['payment.circom', 'lib/timestamp.circom']) {
    sources[rel] = sha256(path.join(ROOT, rel));
  }

  let circomlib = null;
  try {
    const lock = JSON.parse(fs.readFileSync(path.join(ROOT, 'package-lock.json'), 'utf8'));
    circomlib = lock.packages?.['node_modules/circomlib']?.version ?? null;
  } catch {
    circomlib = null;
  }

  return { compiler: version, circomlib, sources };
}

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
    circuit: {
      file: 'payment.circom',
      r1cs_sha256: sha256(R1CS),
      // So a third party can reproduce the r1cs rather than only compare it.
      ...circuitProvenance(),
    },
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

  // No -e. snarkjs prompts for entropy on stdin and the contributor types
  // something only they ever see.
  //
  // Passing it as an argument instead was a disclosure of the one value the
  // contributor is asked to destroy: this script echoes the command it runs, so
  // the entropy landed in their terminal — and in whatever they pasted their
  // published hash out of — and it sat in argv where `ps` exposes it to every
  // other process on the machine for as long as snarkjs ran.
  //
  // It bought nothing either way. snarkjs hashes 64 bytes of
  // crypto.randomFillSync into every contribution before it looks at -e, so a
  // second CSPRNG draw added no randomness and cost full disclosure. The
  // strongest version of this is the one where the script never holds the
  // secret at all.
  process.stdout.write(
    '\nsnarkjs will ask for a random text. Type something only you can see —\n'
    + 'it is mixed with 64 bytes the tool draws from the OS, so it does not have\n'
    + 'to be long, and it must not be written down or shared.\n\n',
  );
  sh('snarkjs', ['zkey', 'contribute', from, to, `--name=${name}`]);

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
  await assertQuicknet(info);

  // The round has to land after the last contribution closed. A beacon that
  // already existed while contributions were open constrains nobody: whoever
  // contributed last could have ground their entropy against a value they
  // already knew. The transcript records when each contribution was made, so
  // this needs no new data — it was simply never checked, and
  // docs/ceremony/verifying.md calls it "the one people forget".
  const landsAt = new Date(timeOfRound(round) * 1000).toISOString();
  const previous = transcript.contributions[transcript.contributions.length - 1];
  if (Date.parse(landsAt) <= Date.parse(previous.at)) {
    throw new Error(
      `round ${round} lands at ${landsAt}, which is not after the last\n`
      + `contribution at ${previous.at}. A beacon that existed while\n`
      + 'contributions were open constrains nobody. Announce a later round.',
    );
  }

  const beaconValue = await fetchRound(round);

  // Before the irreversible step, not after it. verify-chain checks this too,
  // but by then the value is already in the key and the only remedy is running
  // the ceremony again.
  if (!await verifyDrandSignature(round, beaconValue.signature)) {
    throw new Error(
      `round ${round}'s signature does not verify against quicknet's pinned\n`
      + 'group public key. Refusing to write it into the final key.',
    );
  }
  process.stdout.write(`round ${round} verifies against the pinned quicknet group key\n`);

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
    bad(
      'the compiled circuit does NOT match the one the ceremony started from '
      + '(a different source, or a different compiler — see below)',
    );
  }

  // Why the r1cs might differ, when it does. A digest of the compiler's output
  // says two files differ; it does not say which input moved. An auditor who
  // installed a different circom sees a red line about the circuit and has no
  // way to tell that from a substituted source.
  if (transcript.circuit.compiler) {
    const here = circuitProvenance();
    if (here.compiler === transcript.circuit.compiler) {
      ok(`compiled with ${here.compiler}, as the ceremony was`);
    } else {
      bad(
        `this machine has ${here.compiler}, the ceremony used `
        + `${transcript.circuit.compiler}; compile with that one before reading `
        + 'anything above as a mismatch in the source',
      );
    }
    if (here.circomlib === transcript.circuit.circomlib) {
      ok(`circomlib ${here.circomlib}, as the ceremony had`);
    } else {
      bad(`circomlib is ${here.circomlib}, the ceremony had ${transcript.circuit.circomlib}`);
    }
    for (const [file, digest] of Object.entries(transcript.circuit.sources ?? {})) {
      if (here.sources[file] === digest) {
        ok(`${file} is byte-identical to the ceremony's`);
      } else {
        bad(`${file} differs from the ceremony's (${here.sources[file] ?? 'missing'})`);
      }
    }
  } else {
    bad(
      'the transcript records no compiler or source hashes, so the circuit can '
      + 'only be compared, not reproduced — it predates square#121',
    );
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
      if (live && beaconMatchesRound(beacons[0].beaconHash, live.signature)) {
        ok(`beacon is drand quicknet round ${announced.round}, matching the public chain`);
      } else if (live) {
        bad(`beacon in the key does not match drand round ${announced.round}`);
      }

      // And that the value is one drand actually produced, rather than one the
      // API we asked happened to return.
      if (live) {
        try {
          const info = await fetchChainInfo();
          await assertQuicknet(info);
          if (await verifyDrandSignature(announced.round, live.signature)) {
            ok("the round's BLS signature verifies against quicknet's pinned group key");
          } else {
            bad("the round's BLS signature does not verify against quicknet's pinned group key");
          }
        } catch (error) {
          bad(`could not check the round's signature: ${error.message}`);
        }
      }

      // Arithmetic, not evidence: lands_at is derived from the round by
      // beacon(), and roundAt is timeOfRound's inverse, so this holds for every
      // transcript this script writes. It catches a hand-edited file and
      // nothing else. The old wording, "round N corresponds to <time>", read
      // like a timing check that had passed.
      if (roundAt(Date.parse(announced.lands_at) / 1000) === announced.round) {
        ok('the recorded round and time are consistent (arithmetic, not a timing check)');
      } else {
        bad('the recorded round and time disagree, so the transcript was edited by hand');
      }

      // The timing check that does mean something.
      const lastOf = transcript.contributions[transcript.contributions.length - 1];
      if (lastOf && Date.parse(announced.lands_at) > Date.parse(lastOf.at)) {
        ok(`the beacon round lands after the last contribution (${lastOf.at})`);
      } else if (lastOf) {
        bad(
          `the beacon round lands at ${announced.lands_at}, not after the last `
          + `contribution at ${lastOf.at}; it constrains nobody`,
        );
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

if (isMain(import.meta.url)) {
  try {
    process.exit(await main(process.argv.slice(2)));
  } catch (error) {
    process.stderr.write(`error: ${error.message}\n`);
    process.exit(1);
  }
}
