// The circuit's public signals, read out of what circom compiled.
//
// square#230. The test that was supposed to protect the eight-signal contract
// could not fail. It counted `PUBLIC_SIGNALS` against itself, compared a
// `signals` object the test had built *from* that same list, and checked that
// the witness was longer than nine wires — 11,584 of them, so always. A ninth
// output publishing a private policy input compiled, ran, and passed the whole
// suite.
//
// The two checks that do read the real number, `vkey.nPublic` in payment.test.js
// and `report.nPublic` in ptau-adoption.test.js, sit behind `skipIf(!HAVE_ZKEY)`
// — so the path README.md recommends (`npm run build -- --no-zkey`, "which is
// all most tests need") skips both.
//
// Everything here works from the compile output alone, which is what that path
// produces:
//
//   payment.r1cs  the binary header carries nPubOut, nPubIn and nPrvIn
//   payment.sym   maps every witness index to its signal name
//
// The witness layout is fixed: w[0] is the constant 1, then the public outputs
// in declaration order, then the public inputs, then everything else. So the
// names at witness indices 1..nPubOut are the public outputs, in the order the
// verifier reads them.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const BUILD = path.resolve(HERE, '..', '..', 'build');

/**
 * The r1cs header, parsed directly so this needs neither snarkjs nor a key.
 *
 * Layout (iden3's r1cs binary format): the magic "r1cs", a u32 version and a
 * u32 section count, then sections of u32 type and u64 length. Section 1 is the
 * header: u32 field size, the prime, then nWires, nPubOut, nPubIn, nPrvIn as
 * u32, nLabels as u64 and nConstraints as u32.
 */
export function r1csHeader(file) {
  const buf = fs.readFileSync(file);
  if (buf.toString('utf8', 0, 4) !== 'r1cs') throw new Error(`${file} is not an r1cs file`);
  const sections = buf.readUInt32LE(8);
  let at = 12;
  for (let i = 0; i < sections; i += 1) {
    const type = buf.readUInt32LE(at);
    const size = Number(buf.readBigUInt64LE(at + 4));
    const body = at + 12;
    if (type === 1) {
      let p = body + 4 + buf.readUInt32LE(body);
      const nWires = buf.readUInt32LE(p); p += 4;
      const nPubOut = buf.readUInt32LE(p); p += 4;
      const nPubIn = buf.readUInt32LE(p); p += 4;
      const nPrvIn = buf.readUInt32LE(p); p += 4;
      const nLabels = Number(buf.readBigUInt64LE(p)); p += 8;
      const nConstraints = buf.readUInt32LE(p);
      return { nWires, nPubOut, nPubIn, nPrvIn, nLabels, nConstraints };
    }
    at = body + size;
  }
  throw new Error(`${file} has no header section`);
}

/**
 * Witness index → signal name, from the symbol file.
 *
 * Lines are `#s,#w,#c,name`: the signal id, the witness index it landed in, the
 * component id, and the dotted name. A signal optimised away carries a witness
 * index of -1, and several names can share one index when the compiler merges
 * them; the first name wins, which is the declared one.
 */
export function witnessNames(symFile) {
  const names = new Map();
  for (const line of fs.readFileSync(symFile, 'utf8').split('\n')) {
    if (!line) continue;
    const [, witness, , name] = line.split(',');
    const index = Number(witness);
    if (!Number.isInteger(index) || index < 0 || names.has(index)) continue;
    names.set(index, name);
  }
  return names;
}

/**
 * What the circuit actually publishes, in the order the verifier reads it.
 *
 * `main.` is stripped: the names in the symbol file are component-qualified and
 * the contract is about the signals, not about what the top-level component is
 * called.
 */
export function publicSignalsOf(circuit = 'payment', buildDir = BUILD) {
  const header = r1csHeader(path.join(buildDir, `${circuit}.r1cs`));
  const names = witnessNames(path.join(buildDir, `${circuit}.sym`));
  const published = [];
  for (let i = 1; i <= header.nPubOut + header.nPubIn; i += 1) {
    const name = names.get(i);
    published.push(name ? name.replace(/^main\./, '') : `<unnamed w${i}>`);
  }
  return { ...header, publicSignals: published };
}

export const isCompiled = (circuit = 'payment', buildDir = BUILD) =>
  fs.existsSync(path.join(buildDir, `${circuit}.r1cs`)) && fs.existsSync(path.join(buildDir, `${circuit}.sym`));
