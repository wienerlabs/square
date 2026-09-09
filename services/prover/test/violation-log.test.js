// Regression test for #4.
//
// The service used to answer "why was this payment rejected?" by writing
// `input: req.body` to the log — the operator's ceilings, their blocked list,
// their whitelist and their endpoint category, in plaintext, in the one place
// the circuit exists to keep them out of.
//
// These tests hold the replacement to the rule the issue states: on the
// violation path, only the operator id and the names of the rules that failed
// may be written down. They are deliberately not written as "the old line is
// gone" — that would pass again the moment someone adds a new debug field.
// Instead they assert the positive property: given a result carrying every
// private value a request can hold, nothing from it appears in any log entry.

import { describe, it, expect } from 'vitest';
import {
  logEntriesForProof,
  violationLogEntry,
  divergenceLogEntry,
} from '../src/logging.js';
import { RULES, RULE_NAMES, evaluateRules } from '../src/rules.js';
import { buildCircuitInput } from '../src/prover.js';

// Distinctive values, so a substring search over the serialised log is a
// meaningful check rather than a coincidence hunt.
const address = (nibble) => `0x${String(nibble).repeat(40)}`;

const SECRET = {
  maxDaily: '987654321987',
  maxPerTx: '123454321123',
  dailySpentBefore: '55555555555',
  amount: '999999999999',
  blockedA: address(2),
  blockedB: address(5),
  whitelistA: address(4),
  categoryA: 'super-secret-category',
  categoryB: 'another-secret-cat',
  recipient: address(1),
  token: address(7),
  operator: address(3),
  policyId: '3f2504e0-4f89-11d3-9a0c-0305e82c3301',
  timestamp: '1788356730',
};

function requestWithSecrets() {
  return {
    policy_id: SECRET.policyId,
    policy_salt: '7777777777777777777777777777777777777777777777777777777777777',
    operator_id: SECRET.operator,
    max_daily_spend: SECRET.maxDaily,
    max_per_transaction: SECRET.maxPerTx,
    allowed_endpoint_categories: [SECRET.categoryA, SECRET.categoryB],
    blocked_addresses: [SECRET.blockedA, SECRET.blockedB],
    token_whitelist: [SECRET.whitelistA],
    payment_amount: SECRET.amount,
    payment_token: SECRET.token,
    payment_recipient: SECRET.recipient,
    payment_endpoint_category: SECRET.categoryA,
    daily_spent_before: SECRET.dailySpentBefore,
    current_unix_timestamp: SECRET.timestamp,
  };
}

// Every private value that must never reach a log line. The operator id is
// deliberately absent: #4 allows it.
const FORBIDDEN_VALUES = [
  SECRET.maxDaily,
  SECRET.maxPerTx,
  SECRET.dailySpentBefore,
  SECRET.amount,
  SECRET.blockedA,
  SECRET.blockedB,
  SECRET.whitelistA,
  SECRET.categoryA,
  SECRET.categoryB,
  SECRET.recipient,
  SECRET.token,
];

function expectNoLeak(entries) {
  const serialised = entries.map((e) => JSON.stringify(e)).join('\n');
  for (const value of FORBIDDEN_VALUES) {
    expect(serialised, `leaked ${value}`).not.toContain(value);
  }
  return serialised;
}

describe('violationLogEntry', () => {
  it('carries exactly the event, the operator id and the rule names', () => {
    const entry = violationLogEntry({
      operatorId: SECRET.operator,
      violatedRules: [RULES.DAILY_LIMIT],
    });
    expect(Object.keys(entry).sort()).toEqual(['event', 'operator_id', 'violated_rules']);
    expect(entry.event).toBe('compliance_violation');
    expect(entry.operator_id).toBe(SECRET.operator);
    expect(entry.violated_rules).toEqual([RULES.DAILY_LIMIT]);
  });

  it('drops anything that is not a known rule name', () => {
    const entry = violationLogEntry({
      operatorId: SECRET.operator,
      violatedRules: [
        RULES.TOKEN_WHITELIST,
        `max_daily=${SECRET.maxDaily}`,
        { blocked: SECRET.blockedA },
        null,
      ],
    });
    expect(entry.violated_rules).toEqual([RULES.TOKEN_WHITELIST]);
    expectNoLeak([entry]);
  });

  it('refuses to stringify a non-string operator id', () => {
    // A caller sending an object here would otherwise embed it — policy and all —
    // in the one field the logger is allowed to print.
    const entry = violationLogEntry({
      operatorId: { id: SECRET.operator, max_daily: SECRET.maxDaily },
      violatedRules: [],
    });
    expect(entry.operator_id).toBeNull();
    expectNoLeak([entry]);
  });

  it('drops an over-long operator id rather than truncating it', () => {
    const entry = violationLogEntry({ operatorId: 'x'.repeat(129), violatedRules: [] });
    expect(entry.operator_id).toBeNull();
  });

  it('emits nothing but names from the known set', () => {
    const entry = violationLogEntry({
      operatorId: SECRET.operator,
      violatedRules: RULE_NAMES,
    });
    for (const name of entry.violated_rules) expect(RULE_NAMES).toContain(name);
  });
});

