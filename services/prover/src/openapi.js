// Minimal OpenAPI 3.0 spec describing the HTTP surface this service exposes.
// Returned verbatim from GET /api-docs.json. Kept inline (no codegen) because
// the API is tiny — two endpoints.
//
// The spec inherited from aperture had drifted away from its implementation and
// was rewritten against the code in #4. #18 then re-parameterised the service
// for EVM, which changed the wire format again:
//
//   - Amount fields lost the `lamports` suffix. They are USDC base units at 6
//     decimals now, and the circuit range-checks them to 64 bits — see
//     docs/decisions/erc20-vs-native-usdc.md.
//   - `payment_token_mint` became `payment_token`, and every address field
//     takes a 20-byte EVM address instead of a base58 Solana pubkey.
//   - `public_signals` carries eight entries rather than ten: an EVM address
//     fits in one field element, so the high/low halves collapsed.
//   - `groth16`, `proof_hash` and `receipt_bytes` are gone. They encoded a
//     proof for groth16-solana; `solidity` replaces them with the arguments the
//     on-chain verifier actually takes.
export const openapiSpec = {
  openapi: '3.0.3',
  info: {
    title: 'Square Prover',
    version: '0.1.0',
    description:
      'Generates Groth16 zero-knowledge proofs for the payment-compliance circuit ' +
      '(Circom + snarkjs). On a non-compliant payment the response names the rules ' +
      'that failed; no private policy value is logged or returned.',
  },
  paths: {
    '/health': {
      get: {
        summary: 'Liveness probe',
        tags: ['Meta'],
        responses: {
          200: {
            description: 'Service is up',
            content: { 'application/json': { schema: { $ref: '#/components/schemas/Health' } } },
          },
        },
      },
    },
    '/prove': {
      post: {
        summary: 'Generate a payment compliance Groth16 proof',
        description:
          'Always returns 200 with a proof when the witness is well formed, whether or ' +
          'not the payment is compliant — the circuit proves that the check was ' +
          'performed, not that the outcome was positive. Inspect `is_compliant` and, ' +
          'when it is false, `violated_rules`.',
        tags: ['Proving'],
        requestBody: {
          required: true,
          content: {
            'application/json': { schema: { $ref: '#/components/schemas/ProveRequest' } },
          },
        },
        responses: {
          200: {
            description: 'Proof generated',
            content: {
              'application/json': { schema: { $ref: '#/components/schemas/ProveResponse' } },
            },
          },
          400: {
            description:
              'The request was refused before any proving started: a required field ' +
              'is missing, a list is not a list, or a time restriction is out of range. ' +
              'The message names the offending field but never its value. Retrying an ' +
              'unchanged request will not help.',
            content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } },
          },
          500: {
            description:
              'The prover failed after accepting the request — hashing, witness ' +
              'generation or the proving system. The message names the offending field ' +
              'but never its value, so it is safe to surface and to log.',
            content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } },
          },
          503: {
            description:
              'The service is already proving as many payments as it will run at once ' +
              'and its waiting room is full, so this request was refused rather than ' +
              'queued behind an unbounded backlog. `Retry-After` carries the number of ' +
              'seconds to wait, and the same request will be accepted once there is ' +
              'room. See PROVER_MAX_CONCURRENCY and PROVER_MAX_QUEUE.',
            headers: {
              'Retry-After': {
                description: 'Seconds to wait before retrying.',
                schema: { type: 'integer' },
              },
            },
            content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } },
          },
          504: {
            description:
              'The proof outran the time this service will spend on one request ' +
              '(PROVER_PROOF_TIMEOUT_MS). The slot is freed for the next caller. ' +
              'Retrying may succeed on a less loaded service.',
            content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } },
          },
        },
      },
    },
  },
  components: {
    schemas: {
      Health: {
        type: 'object',
        properties: {
          status: { type: 'string', example: 'healthy' },
          service: { type: 'string', example: 'square-prover' },
          version: { type: 'string', example: '0.1.0' },
          backend: { type: 'string', example: 'circom+snarkjs' },
        },
      },
      TimeRestriction: {
        type: 'object',
        description:
          'Optional window the payment must fall inside. Exactly one entry: the commitment '
          + 'covers a single window, so a second one could not be proved and is refused with '
          + '400 rather than accepted and dropped. '
          + 'The three fields below are required when a restriction is given: there are no '
          + 'defaults, because a missing day list means every weekday forbidden and missing '
          + 'hours mean a window of 00:00 to 00:59, and neither is what an omission means. '
          + 'The window cannot cross midnight: allowed_hours_start must not be later than '
          + 'allowed_hours_end, and a window like 22 to 6 is refused with 400 rather than '
          + 'accepted as one that no hour satisfies. Express an overnight window as two '
          + 'policies. The 0..23 bounds below are enforced by the service, not only '
          + 'declared here.',
        required: ['allowed_days', 'allowed_hours_start', 'allowed_hours_end'],
        properties: {
          allowed_days: {
            type: 'array',
            minItems: 1,
            description:
              'At least one day. An empty list forbids every weekday, so no payment could '
              + 'satisfy the rule; omit time_restrictions entirely to leave the window '
              + 'unrestricted. Enforced by the service, not only declared here.',
            items: { type: 'string', enum: [
              'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday',
            ] },
          },
          allowed_hours_start: { type: 'integer', minimum: 0, maximum: 23 },
          allowed_hours_end: { type: 'integer', minimum: 0, maximum: 23 },
          timezone: { type: 'string', enum: ['UTC'], default: 'UTC' },
        },
      },
      ProveRequest: {
        type: 'object',
        required: [
          'policy_id',
          'policy_salt',
          'operator_id',
          'max_daily_spend',
          'max_per_transaction',
          'allowed_endpoint_categories',
          'blocked_addresses',
          'token_whitelist',
          'payment_amount',
          'payment_token',
          'payment_recipient',
          'payment_endpoint_category',
          'daily_spent_before',
          'current_unix_timestamp',
        ],
        properties: {
          policy_id: { type: 'string', format: 'uuid' },
          policy_salt: {
            type: 'string',
            description:
              'The secret the eight leaf salts derive from, as a decimal field element. '
              + 'Kept with the policy and reused on every proof of it: a different salt is '
              + 'a different commitment, and the registry holds one. It is the operator\'s '
              + 'secret — disclosing one leaf salt discloses that leaf and no other, but '
              + 'disclosing this one discloses all eight, and two of the committed values '
              + '(the per-transaction and daily ceilings) are round USDC amounts that a '
              + 'dictionary opens once the salts are known. '
              + 'GENERATE IT, NEVER COPY ONE: read 32 cryptographically random bytes, read '
              + 'them as a big-endian integer, and reduce modulo '
              + '21888242871839275222246405745257275088548364400416034343698204186575808495617 '
              + '(the BN254 scalar field). That is all randomPolicySalt() in '
              + 'src/commitment.js does, and it needs no server code: in any language it is '
              + 'a random-bytes call and one modulo. The service refuses a value below 2^128, '
              + 'which catches 0, 1 and the other degenerate ones; it cannot catch a large '
              + 'number somebody chose by hand, so the randomness is the caller\'s to get right.',
            // Deliberately not a value. An `example` is what a generated client
            // and a "Try it" console put in the box, so it is the value an
            // integrator copies -- and this field's whole contract is that it is
            // a secret nobody else has. The previous example was sixty-one
            // sevens; measured, it opens a 25 USDC ceiling in 24 050 tries,
            // because a published example is in every attacker's guess list.
            // A placeholder fails validation loudly instead.
            example: 'GENERATE-32-RANDOM-BYTES-DO-NOT-COPY-THIS',
          },
          operator_id: { type: 'string', description: '20-byte EVM address, 0x-prefixed.' },
          max_daily_spend: {
            type: 'string',
            description: 'USDC base units, 6 decimals. Must be under 2^64.',
          },
          max_per_transaction: {
            type: 'string',
            description: 'USDC base units, 6 decimals. Must be under 2^64.',
          },
          allowed_endpoint_categories: {
            type: 'array', items: { type: 'string', maxLength: 32 }, maxItems: 8,
          },
          blocked_addresses: {
            type: 'array', maxItems: 10,
            items: { type: 'string', description: '20-byte EVM address.' },
          },
          token_whitelist: {
            type: 'array', maxItems: 10,
            items: { type: 'string', description: '20-byte EVM address.' },
          },
          payment_amount: {
            type: 'string',
            description: 'USDC base units, 6 decimals. Must be under 2^64.',
          },
          payment_token: { type: 'string', description: '20-byte EVM address.' },
          payment_recipient: { type: 'string', description: '20-byte EVM address.' },
          payment_endpoint_category: { type: 'string', maxLength: 32 },
          daily_spent_before: {
            type: 'string',
            description: 'USDC base units, 6 decimals. Must be under 2^64.',
          },
          current_unix_timestamp: { type: 'string', description: 'Seconds since the epoch.' },
          stripe_receipt_hash: {
            type: 'string',
            default: '0',
            description: 'Poseidon receipt commitment for the Stripe path; 0 otherwise.',
          },
          time_restrictions: {
            type: 'array',
            items: { $ref: '#/components/schemas/TimeRestriction' },
            maxItems: 1,
            description:
              'maxItems was declared here from the start and enforced nowhere: a second entry '
              + 'was validated field by field and then dropped by the builder, which reads only '
              + 'the first. square#181 made the service enforce what this schema says.',
          },
        },
      },
      ProveResponse: {
        type: 'object',
        properties: {
          is_compliant: { type: 'boolean' },
          violated_rules: {
            type: 'array',
            nullable: true,
            items: {
              type: 'string',
              enum: [
                'per_transaction_limit',
                'daily_limit',
                'token_whitelist',
                'blocked_recipient',
                'endpoint_category',
                'time_window',
              ],
            },
            description:
              'Names of the rules that failed; empty when compliant. Null when the ' +
              'circuit and the off-circuit evaluator disagreed, in which case no rule ' +
              'name can be trusted for this request.',
          },
          policy_data_hash: { type: 'string', description: 'Poseidon commitment, decimal.' },
          policy_data_hash_hex: { type: 'string', description: 'Same value, 32-byte hex.' },
          public_signals: {
            type: 'object',
            description:
              'The eight public signals, keyed by name in circuit output order: '
              + 'is_compliant, policy_data_hash, recipient, amount, token, '
              + 'daily_spent_before, current_unix_timestamp, stripe_receipt_hash.',
          },
          solidity: {
            type: 'object',
            description:
              'Arguments for the on-chain verifier\'s '
              + 'verifyProof(uint[2] a, uint[2][2] b, uint[2] c, uint[8] input), '
              + 'as 32-byte hex strings.',
            properties: {
              a: { type: 'array', items: { type: 'string' }, minItems: 2, maxItems: 2 },
              b: { type: 'array', items: { type: 'array', items: { type: 'string' } } },
              c: { type: 'array', items: { type: 'string' }, minItems: 2, maxItems: 2 },
              input: { type: 'array', items: { type: 'string' }, minItems: 8, maxItems: 8 },
            },
          },
          raw_proof: { type: 'object', description: 'Original snarkjs proof object.' },
          raw_public: { type: 'array', items: { type: 'string' } },
          verification_timestamp: { type: 'string', format: 'date-time' },
          proving_time_ms: { type: 'integer' },
        },
      },
      Error: {
        type: 'object',
        properties: { error: { type: 'string' } },
      },
    },
  },
};
