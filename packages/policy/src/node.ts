// Node-only entry: what needs the filesystem stays out of the root, so a
// browser bundle of `@squaresdk/policy` never resolves `node:fs`.
export { fileDutyState } from "./state.js";
export { ARTIFACT_FILES, createLocalProver } from "./local-prover.js";
export type { LocalProver, LocalProverOptions } from "./local-prover.js";