describe('logEntriesForProof', () => {
  // The result object here carries the full request alongside the fields the
  // route reads, which is the worst case: if the logger reached for anything
  // outside its allowlist, it would find private policy sitting right there.
  function resultWith(overrides) {
    return {
      operator_id: SECRET.operator,
      is_compliant: false,
      violated_rules: [RULES.DAILY_LIMIT, RULES.BLOCKED_RECIPIENT],
      rules_agree: true,
      request: requestWithSecrets(),
      public_signals: { is_compliant: '0' },
      ...overrides,
    };
  }

  it('logs the violation without any private policy value', () => {
    const entries = logEntriesForProof({ result: resultWith({}), elapsedMs: 640 });
    const serialised = expectNoLeak(entries);

    const violation = entries.find((e) => e.event === 'compliance_violation');
    expect(violation).toBeDefined();
    expect(violation.violated_rules).toEqual([RULES.DAILY_LIMIT, RULES.BLOCKED_RECIPIENT]);
    expect(serialised).toContain(SECRET.operator);
  });

  it('logs no violation entry for a compliant payment', () => {
    const entries = logEntriesForProof({
      result: resultWith({ is_compliant: true, violated_rules: [] }),
      elapsedMs: 640,
    });
    expect(entries.map((e) => e.event)).toEqual(['proof_generated']);
    expectNoLeak(entries);
  });

  it('withholds rule names when the circuit and the evaluator disagree', () => {
    const entries = logEntriesForProof({
      result: resultWith({ rules_agree: false }),
      elapsedMs: 640,
    });
    const violation = entries.find((e) => e.event === 'compliance_violation');
    const divergence = entries.find((e) => e.event === 'rule_evaluation_divergence');

    expect(violation.violated_rules).toEqual([]);
    expect(divergence).toBeDefined();
    expect(divergence.circuit_compliant).toBe(false);
    expectNoLeak(entries);
  });

  it('keeps the success entry free of public signals and timings aside', () => {
    const entries = logEntriesForProof({
      result: resultWith({ is_compliant: true, violated_rules: [] }),
      elapsedMs: 640,
    });
    expect(Object.keys(entries[0]).sort()).toEqual(['elapsed_ms', 'event', 'is_compliant']);
    expect(entries[0].elapsed_ms).toBe(640);
  });
});

describe('divergenceLogEntry', () => {
  it('carries exactly four keys and no witness values', () => {
    const entry = divergenceLogEntry({
      operatorId: SECRET.operator,
      circuitCompliant: true,
      evaluatorViolations: [RULES.TIME_WINDOW, `leak:${SECRET.maxDaily}`],
    });
    expect(Object.keys(entry).sort()).toEqual([
      'circuit_compliant', 'evaluator_violated_rules', 'event', 'operator_id',
    ]);
    expect(entry.evaluator_violated_rules).toEqual([RULES.TIME_WINDOW]);
    expectNoLeak([entry]);
  });
});

describe('end to end over a real witness', () => {
  // Builds the circuit input the same way the prover does, evaluates the rules
  // against it, and feeds the outcome through the logger. No proof is needed:
  // the log content is decided before snarkjs is ever called.
  it('names the violated rules and logs none of the policy behind them', async () => {
    const request = requestWithSecrets();
    const circuitInput = await buildCircuitInput(request);
    const evaluation = await evaluateRules(circuitInput);

    // The request is built to break three rules at once: the amount is over
    // both ceilings and the mint is not on the whitelist.
    expect(evaluation.compliant).toBe(false);
    expect(evaluation.violated).toContain(RULES.PER_TRANSACTION_LIMIT);
    expect(evaluation.violated).toContain(RULES.DAILY_LIMIT);
    expect(evaluation.violated).toContain(RULES.TOKEN_WHITELIST);

    const entries = logEntriesForProof({
      result: {
        operator_id: request.operator_id,
        is_compliant: false,
        violated_rules: evaluation.violated,
        rules_agree: true,
      },
      elapsedMs: 1,
    });

    expectNoLeak(entries);
    // And the hashed forms must not leak either: a Poseidon image of a blocked
    // address is still a fingerprint of that address.
    const serialised = entries.map((e) => JSON.stringify(e)).join('\n');
    for (const hashed of circuitInput.blocked_addresses.concat(circuitInput.token_whitelist)) {
      if (hashed !== '0') expect(serialised).not.toContain(hashed);
    }
  });
});
