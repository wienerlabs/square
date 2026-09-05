pragma circom 2.0.0;

include "circomlib/circuits/bitify.circom";
include "circomlib/circuits/comparators.circom";

// Decompose a Unix timestamp into a UTC hour and weekday, soundly.
//
// WHY THIS TEMPLATE EXISTS
//
// The original version of this decomposition lived inline in payment.circom and
// was under-constrained. It witnessed the quotients and checked only the
// division identities and the remainders:
//
//     day_index   <-- timestamp \ 86400;
//     sec_in_day  <-- timestamp - day_index * 86400;
//     day_index * 86400 + sec_in_day === timestamp;
//     LessThan(20)(sec_in_day, 86400) === 1;
//
//     weeks       <-- (day_index + 3) \ 7;
//     day_of_week <-- (day_index + 3) - weeks * 7;
//     weeks * 7 + day_of_week === day_index + 3;
//     LessThan(4)(day_of_week, 7) === 1;
//
// Nothing there bounds `day_index` or `weeks` from above, and circomlib's
// LessThan(n) does not bound its own input: it constrains
// `in[0] + 2^n - in[1]` to n+1 bits, which a field element just below the
// modulus also satisfies. So a prover writing a witness by hand — not using the
// generated witness calculator, which computes honestly — could pick any
// `day_of_week` in 0..6 and solve `weeks = (day_index + 3 - day_of_week) / 7`
// in the field, since 7 is invertible. The weekday half of the time-window rule
// enforced nothing at all.
//
// THE FIX
//
// Bound every quotient from above as well as every remainder, with all
// intermediate products kept far below the field modulus so the division
// identities hold over the integers rather than modulo p. Once that is true,
// each decomposition is unique and the prover has no freedom left.
//
// The witnessed values are inputs rather than internal `<--` assignments so the
// same constraint set can be driven directly by a test. payment.circom computes
// them; circuits/test/circuits/timestamp_checked.circom feeds them by hand and
// asserts a forged weekday is rejected.
//
// TS_BITS bounds the timestamp. 40 bits reaches the year 36812, which is ample,
// and keeps day_index under 2^24 so nothing here comes close to wrapping.
template UtcDayHourChecked(TS_BITS) {
    // 86400 < 2^17 and 2^16 < 86400, so a TS_BITS-bit timestamp yields a
    // day index of at most TS_BITS-16 bits.
    var DAY_BITS = TS_BITS - 16;

    signal input timestamp;

    // Witnessed decomposition, supplied by the caller.
    signal input day_index;
    signal input sec_in_day;
    signal input hour;
    signal input sec_in_hour;
    signal input weeks;
    signal input day_of_week;

    signal output hour_out;
    signal output day_of_week_out;

    // ---------------------------------------------------------------- bounds
    // Each Num2Bits below is the part the original was missing. Without them
    // the identities further down hold modulo p and admit forged solutions.

    component ts_bits = Num2Bits(TS_BITS);
    ts_bits.in <== timestamp;

    component day_index_bits = Num2Bits(DAY_BITS);
    day_index_bits.in <== day_index;

    // 86400 < 2^17
    component sec_in_day_bits = Num2Bits(17);
    sec_in_day_bits.in <== sec_in_day;

    // 24 < 2^5
    component hour_bits = Num2Bits(5);
    hour_bits.in <== hour;

    // 3600 < 2^12
    component sec_in_hour_bits = Num2Bits(12);
    sec_in_hour_bits.in <== sec_in_hour;

    // weeks <= (day_index + 3) / 7 < 2^DAY_BITS
    component weeks_bits = Num2Bits(DAY_BITS);
    weeks_bits.in <== weeks;

    // 7 < 2^3
    component day_of_week_bits = Num2Bits(3);
    day_of_week_bits.in <== day_of_week;

    // ------------------------------------------------------- day of the epoch
    // With day_index < 2^DAY_BITS and sec_in_day < 2^17, the product and the sum
    // stay far below the modulus, so this is integer arithmetic and the pair is
    // the unique quotient and remainder.
    component sec_in_day_lt = LessThan(17);
    sec_in_day_lt.in[0] <== sec_in_day;
    sec_in_day_lt.in[1] <== 86400;
    sec_in_day_lt.out === 1;

    day_index * 86400 + sec_in_day === timestamp;

    // ------------------------------------------------------------------ hour
    component sec_in_hour_lt = LessThan(12);
    sec_in_hour_lt.in[0] <== sec_in_hour;
    sec_in_hour_lt.in[1] <== 3600;
    sec_in_hour_lt.out === 1;

    component hour_lt = LessThan(5);
    hour_lt.in[0] <== hour;
    hour_lt.in[1] <== 24;
    hour_lt.out === 1;

    hour * 3600 + sec_in_hour === sec_in_day;

    // ----------------------------------------------------------- day of week
    // 1970-01-01 was a Thursday. The dashboard's weekday constants run Mon=0..
    // Sun=6, which puts Thursday at 3, hence the +3 shift.
    component day_of_week_lt = LessThan(3);
    day_of_week_lt.in[0] <== day_of_week;
    day_of_week_lt.in[1] <== 7;
    day_of_week_lt.out === 1;

    weeks * 7 + day_of_week === day_index + 3;

    hour_out <== hour;
    day_of_week_out <== day_of_week;
}
