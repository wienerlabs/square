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
          500: {
            description:
              'Prover error. The message names the offending field but never its ' +
              'value, so it is safe to surface and to log.',
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
          'Optional window the payment must fall inside. Only the first entry is read. '
          + 'The three fields below are required when a restriction is given: there are no '
          + 'defaults, because a missing day list means every weekday forbidden and missing '
          + 'hours mean a window of 00:00 to 00:59, and neither is what an omission means.',
        required: ['allowed_days', 'allowed_hours_start', 'allowed_hours_end'],
        properties: {
          allowed_days: {
            type: 'array',
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
              + 'a different commitment, and the registry holds one. Generate with '
              + 'randomPolicySalt() from src/commitment.js. It is the operator\'s secret — '
              + 'disclosing one leaf salt discloses that leaf and no other, but disclosing '
              + 'this one discloses all eight.',
            example: '7777777777777777777777777777777777777777777777777777777777777',
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
            type: 'array', items: { $ref: '#/components/schemas/TimeRestriction' }, maxItems: 1,
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
