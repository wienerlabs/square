// The violation log was not the only path that printed private policy.
//
// Errors raised while building the witness travel to the same log line and to
// the HTTP response body. Several of them used to embed the offending value:
// a malformed blocked address was echoed verbatim, an over-long endpoint
// category was echoed verbatim, and `BigInt("abc")` throws
// `Cannot convert abc to a BigInt` — which put a malformed spending ceiling in
// the log the same way the violation path put the whole body there.
//
// These tests hold every error message this service can raise about request
// content to the same rule: name the field, never the value.

import { describe, it, expect } from 'vitest';
import { buildCircuitInput } from '../src/prover.js';
import { toFieldString, toIdentifier } from '../src/normalize.js';
import { hashCategory, addressToField, padAddressList } from '../src/hash.js';

const address = (nibble) => `0x${String(nibble).repeat(40)}`;

const VALID = {
  policy_id: '3f2504e0-4f89-11d3-9a0c-0305e82c3301',
  // square#45: the secret the eight leaf salts derive from.
  policy_salt: '7777777777777777777777777777777777777777777777777777777777777',
  operator_id: address(3),
  max_daily_spend: '100000000',
  max_per_transaction: '10000000',
  allowed_endpoint_categories: ['api-call'],
  blocked_addresses: [address(2)],
  token_whitelist: [address(4)],
  payment_amount: '5000000',
  payment_token: address(4),
  payment_recipient: address(1),
  payment_endpoint_category: 'api-call',
  daily_spent_before: '50000000',
  current_unix_timestamp: '1788356730',
};

function requestWith(overrides) {
  return { ...VALID, ...overrides };
}

async function messageFor(promise) {
  try {
    await promise;
  } catch (error) {
    return error.message;
  }
  throw new Error('expected the call to reject, it resolved');
}

describe('error messages name the field, never the value', () => {
  it('a malformed blocked address does not echo the address', async () => {
    const secret = '0xNOT-A-REAL-ADDRESS-AT-ALL';
    const message = await messageFor(
      buildCircuitInput(requestWith({ blocked_addresses: [secret] })),
    );
    expect(message).not.toContain(secret);
    expect(message).toContain('blocked_addresses');
  });

  it('a wrong-length blocked address does not echo the address', async () => {
    const short = '0xdeadbeef';
    const message = await messageFor(
      buildCircuitInput(requestWith({ blocked_addresses: [short] })),
    );
    expect(message).not.toContain(short);
    expect(message).toContain('blocked_addresses');
  });

  it('a malformed whitelisted token does not echo it', async () => {
    const secret = '0x00000000000000000000000000000000000000';
    const message = await messageFor(
      buildCircuitInput(requestWith({ token_whitelist: [secret] })),
    );
    expect(message).not.toContain(secret);
    expect(message).toContain('token_whitelist');
  });

  it('an over-long endpoint category does not echo the category', async () => {
    const secret = 'a-very-long-secret-category-name-that-exceeds-the-limit';
    const message = await messageFor(
      buildCircuitInput(requestWith({ allowed_endpoint_categories: [secret] })),
    );
    expect(message).not.toContain(secret);
    expect(message).toContain('allowed_endpoint_categories');
  });

  it('a non-numeric daily ceiling does not echo the ceiling', async () => {
    const secret = 'ceiling-is-987654321';
    const message = await messageFor(
      buildCircuitInput(requestWith({ max_daily_spend: secret })),
    );
    expect(message).not.toContain(secret);
    expect(message).toContain('max_daily_spend');
  });

  it('a non-numeric per-transaction ceiling does not echo the ceiling', async () => {
    const secret = '12_345_678';
    const message = await messageFor(
      buildCircuitInput(requestWith({ max_per_transaction: secret })),
    );
    expect(message).not.toContain(secret);
    expect(message).toContain('max_per_transaction');
  });

  it('an unknown weekday does not echo the day names', async () => {
    const message = await messageFor(
      buildCircuitInput(requestWith({
        time_restrictions: [{ allowed_days: ['caturday'], allowed_hours_start: 9, allowed_hours_end: 17 }],
      })),
    );
    expect(message).not.toContain('caturday');
    expect(message).toContain('allowed_days');
  });

  it('an over-long list reports the ceiling but not how many entries were sent', async () => {
    const blocked = Array.from({ length: 12 }, (_, i) => `0x${String(i % 10).repeat(40)}`);
    const message = await messageFor(
      buildCircuitInput(requestWith({ blocked_addresses: blocked })),
    );
    // List cardinality is part of the policy the circuit hides, so "12" must
    // not appear; the circuit's own maximum, 10, is public and may.
    expect(message).not.toContain('12');
    expect(message).toContain('10');
    expect(message).toContain('blocked_addresses');
  });

  it('a missing field names the field only', async () => {
    const request = requestWith({});
    delete request.max_daily_spend;
    const message = await messageFor(buildCircuitInput(request));
    expect(message).toContain('max_daily_spend');
  });
});

describe('normalize', () => {
  it('rejects a float rather than truncating a ceiling', () => {
    expect(() => toFieldString(1.5, 'max_daily_spend')).toThrow(/whole number/);
  });

  it('rejects a number that has already lost precision', () => {
    expect(() => toFieldString(2 ** 53 + 1, 'max_daily_spend'))
      .toThrow(/safe integer range/);
  });

  it('rejects a negative value', () => {
    const message = (() => {
      try { toFieldString('-1', 'payment_amount'); return ''; }
      catch (e) { return e.message; }
    })();
    expect(message).not.toContain('-1');
    expect(message).toContain('payment_amount');
  });

  it('rejects a value at or above the BN254 scalar field modulus', () => {
    const r = '21888242871839275222246405745257275088548364400416034343698204186575808495617';
    const message = (() => {
      try { toFieldString(r, 'payment_amount'); return ''; }
      catch (e) { return e.message; }
    })();
    expect(message).not.toContain(r);
    expect(message).toContain('BN254');
  });

  it('accepts strings, safe numbers and bigints alike', () => {
    expect(toFieldString('42', 'x')).toBe('42');
    expect(toFieldString(42, 'x')).toBe('42');
    expect(toFieldString(42n, 'x')).toBe('42');
    expect(toFieldString(' 42 ', 'x')).toBe('42');
  });

  it('refuses a non-string identifier', () => {
    expect(() => toIdentifier({ id: 'x' }, 'operator_id')).toThrow(/must be a string/);
  });
});

describe('hash helpers carry the label, not the value', () => {
  it('addressToField reports the label on a malformed address', () => {
    expect(() => addressToField('0xnope', 'blocked_addresses'))
      .toThrow(/^blocked_addresses: must be a 20-byte hex address$/);
  });

  it('hashCategory reports the label on an over-long category', async () => {
    await expect(hashCategory('x'.repeat(33), 'allowed_endpoint_categories'))
      .rejects.toThrow(/^allowed_endpoint_categories: exceeds the 32-byte limit$/);
  });

  it('padAddressList reports the label and the circuit maximum', () => {
    const addresses = Array.from({ length: 11 }, (_, i) => `0x${String(i % 10).repeat(40)}`);
    expect(() => padAddressList(addresses, 10, 'token_whitelist'))
      .toThrow(/^token_whitelist: exceeds the circuit maximum of 10 entries$/);
  });
});
