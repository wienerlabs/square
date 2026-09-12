// Log entries for the compliance-violation path.
//
// The rule this file enforces: when a proof comes back non-compliant, the only
// things that may be written down are the operator's id and the names of the
// rules that failed. Not the ceilings, not the lists, not the category, not the
// request body they arrived in.
//
// The previous implementation logged `input: req.body` on that path, which is
// every private field the circuit exists to hide. It is not enough to delete
// that line: the next person adding a debug field would reintroduce it. So the
// entries here are built from a closed allowlist and validated on the way out,
// and the tests assert that no value from a request can appear in a serialised
// entry.

import { RULE_NAMES } from './rules.js';

const MAX_OPERATOR_ID_LENGTH = 128;

// Coerce whatever arrived as an operator id into something safe to print.
//
// The operator id is an identifier the caller supplies, and #4 allows it in the
// violation log. It is still narrowed here: a non-string is not stringified
// (that would embed an arbitrary object, policy included, in the line) and an
// over-long one is dropped rather than truncated, because a truncated
// identifier is worse than an absent one — it looks like a real id.
function safeOperatorId(value) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed.length > MAX_OPERATOR_ID_LENGTH) return null;
  return trimmed;
}

// Drop anything that is not one of the six known rule names. A rule name is a
// constant from rules.js; if a caller passes something else it is a bug, and
// the bug must not become a channel for arbitrary text.
function safeRuleNames(names) {
  if (!Array.isArray(names)) return [];
  return names.filter((name) => RULE_NAMES.includes(name));
}

// The violation entry. Exactly three keys, always.
export function violationLogEntry({ operatorId, violatedRules }) {
  return {
    event: 'compliance_violation',
    operator_id: safeOperatorId(operatorId),
    violated_rules: safeRuleNames(violatedRules),
  };
}

// Emitted when the circuit and the off-circuit rule evaluator disagree about
// whether the payment is compliant.
//
// This should never fire. If it does, the rule names in the violation log
// cannot be trusted, and that is worth knowing loudly — silently reporting a
// wrong rule name is worse than reporting none. Both sides of the disagreement
// are recorded as a boolean and a list of rule names, which are safe; no
// witness value goes in.
export function divergenceLogEntry({ operatorId, circuitCompliant, evaluatorViolations }) {
  return {
    event: 'rule_evaluation_divergence',
    operator_id: safeOperatorId(operatorId),
    circuit_compliant: circuitCompliant === true,
    evaluator_violated_rules: safeRuleNames(evaluatorViolations),
  };
}

// The success entry. `elapsed_ms` and the compliance bit only — the public
// signals are safe by construction but the caller already has them in the
// response, and a log line is a poor place to duplicate them.
export function proofGeneratedLogEntry({ elapsedMs, isCompliant }) {
  return {
    event: 'proof_generated',
    elapsed_ms: Number.isFinite(elapsedMs) ? elapsedMs : null,
    is_compliant: isCompliant === true,
  };
}

// The failure entry.
//
// Every error this service raises about request content is constructed in
// normalize.js or hash.js and names the field without its value, so the
// message is safe to record. Errors from below (snarkjs, the witness
// calculator, the filesystem) describe circuit structure and file paths, not
// policy — and normalisation runs before any of them can see a raw value.
export function proofFailedLogEntry(error) {
  const message = error instanceof Error ? error.message : String(error);
  return {
    event: 'proof_failed',
    error: message,
  };
}

// A request refused before any proving started.
//
// Separate from proof_failed on purpose. That event means this service tried to
// produce a proof and could not, which is an incident; this one means a caller
// sent a policy the service will not accept, which is not. Merging them would
// put every mistyped hour into the prover's failure rate -- and square#148 is an
// issue about exactly that kind of conflation.
//
// The message comes from validateRequest, which names fields and never their
// values, so it carries the same guarantee as the entry above.
export function requestRejectedLogEntry(error) {
  const message = error instanceof Error ? error.message : String(error);
  return {
    event: 'request_rejected',
    error: message,
  };
}

// A request refused because the service is already at its ceiling.
//
// Its own event for the same reason `request_rejected` is not `proof_failed`
// (square#148): this service did not try to produce a proof and did not fail to
// produce one, so it has no business in the proof failure rate an operator
// pages on. What it is evidence of is load, which is a capacity question, and
// the numbers an operator needs to answer it are how many were running and how
// many were waiting when the request arrived.
//
// No request field appears here; the three values are the service's own counts
// (square#236).
export function requestShedLogEntry({ active, queued, limit }) {
  const count = (value) => (Number.isInteger(value) && value >= 0 ? value : null);
  return {
    event: 'request_shed',
    active: count(active),
    queued: count(queued),
    limit: count(limit),
  };
}

// Every log entry a single successful /prove call produces, in order.
//
// The whole logging decision lives here rather than inline in the route so it
// can be tested against a real prover result without standing up a server or
// stubbing the prover. The route's only job is to serialise what this returns.
export function logEntriesForProof({ result, elapsedMs }) {
  const entries = [
    proofGeneratedLogEntry({ elapsedMs, isCompliant: result.is_compliant }),
  ];

  if (!result.is_compliant) {
    entries.push(violationLogEntry({
      operatorId: result.operator_id,
      // Withhold the rule names when the circuit and the evaluator disagree:
      // naming the wrong rule is worse than naming none.
      violatedRules: result.rules_agree ? result.violated_rules : [],
    }));
  }

  if (!result.rules_agree) {
    entries.push(divergenceLogEntry({
      operatorId: result.operator_id,
      circuitCompliant: result.is_compliant,
      evaluatorViolations: result.violated_rules,
    }));
  }

  return entries;
}
