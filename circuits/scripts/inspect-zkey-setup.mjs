#!/usr/bin/env node
// Report the phase-2 trusted-setup provenance of a Groth16 .zkey.
//
// Every claim this repository makes about the strength of a trusted setup has
// to be checkable by whoever reads it. This tool reads the contribution list
// straight out of the zkey binary and prints what is actually in the file:
// how many phase-2 contributions it carries, whether a beacon was applied,
// and the name each contributor recorded.
//
// A phase-2 setup is only as strong as the assumption that at least one
// contributor destroyed their toxic waste. One contribution and no beacon
// means that assumption rests on a single machine.
//
// zkey binary layout (snarkjs, iden3):
//   "zkey" magic | u32 version | u32 nSections
//   then, per section: u32 id | u64 size | payload
//   section 2  = groth16 header (field sizes, nPublic, ...)
//   section 10 = MPC params: 64-byte csHash | u32 nContributions | contributions
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

// Section 2 carries the field sizes we need to walk section 10, plus nPublic.
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
  return { n8q, n8r, nVars, nPublic, domainSize };
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
  const report = {
    file,
    zkeyVersion: version,
    nPublic: header.nPublic,
    nVars: header.nVars,
    domainSize: header.domainSize,
    csHash,
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
  lines.push('');
  if (report.phase2ContributionCount <= 1 && !report.beaconApplied) {
    lines.push(
      'ASSESSMENT: single-contributor phase 2 with no beacon. Soundness rests entirely',
      'on one machine having destroyed its toxic waste. Whoever held that entropy can',
      'forge a proof for any statement, including a false one. Describe this setup as a',
      'demo. See docs/disclosure/zk-setup-status.md.',
    );
  } else if (!report.beaconApplied) {
    lines.push(
      `ASSESSMENT: ${report.phase2ContributionCount} contributions, no beacon. Multi-party, but without a`,
      'public beacon the final randomness is not publicly verifiable.',
    );
  } else {
    lines.push(
      `ASSESSMENT: ${report.phase2ContributionCount} contributions with a beacon applied. Verify the beacon`,
      'hash against the source announced before the ceremony.',
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
