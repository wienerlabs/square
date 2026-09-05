#!/usr/bin/env node
// Report the trusted-setup provenance of a Groth16 .zkey — both phases.
//
// Every claim this repository makes about the strength of a trusted setup has
// to be checkable by whoever reads it, which means reading the artifact rather
// than the comments around it.
//
// PHASE 2 (circuit-specific) is read from the contribution list in section 10:
// how many contributions the key carries, whether a beacon was applied, and the
// name each contributor recorded. A phase-2 setup is only as strong as the
// assumption that at least one contributor destroyed their toxic waste; one
// contribution and no beacon reduces that to a single machine.
//
// PHASE 1 (universal powers of tau) is not recorded in the zkey as a filename or
// a hash, so it cannot be read off directly. It can still be identified. In
// snarkjs's Groth16 setup, vk_alpha_1 and vk_beta_2 are copied straight out of
// the ptau and are never touched by phase-2 contributions, which only update
// delta. They are therefore a fingerprint of the ptau that is identical for
// every circuit built on it and different for every independently generated tau.
// Comparing them against the published Perpetual Powers of Tau values answers
// "was this built on the public ceremony, or on a tau someone made locally?"
//
// zkey binary layout (snarkjs, iden3):
//   "zkey" magic | u32 version | u32 nSections
//   then, per section: u32 id | u64 size | payload
//   section 2  = groth16 header: u32 n8q | q | u32 n8r | r | u32 nVars |
//                u32 nPublic | u32 domainSize | alpha1 G1 | beta1 G1 |
//                beta2 G2 | gamma2 G2 | delta1 G1 | delta2 G2
//   section 10 = MPC params: 64-byte csHash | u32 nContributions | contributions
// Field elements are little-endian and in Montgomery form.
// Contribution record (BN254: G1 = 2*n8q, G2 = 4*n8q):
//   deltaAfter G1 | delta.g1_s G1 | delta.g1_sx G1 | delta.g2_spx G2
//   | 64-byte transcript | u32 type | u32 paramLength | params
// Params are tag-length-value, sorted ascending by tag:
//   1 = contributor name, 2 = beacon numIterationsExp, 3 = beacon hash
// type 0 = `snarkjs zkey contribute` (entropy supplied by a human)
// type 1 = `snarkjs zkey beacon`     (entropy from a public, verifiable source)

import fs from 'node:fs';

const USAGE = `usage: node circuits/scripts/inspect-zkey-setup.mjs <path-to.zkey> [--json]

exit codes:
  0  file parsed and reported
  1  file missing, unreadable, or not a zkey
`;

// BN254 base field modulus, and the Montgomery R used by snarkjs/ffjavascript.
const BN254_Q = BigInt(
  '21888242871839275222246405745257275088696311157297823662689037894645226208583',
);
const MONT_R = (1n << 256n) % BN254_Q;

function modInverse(a, m) {
  let [oldR, r] = [((a % m) + m) % m, m];
  let [oldS, s] = [1n, 0n];
  while (r !== 0n) {
    const q = oldR / r;
    [oldR, r] = [r, oldR - q * r];
    [oldS, s] = [s, oldS - q * s];
  }
  return ((oldS % m) + m) % m;
}
const MONT_R_INV = modInverse(MONT_R, BN254_Q);
const fromMontgomery = (x) => (x * MONT_R_INV) % BN254_Q;

function readFieldElement(buf, offset, n8q) {
  const le = Buffer.from(buf.subarray(offset, offset + n8q));
  return fromMontgomery(BigInt(`0x${le.reverse().toString('hex')}`));
}

