import { readFileSync } from "node:fs";

const file = process.argv[2];
if (!file) {
  process.stderr.write("usage: node script/verifier-constants.mjs verification_key.json > constants.txt\n");
  process.exit(2);
}

const vk = JSON.parse(readFileSync(file, "utf8"));
if (vk.protocol !== "groth16" || vk.curve !== "bn128") {
  process.stderr.write(`expected a groth16 bn128 verification key, got ${vk.protocol} ${vk.curve}\n`);
  process.exit(1);
}
if (vk.nPublic !== 8) {
  process.stderr.write(`the verifier is written for 8 public signals, the key has ${vk.nPublic}\n`);
  process.exit(1);
}

const line = (name, value) => `    uint256 private constant ${name} = ${BigInt(value)};`;
const g1 = (name, point) => [line(`${name}_X`, point[0]), line(`${name}_Y`, point[1])];
const g2 = (name, point) => [
  line(`${name}_X_IM`, point[0][1]),
  line(`${name}_X_RE`, point[0][0]),
  line(`${name}_Y_IM`, point[1][1]),
  line(`${name}_Y_RE`, point[1][0]),
];

const out = [
  ...g1("ALPHA", vk.vk_alpha_1),
  "",
  ...g2("BETA", vk.vk_beta_2),
  "",
  ...g2("GAMMA", vk.vk_gamma_2),
  "",
  ...g2("DELTA", vk.vk_delta_2),
  "",
  ...vk.IC.flatMap((point, index) => g1(`IC${index}`, point)),
];
process.stdout.write(out.join("\n") + "\n");
