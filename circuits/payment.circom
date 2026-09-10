pragma circom 2.0.0;

include "circomlib/circuits/bitify.circom";
include "circomlib/circuits/comparators.circom";
include "circomlib/circuits/poseidon.circom";
include "../lib/timestamp.circom";

// PaymentCompliance proves that an agent payment satisfies all six rules of its
// operator's policy, and binds the proof to a specific transfer.
//
// FIVE of the six bind. Rule 5 does not, and it is not a defect that can be
// fixed here. `payment_category` is a private input, it is not one of the eight
// public signals, and it is not one of the eight inputs to policy_data_hash —
// so unlike every other rule's key it is visible to nothing outside this
// circuit. An honest prover fails rule 5 on a disallowed category; a prover
// building a witness by hand is not constrained by it, because no party can
// contradict a value only they ever saw. Exposing it as a ninth signal was
// considered under square#121 and declined: there is nothing in the system to
// compare it against, and the ceremony in square#16 freezes this layout either
// way. circuits/README.md carries the full reasoning.
//
// Ported from aperture's Solana circuit under square#14. Everything below had
// to land in the same regenerated zkey, because the ceremony that follows
// freezes the circuit and a later change would invalidate the proving key:
//
//   1. The time-window rule's timestamp decomposition was under-constrained, so
//      a prover could choose the weekday. It is properly constrained now, in
//      lib/timestamp.circom, which carries the full explanation.
//   2. Ten public signals became eight. The Solana version split 32-byte
//      pubkeys into high/low halves because they exceed the BN254 field; a
//      20-byte EVM address fits in one element, so recipient_high/low and
//      token_mint_high/low collapse to one signal each.
//   3. The list mask arrays are gone. policy_data_hash committed to the list
//      values but not to the masks, so zeroing blocked_addresses_mask turned
//      rule 4 off while leaving the commitment byte-identical. See the comment
//      on the list inputs below.
//   4. Operands the comparators assumed were in range are now constrained to
//      be: the two amounts, the window's start and end hours, and the boolean
//      time_active. circomlib's comparators bound the difference of their
//      operands, never the operands, which is the same shape of mistake as (1).
//
// PUBLIC SIGNALS, IN ORDER (8)
//
//   [0] is_compliant             1 when all six rules pass, else 0
//   [1] policy_data_hash         Poseidon commitment to the whole policy
//   [2] recipient                payee address as a field element
//   [3] amount                   payment amount, USDC base units (6 decimals)
//   [4] token                    token address as a field element
//   [5] daily_spent_before       operator's spend for the day before this one
//   [6] current_unix_timestamp   seconds; the contract bounds it to block.timestamp
//   [7] stripe_receipt_hash      Poseidon receipt commitment, 0 when unused
//
// AMOUNTS ARE 6-DECIMAL ERC-20 UNITS
//
// Rules 1 and 2 compare with LessEqThan(64), so amounts must stay under 2^64.
// On Arc, USDC has two interfaces: the ERC-20 side reports 6 decimals and
// native gas accounting uses 18. At 6 decimals 2^64 is about 18.4 trillion
// USDC; at 18 it is 18.44 USDC, which the circuit could not express. Escrow and
// payment paths therefore use the ERC-20 interface — see
// docs/decisions/erc20-vs-native-usdc.md. The bound is enforced here rather
// than assumed, because an unenforced assumption is how the time rule broke.
//
// WHAT STAYS PRIVATE
//
//   - The ceilings (max_per_tx, max_daily). Operators reveal that the payment
//     fit, not what their limit was.
//   - The whitelist, blocked list and category list. An auditor learns that
//     membership was checked, not what the lists held.
//   - The payment category, and the time window.
//
// The time window in particular is why rule 6 could not be moved on-chain: the
// contract never sees the window, only the commitment that covers it, so it can
// bound the timestamp but cannot judge it against a policy it cannot read.
//
// Poseidon is used inside the circuit and by the policy service, which must
// produce byte-identical commitments.
template PaymentCompliance(MAX_WHITELIST, MAX_BLOCKED, MAX_CATEGORIES) {
    // ============================================================ Policy (private)
    signal input max_per_tx;
    signal input max_daily;

    // Address lists hold field elements directly. The Solana version stored a
    // Poseidon hash of each entry's two halves because a 32-byte pubkey needed
    // two field elements to be compared as one value; a 20-byte address does
    // not, so the hashing is gone and membership is plain equality. Slots
    // 0..count-1 carry real entries and the rest are zero-padded.
    //
    // There are no mask arrays any more, and their absence is a fix rather than
    // a simplification. Each list used to come with a parallel mask marking the
    // active slots, and policy_data_hash committed to the values but NOT to the
    // masks. A prover could therefore zero blocked_addresses_mask, leave the
    // values untouched, and produce a witness in which the commitment is
    // byte-identical and rule 4 matches nothing — paying a blocked recipient
    // with a proof the contract's policy check accepts.
    //
    // The masks were never load-bearing to begin with. Padding is zero and the
    // three values looked up are constrained non-zero below, so a padding slot
    // can never match. Dropping the arrays removes the bypass by removing the
    // uncommitted input it depended on.
    signal input token_whitelist[MAX_WHITELIST];
    signal input blocked_addresses[MAX_BLOCKED];

    // Categories are short strings, not addresses: 32 bytes does not fit in one
    // field element, so these stay Poseidon images produced by the caller.
    signal input allowed_categories[MAX_CATEGORIES];
    signal input payment_category;

    // Fields the commitment covers that never leak through a public signal.
    signal input operator_id_field;
    signal input policy_id_field;

    // One salt per committed field, so the commitment can be opened one field
    // at a time. square#45.
    //
    // Without these the commitment is Poseidon over eight guessable values and
    // a "selective" disclosure discloses everything: an auditor handed seven
    // sibling leaves could brute-force them, because max_daily is published on
    // chain as PolicyRegistry.dailyLimit, the time field has under 150,000
    // possible values, and an empty list has a well-known image. That is
    // square#98, and it is the same defect.
    //
    // They are unconstrained here on purpose. Their only job is entropy, and
    // what pins them is the registry: a proof whose policy_data_hash does not
    // equal the commitment the institution registered is a proof about some
    // other policy. Changing a salt changes the commitment, which is the
    // binding.
    signal input policy_salts[8];

    // Time restriction. time_active = 0 means "no time gate"; the remaining
    // time fields are then free witnesses ignored by both the hash and the rule.
    signal input time_active;
    signal input time_days_bitmask;
    signal input time_start_hour_utc;
    signal input time_end_hour_utc;

    // ============================================================ Payment (public)
    // Wired straight to the public outputs below so the on-chain verifier can
    // read them off the proof and cross-check them against the job it is
    // gating. The prover must set them to the values the settlement actually
    // uses; the contract rejects the proof otherwise.
    signal input recipient_in;
    signal input amount_in;
    signal input token_in;
    signal input daily_spent_before_in;
    signal input current_unix_timestamp_in;

    // Stripe receipt commitment. Zero for a pure on-chain payment, a Poseidon
    // hash when a Stripe receipt is being claimed. The circuit mirrors it to a
    // public signal and does not constrain it further; Stripe is the trust root
    // on that path and the contract checks the attestation signature.
    signal input stripe_receipt_hash_in;

    // ============================================================ Public outputs
    signal output is_compliant;
    signal output policy_data_hash;
    signal output recipient;
    signal output amount;
    signal output token;
    signal output daily_spent_before;
    signal output current_unix_timestamp;
    signal output stripe_receipt_hash;

    recipient <== recipient_in;
    amount <== amount_in;
    token <== token_in;
    daily_spent_before <== daily_spent_before_in;
    current_unix_timestamp <== current_unix_timestamp_in;
    stripe_receipt_hash <== stripe_receipt_hash_in;

    // ============================================================ Amount bounds
    // LessEqThan(64) below is only meaningful for inputs under 2^64: circomlib's
    // comparator bounds the difference, not its operands, so a field element
    // near the modulus would otherwise slip through. daily_spent_before gets the
    // same treatment because rule 2 adds it to the amount.
    component amount_bits = Num2Bits(64);
    amount_bits.in <== amount;

    component daily_spent_bits = Num2Bits(64);
    daily_spent_bits.in <== daily_spent_before;

    // The ceilings are the other operand of the same two comparators, and they
    // were not bounded. square#119: a comparator bounds the difference of its
    // operands, so an unconstrained ceiling near the modulus makes rule 1 or
    // rule 2 answer about a value that is not the one it appears to be. The
    // direction is closed — the comparator can only reject wrongly, never
    // accept wrongly, so no proof of compliance came out of it — but the
    // invariant rules.js relies on ("the circuit range-checks both operands")
    // was simply not built, and everything else feeding these comparators is
    // bounded. PolicyRegistry.sol applies the same reasoning on chain, refusing
    // a dailyLimit above uint64 with LimitExceedsProofRange.
    component max_per_tx_bits = Num2Bits(64);
    max_per_tx_bits.in <== max_per_tx;

    component max_daily_bits = Num2Bits(64);
    max_daily_bits.in <== max_daily;

    // ============================================================ Lookup keys
    // The three values looked up in the policy lists must be non-zero, because
    // zero is what padding slots hold. This is what lets the mask arrays go: a
    // padding slot cannot match a key that is never zero, so marking slots
    // active was never doing any work — while leaving an uncommitted input that
    // could switch rule 4 off entirely.
    //
    // None of the three can legitimately be zero. `token` and `recipient` are
    // addresses the contract binds to a real token and a real provider, and
    // `payment_category` is a Poseidon image.
    component token_is_zero = IsZero();
    token_is_zero.in <== token;
    token_is_zero.out === 0;

    component recipient_is_zero = IsZero();
    recipient_is_zero.in <== recipient;
    recipient_is_zero.out === 0;

    component category_is_zero = IsZero();
    category_is_zero.in <== payment_category;
    category_is_zero.out === 0;

    // ============================================================ Window bounds
    // GreaterEqThan/LessEqThan below carry the same caveat as the amount
    // comparators: they bound the difference, not the operands. `hour` is
    // already constrained to 0..23 by UtcDayHourChecked; these two put the
    // policy's own bounds in range so the comparison cannot be steered by a
    // field element near the modulus. Five bits is more than the 0..23 an hour
    // can hold and keeps the check honest without pinning the exact range.
    component start_hour_bits = Num2Bits(5);
    start_hour_bits.in <== time_start_hour_utc;

    component end_hour_bits = Num2Bits(5);
    end_hour_bits.in <== time_end_hour_utc;

    // time_active gates rule 6 through `1 - time_active + time_active * x`,
    // which only behaves like a switch for a boolean.
    time_active * (time_active - 1) === 0;

    // ============================================================ Rule 1
    // amount <= max_per_tx
    component rule1 = LessEqThan(64);
    rule1.in[0] <== amount;
    rule1.in[1] <== max_per_tx;
    signal rule1_ok;
    rule1_ok <== rule1.out;

    // ============================================================ Rule 2
    // daily_spent_before + amount <= max_daily
    signal projected_daily;
    projected_daily <== daily_spent_before + amount;
    component rule2 = LessEqThan(65);
    rule2.in[0] <== projected_daily;
    rule2.in[1] <== max_daily;
    signal rule2_ok;
    rule2_ok <== rule2.out;

    // ============================================================ Rule 3
    // token matches at least one active whitelist entry.
    component whitelist_eq[MAX_WHITELIST];
    signal whitelist_hit[MAX_WHITELIST];
    signal whitelist_or[MAX_WHITELIST];
    for (var i = 0; i < MAX_WHITELIST; i++) {
        whitelist_eq[i] = IsEqual();
        whitelist_eq[i].in[0] <== token;
        whitelist_eq[i].in[1] <== token_whitelist[i];
        whitelist_hit[i] <== whitelist_eq[i].out;
    }
    whitelist_or[0] <== whitelist_hit[0];
    for (var i = 1; i < MAX_WHITELIST; i++) {
        whitelist_or[i] <==
            whitelist_or[i - 1] + whitelist_hit[i]
            - whitelist_or[i - 1] * whitelist_hit[i];
    }
    signal rule3_ok;
    rule3_ok <== whitelist_or[MAX_WHITELIST - 1];

    // ============================================================ Rule 4
    // recipient is NOT in the blocked list.
    component blocked_eq[MAX_BLOCKED];
    signal blocked_hit[MAX_BLOCKED];
    signal blocked_or[MAX_BLOCKED];
    for (var i = 0; i < MAX_BLOCKED; i++) {
        blocked_eq[i] = IsEqual();
        blocked_eq[i].in[0] <== recipient;
        blocked_eq[i].in[1] <== blocked_addresses[i];
        blocked_hit[i] <== blocked_eq[i].out;
    }
    blocked_or[0] <== blocked_hit[0];
    for (var i = 1; i < MAX_BLOCKED; i++) {
        blocked_or[i] <==
            blocked_or[i - 1] + blocked_hit[i]
            - blocked_or[i - 1] * blocked_hit[i];
    }
    signal rule4_ok;
    rule4_ok <== 1 - blocked_or[MAX_BLOCKED - 1];

    // ============================================================ Rule 5
    // payment_category matches an active allowed_categories entry.
    component category_eq[MAX_CATEGORIES];
    signal category_hit[MAX_CATEGORIES];
    signal category_or[MAX_CATEGORIES];
    for (var i = 0; i < MAX_CATEGORIES; i++) {
        category_eq[i] = IsEqual();
        category_eq[i].in[0] <== payment_category;
        category_eq[i].in[1] <== allowed_categories[i];
        category_hit[i] <== category_eq[i].out;
    }
    category_or[0] <== category_hit[0];
    for (var i = 1; i < MAX_CATEGORIES; i++) {
        category_or[i] <==
            category_or[i - 1] + category_hit[i]
            - category_or[i - 1] * category_hit[i];
    }
    signal rule5_ok;
    rule5_ok <== category_or[MAX_CATEGORIES - 1];

    // ============================================================ Rule 6
    // current_unix_timestamp falls inside the policy's allowed window when one
    // is configured. A free pass when time_active == 0.
    //
    // The decomposition is witnessed here and constrained in UtcDayHourChecked,
    // which is where the soundness argument lives.
    component clock = UtcDayHourChecked(40);
    clock.timestamp <== current_unix_timestamp;
    clock.day_index <-- current_unix_timestamp \ 86400;
    clock.sec_in_day <-- current_unix_timestamp % 86400;
    clock.hour <-- (current_unix_timestamp % 86400) \ 3600;
    clock.sec_in_hour <-- (current_unix_timestamp % 86400) % 3600;
    clock.weeks <-- ((current_unix_timestamp \ 86400) + 3) \ 7;
    clock.day_of_week <-- ((current_unix_timestamp \ 86400) + 3) % 7;

    signal hour;
    signal day_of_week;
    hour <== clock.hour_out;
    day_of_week <== clock.day_of_week_out;

    // Decompose days_bitmask into 7 bits so it can be indexed by day_of_week.
    // The accumulator equality forces the bits to be the unique decomposition
    // and the mask to be under 128.
    signal day_bits[7];
    signal day_bits_acc[8];
    day_bits_acc[0] <== 0;
    for (var i = 0; i < 7; i++) {
        day_bits[i] <-- (time_days_bitmask >> i) & 1;
        day_bits[i] * (day_bits[i] - 1) === 0;
        day_bits_acc[i + 1] <== day_bits_acc[i] + day_bits[i] * (1 << i);
    }
    day_bits_acc[7] === time_days_bitmask;

    // Select day_bits[day_of_week]. day_of_week is constrained to 0..6 above,
    // so exactly one term can be non-zero.
    component dow_eq[7];
    signal day_active_terms[7];
    signal day_active_acc[8];
    day_active_acc[0] <== 0;
    for (var i = 0; i < 7; i++) {
        dow_eq[i] = IsEqual();
        dow_eq[i].in[0] <== day_of_week;
        dow_eq[i].in[1] <== i;
        day_active_terms[i] <== dow_eq[i].out * day_bits[i];
        day_active_acc[i + 1] <== day_active_acc[i] + day_active_terms[i];
    }
    signal day_active;
    day_active <== day_active_acc[7];

    // hour_in_window = (hour >= start) AND (hour <= end). Assumes start <= end;
    // windows spanning midnight are not modelled, here or in the dashboard.
    component hour_ge_start = GreaterEqThan(8);
    hour_ge_start.in[0] <== hour;
    hour_ge_start.in[1] <== time_start_hour_utc;

    component hour_le_end = LessEqThan(8);
    hour_le_end.in[0] <== hour;
    hour_le_end.in[1] <== time_end_hour_utc;

    signal hour_in_window;
    hour_in_window <== hour_ge_start.out * hour_le_end.out;

    // rule6_ok = (1 - time_active) + time_active * (day_active * hour_in_window)
    signal time_compliant_when_active;
    time_compliant_when_active <== day_active * hour_in_window;
    signal rule6_ok;
    rule6_ok <== 1 - time_active + time_active * time_compliant_when_active;

    // ============================================================ Combine
    signal and_12;
    signal and_123;
    signal and_1234;
    signal and_12345;
    and_12 <== rule1_ok * rule2_ok;
    and_123 <== and_12 * rule3_ok;
    and_1234 <== and_123 * rule4_ok;
    and_12345 <== and_1234 * rule5_ok;
    is_compliant <== and_12345 * rule6_ok;

    // ============================================================ policy_data_hash
    // Must stay byte-identical to the policy service's commitment.
    //
    //   poseidon([
    //     max_daily,
    //     max_per_tx,
    //     operator_id_field,
    //     policy_id_field,
    //     poseidon(categories padded to MAX_CATEGORIES),
    //     poseidon(blocked padded to MAX_BLOCKED),
    //     poseidon(tokens padded to MAX_WHITELIST),
    //     time_field
    //   ])
    //
    // where time_field is 0 when no restriction is configured, otherwise
    // poseidon([1, days_bitmask, start_hour, end_hour]).
    //
    // The list entries feeding the three list hashes are now raw address field
    // elements rather than Poseidon images of high/low halves, so a commitment
    // produced by the Solana-era backend will not match this circuit. That is
    // expected: the whole public layout changed, and the ceremony has not run.
    component cat_list_hash = Poseidon(MAX_CATEGORIES);
    for (var i = 0; i < MAX_CATEGORIES; i++) {
        cat_list_hash.inputs[i] <== allowed_categories[i];
    }

    component blocked_list_hash = Poseidon(MAX_BLOCKED);
    for (var i = 0; i < MAX_BLOCKED; i++) {
        blocked_list_hash.inputs[i] <== blocked_addresses[i];
    }

    component tokens_list_hash = Poseidon(MAX_WHITELIST);
    for (var i = 0; i < MAX_WHITELIST; i++) {
        tokens_list_hash.inputs[i] <== token_whitelist[i];
    }

    // Computed unconditionally and muxed to 0 when the restriction is off, so
    // the result lines up with the backend's "0 sentinel for no restriction".
    component time_when_active = Poseidon(4);
    time_when_active.inputs[0] <== time_active;
    time_when_active.inputs[1] <== time_days_bitmask;
    time_when_active.inputs[2] <== time_start_hour_utc;
    time_when_active.inputs[3] <== time_end_hour_utc;
    signal time_field;
    time_field <== time_active * time_when_active.out;

    // ==================================================== The policy commitment
    //
    // Eight leaves, one per committed field, and the root is the value the
    // registry holds and the hook compares. square#45.
    //
    //   leaf[i] = Poseidon(3)(i, policy_salts[i], value[i])
    //   root    = Poseidon(8)(leaf[0] .. leaf[7])
    //
    // The shape is deliberate. The root is still a single Poseidon(8), so it is
    // the same kind of value the registry already stores and the same public
    // signal 1 the verifier already reads — no interface moved. What changed is
    // that it is now openable one field at a time: disclose (i, value, salt) and
    // the seven sibling leaves, and anybody can recompute the root and check it
    // against the chain, learning nothing about the other seven values because
    // each sits behind its own salt.
    //
    // The index goes in as the first input, so a leaf cannot be replayed in
    // another position. Aperture's tree sorted each pair before hashing, which
    // throws that away, and hashed leaves and internal nodes the same way, which
    // lets an internal node be presented as a leaf. Neither applies here: there
    // is one level, the position is inside the leaf, and a leaf is a Poseidon(3)
    // while the root is a Poseidon(8).
    signal policy_values[8];
    policy_values[0] <== max_daily;
    policy_values[1] <== max_per_tx;
    policy_values[2] <== operator_id_field;
    policy_values[3] <== policy_id_field;
    policy_values[4] <== cat_list_hash.out;
    policy_values[5] <== blocked_list_hash.out;
    policy_values[6] <== tokens_list_hash.out;
    policy_values[7] <== time_field;

    component policy_leaf[8];
    component policy_hasher = Poseidon(8);
    for (var i = 0; i < 8; i++) {
        policy_leaf[i] = Poseidon(3);
        policy_leaf[i].inputs[0] <== i;
        policy_leaf[i].inputs[1] <== policy_salts[i];
        policy_leaf[i].inputs[2] <== policy_values[i];
        policy_hasher.inputs[i] <== policy_leaf[i].out;
    }
    policy_data_hash <== policy_hasher.out;
}

// MAX_WHITELIST = 10, MAX_BLOCKED = 10, MAX_CATEGORIES = 8 — these must match
// the constants in the prover service and the policy service. Changing any of
// them is a breaking circuit change: it needs a new trusted setup and a new
// on-chain verifying key.
component main = PaymentCompliance(10, 10, 8);
