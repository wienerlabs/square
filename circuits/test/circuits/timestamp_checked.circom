pragma circom 2.0.0;

include "../../lib/timestamp.circom";

// The real constraint set from lib/timestamp.circom, driven directly.
//
// payment.circom witnesses the decomposition honestly, so its generated witness
// calculator can never attempt a forgery. Exposing the same template with the
// witnessed values as inputs is what lets a test hand it a forged weekday and
// watch the constraints reject it. The template is the one payment.circom uses,
// not a copy, so the test cannot drift away from what ships.
component main = UtcDayHourChecked(40);
