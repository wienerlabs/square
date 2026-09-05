pragma circom 2.0.0;

include "circomlib/circuits/comparators.circom";

// The vulnerable decomposition, kept as a control. DO NOT USE IN PRODUCTION.
//
// This reproduces exactly what payment.circom carried before mandate#14: the
// division identities and the remainder checks, with no upper bound on the
// quotients. It exists so the negative test can show that the forged weekday it
// feeds is accepted here and rejected by the fixed template. Without that
// control a failing test proves nothing — it could be failing for any reason.
//
// The interface matches UtcDayHourChecked so one test can drive both.
template UtcDayHourUnchecked() {
    signal input timestamp;
    signal input day_index;
    signal input sec_in_day;
    signal input hour;
    signal input sec_in_hour;
    signal input weeks;
    signal input day_of_week;

    signal output hour_out;
    signal output day_of_week_out;

    // Remainder bounded, quotient not. circomlib's LessThan constrains
    // in[0] + 2^n - in[1] to n+1 bits, which does not bound in[0] on its own,
    // so a field element just below the modulus satisfies it too.
    component lt_sec_in_day = LessThan(20);
    lt_sec_in_day.in[0] <== sec_in_day;
    lt_sec_in_day.in[1] <== 86400;
    lt_sec_in_day.out === 1;

    day_index * 86400 + sec_in_day === timestamp;

    component lt_sec_in_hour = LessThan(15);
    lt_sec_in_hour.in[0] <== sec_in_hour;
    lt_sec_in_hour.in[1] <== 3600;
    lt_sec_in_hour.out === 1;

    component lt_hour = LessThan(5);
    lt_hour.in[0] <== hour;
    lt_hour.in[1] <== 24;
    lt_hour.out === 1;

    hour * 3600 + sec_in_hour === sec_in_day;

    // The hole. `weeks` is unbounded, and 7 is invertible in the field, so for
    // any day_index a prover can solve weeks = (day_index + 3 - d) / 7 for the
    // weekday d of their choosing and this identity still holds.
    component lt_dow = LessThan(4);
    lt_dow.in[0] <== day_of_week;
    lt_dow.in[1] <== 7;
    lt_dow.out === 1;

    weeks * 7 + day_of_week === day_index + 3;

    hour_out <== hour;
    day_of_week_out <== day_of_week;
}

component main = UtcDayHourUnchecked();