// Known phase-1 ceremonies, by the vk_alpha_1 / vk_beta_2 pair a key built on
// them carries. Every truncation of a ceremony shares the pair — alpha and beta
// are single group elements, so power 11 and power 23 of the same ceremony are
// indistinguishable here, which is exactly what makes the pair identify the
// ceremony rather than the circuit.
//
// Each pair was read out of a key actually built on that file, and each is
// corroborated by how widely it occurs: these exact decimal strings appear in
// hundreds to thousands of unrelated repositories. That is what a shared public
// ceremony looks like, and what a locally generated tau never does.
//
// The two entries are the same Perpetual Powers of Tau ceremony at different
// points along its contribution chain. Contribution 80 is the one this project
// adopts — see docs/ceremony/phase1-ptau.md.
const KNOWN_CEREMONIES = Object.freeze([
  {
    name: 'Perpetual Powers of Tau, contribution 80 (ppot_0080_*)',
    alpha1: [
      '16428432848801857252194528405604668803277877773566238944394625302971855135431',
      '16846502678714586896801519656441059708016666274385668027902869494772365009666',
    ],
    beta2: [
      [
        '16348171800823588416173124589066524623406261996681292662100840445103873053252',
        '3182164110458002340215786955198810119980427837186618912744689678939861918171',
      ],
      [
        '19687132236965066906216944365591810874384658708175106803089633851114028275753',
        '4920802715848186258981584729175884379674325733638798907835771393452862684714',
      ],
    ],
  },
  {
    name: 'Perpetual Powers of Tau, Hermez snapshot (powersOfTau28_hez_final_*)',
    alpha1: [
      '20491192805390485299153009773594534940189261866228447918068658471970481763042',
      '9383485363053290200918347156157836566562967994039712273449902621266178545958',
    ],
    beta2: [
      [
        '6375614351688725206403948262868962793625744043794305715222011528459656738731',
        '4252822878758300859123897981450591353533073413197771768651442665752259397132',
      ],
      [
        '10505242626370262277552901082094356697409835680220590971873171140371331206856',
        '21847035105528745403288232691147584728191162732299865338377159692350059136679',
      ],
    ],
  },
]);

function readSections(buf) {
  if (buf.subarray(0, 4).toString('ascii') !== 'zkey') {
    throw new Error('not a zkey file: magic bytes are not "zkey"');
  }
  const version = buf.readUInt32LE(4);
  const nSections = buf.readUInt32LE(8);
  const sections = new Map();
  let p = 12;
  while (p < buf.length) {
    const id = buf.readUInt32LE(p);
    p += 4;
    const size = Number(buf.readBigUInt64LE(p));
    p += 8;
    if (p + size > buf.length) {
      throw new Error(`section ${id} declares ${size} bytes but the file ends first`);
    }
    sections.set(id, { start: p, size });
    p += size;
  }
  return { version, nSections, sections };
}

// Section 2 carries the field sizes needed to walk section 10, the circuit
// dimensions, and the verifying-key points. alpha1 and beta2 come out of it
// because they are the phase-1 fingerprint: snarkjs copies them from the ptau
// during setup and phase-2 contributions never touch them.
function readGroth16Header(buf, section) {
  let p = section.start;
  const n8q = buf.readUInt32LE(p);
  p += 4 + n8q; // n8q, q
  const n8r = buf.readUInt32LE(p);
  p += 4 + n8r; // n8r, r
  const nVars = buf.readUInt32LE(p);
  p += 4;
  const nPublic = buf.readUInt32LE(p);
  p += 4;
  const domainSize = buf.readUInt32LE(p);
  p += 4;

  const fe = (offset) => readFieldElement(buf, offset, n8q).toString();

  const alpha1 = [fe(p), fe(p + n8q)];
  p += 2 * n8q;        // alpha1 G1
  p += 2 * n8q;        // beta1 G1, not needed
  const beta2 = [
    [fe(p), fe(p + n8q)],
    [fe(p + 2 * n8q), fe(p + 3 * n8q)],
  ];

  return { n8q, n8r, nVars, nPublic, domainSize, alpha1, beta2 };
}

