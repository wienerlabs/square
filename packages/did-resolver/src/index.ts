export { AipDidResolver, MAX_CROSS_REGISTRATION_CHECKS } from "./resolve.js";
export { parseDid, formatDid, InvalidDidError } from "./parse.js";
export { buildDidDocument, buildServices } from "./document.js";
export { claimedCrossRegistrations, didOfRegistration } from "./crossRegistrations.js";
export { defaultFetchAgentUri, AgentUriError } from "./fetch.js";
export type { AgentUriErrorCode, FetchAgentUriOptions } from "./fetch.js";
export { IDENTITY_REGISTRY_ABI } from "./registry.js";
export type * from "./types.js";