// Does this key's phase-1 fingerprint match a ceremony we know?
function identifyPhase1(header) {
  const alphaOf = (c) =>
    header.alpha1[0] === c.alpha1[0] && header.alpha1[1] === c.alpha1[1];
  const betaOf = (c) =>
    header.beta2[0][0] === c.beta2[0][0] && header.beta2[0][1] === c.beta2[0][1]
    && header.beta2[1][0] === c.beta2[1][0] && header.beta2[1][1] === c.beta2[1][1];

  for (const ceremony of KNOWN_CEREMONIES) {
    const alphaMatches = alphaOf(ceremony);
    const betaMatches = betaOf(ceremony);
    if (alphaMatches && betaMatches) {
      return { known: true, ceremony: ceremony.name, alphaMatches, betaMatches };
    }
    // A half match should never happen: alpha and beta come from the same ptau.
    // If it does, the file is malformed or was assembled by hand, and saying so
    // is more useful than picking one of the two answers.
    if (alphaMatches !== betaMatches) {
      return { known: false, ceremony: null, alphaMatches, betaMatches };
    }
  }
  return { known: false, ceremony: null, alphaMatches: false, betaMatches: false };
}

function readContributions(buf, section, n8q) {
  const G1 = 2 * n8q;
  const G2 = 4 * n8q;
  let p = section.start;
  const csHash = buf.subarray(p, p + 64).toString('hex');
  p += 64;
  const count = buf.readUInt32LE(p);
  p += 4;

  const contributions = [];
  for (let i = 0; i < count; i += 1) {
    p += G1 + G1 + G1 + G2; // deltaAfter, delta.g1_s, delta.g1_sx, delta.g2_spx
    const transcript = buf.subarray(p, p + 64).toString('hex');
    p += 64;
    const type = buf.readUInt32LE(p);
    p += 4;
    const paramLength = buf.readUInt32LE(p);
    p += 4;

    const end = p + paramLength;
    const c = { index: i + 1, type, transcript, name: null, beaconHash: null, numIterationsExp: null };
    let lastTag = 0;
    while (p < end) {
      const tag = buf.readUInt8(p);
      p += 1;
      if (tag <= lastTag) throw new Error(`contribution ${i + 1}: parameter tags out of order`);
      lastTag = tag;
      if (tag === 1) {
        const len = buf.readUInt8(p);
        p += 1;
        c.name = buf.subarray(p, p + len).toString('utf8');
        p += len;
      } else if (tag === 2) {
        c.numIterationsExp = buf.readUInt8(p);
        p += 1;
      } else if (tag === 3) {
        const len = buf.readUInt8(p);
        p += 1;
        c.beaconHash = buf.subarray(p, p + len).toString('hex');
        p += len;
      } else {
        throw new Error(`contribution ${i + 1}: unrecognized parameter tag ${tag}`);
      }
    }
    if (p !== end) throw new Error(`contribution ${i + 1}: parameter block overran its declared length`);
    contributions.push(c);
  }

  if (p !== section.start + section.size) {
    throw new Error('contribution section size does not match the records it contains');
  }
  return { csHash, contributions };
}

function main(argv) {
  const args = argv.filter((a) => a !== '--json');
  const asJson = argv.includes('--json');
  const file = args[0];
  if (!file) {
    process.stderr.write(USAGE);
    return 1;
  }
  if (!fs.existsSync(file)) {
    process.stderr.write(`error: no such file: ${file}\n`);
    return 1;
  }

  const buf = fs.readFileSync(file);
  const { version, sections } = readSections(buf);
  if (!sections.has(2)) throw new Error('zkey has no groth16 header section (2)');
  if (!sections.has(10)) throw new Error('zkey has no MPC params section (10)');

  const header = readGroth16Header(buf, sections.get(2));
  const { csHash, contributions } = readContributions(buf, sections.get(10), header.n8q);

  const beacons = contributions.filter((c) => c.type === 1);
  const phase1 = identifyPhase1(header);
  const report = {
    file,
    zkeyVersion: version,
    nPublic: header.nPublic,
    nVars: header.nVars,
    domainSize: header.domainSize,
    csHash,
    phase1: {
      recognisedCeremony: phase1.ceremony,
      alpha1: header.alpha1,
      beta2: header.beta2,
    },
    phase2ContributionCount: contributions.length,
    beaconApplied: beacons.length > 0,
    contributions: contributions.map((c) => ({
      index: c.index,
      kind: c.type === 1 ? 'beacon' : c.type === 0 ? 'contribute' : `unknown(${c.type})`,
      name: c.name,
      beaconHash: c.beaconHash,
      numIterationsExp: c.numIterationsExp,
      transcriptHash: c.transcript,
    })),
  };

  if (asJson) {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    return 0;
  }

  const lines = [
    `file                     ${report.file}`,
    `zkey version             ${report.zkeyVersion}`,
    `public signals           ${report.nPublic}`,
    `witness variables        ${report.nVars}`,
    `domain size              ${report.domainSize}`,
    '',
    `phase-1 ceremony         ${phase1.known ? phase1.ceremony : 'UNRECOGNISED'}`,
    `  vk_alpha_1             ${header.alpha1[0]}`,
    `                         ${header.alpha1[1]}`,
    `  vk_beta_2              ${header.beta2[0][0]}`,
    `                         ${header.beta2[0][1]}`,
    `                         ${header.beta2[1][0]}`,
    `                         ${header.beta2[1][1]}`,
    '',
    `phase-2 contributions    ${report.phase2ContributionCount}`,
    `beacon applied           ${report.beaconApplied ? 'yes' : 'no'}`,
    '',
    'contributions:',
  ];
  for (const c of report.contributions) {
    lines.push(`  [${c.index}] ${c.kind.padEnd(10)} name=${JSON.stringify(c.name)}`);
    if (c.beaconHash) lines.push(`      beaconHash=${c.beaconHash} numIterationsExp=${c.numIterationsExp}`);
    lines.push(`      transcript=${c.transcriptHash}`);
  }
  lines.push('', 'ASSESSMENT');

  // Phase 1. A ceremony this tool does not recognise is not automatically bad —
  // there are public ceremonies other than the Perpetual Powers of Tau — but it
  // is unproven, and an unproven phase 1 is exactly as fatal as a weak phase 2.
  if (phase1.known) {
    lines.push(
      `  phase 1: built on ${phase1.ceremony}.`,
      '           alpha and beta match the published ceremony, so the tau behind this',
      '           key is the public one and not a locally generated substitute.',
    );
  } else if (phase1.alphaMatches !== phase1.betaMatches) {
    lines.push(
      '  phase 1: MALFORMED. alpha and beta disagree about which ptau they came from,',
      '           which cannot happen in a key produced by an unmodified snarkjs setup.',
    );
  } else {
    lines.push(
      '  phase 1: UNRECOGNISED. The alpha and beta in this key do not match the',
      '           Perpetual Powers of Tau. Either it was built on a different public',
      '           ceremony — in which case publish which one, and its transcript — or',
      '           the tau was generated locally, in which case one machine held it and',
      '           phase 1 is as forgeable as a single-contributor phase 2.',
    );
  }

  // Phase 2.
  if (report.phase2ContributionCount <= 1 && !report.beaconApplied) {
    lines.push(
      '  phase 2: single contribution, no beacon. Soundness rests entirely on one',
      '           machine having destroyed its toxic waste.',
    );
  } else if (!report.beaconApplied) {
    lines.push(
      `  phase 2: ${report.phase2ContributionCount} contributions, no beacon. Multi-party, but without a public`,
      '           beacon the final randomness is not publicly verifiable.',
    );
  } else {
    lines.push(
      `  phase 2: ${report.phase2ContributionCount} contributions with a beacon applied. Verify the beacon hash`,
      '           against the source announced before the ceremony.',
    );
  }

  const phase1Weak = !phase1.known;
  const phase2Weak = report.phase2ContributionCount <= 1 && !report.beaconApplied;
  if (phase1Weak || phase2Weak) {
    lines.push(
      '',
      '  Either phase alone is enough to let whoever held that entropy forge a proof',
      '  for any statement, including a false one. Describe this setup as a demo.',
      '  See docs/disclosure/zk-setup-status.md.',
    );
  }

  process.stdout.write(`${lines.join('\n')}\n`);
  return 0;
}

try {
  process.exit(main(process.argv.slice(2)));
} catch (err) {
  process.stderr.write(`error: ${err.message}\n`);
  process.exit(1);
}
