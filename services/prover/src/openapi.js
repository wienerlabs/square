// Minimal OpenAPI 3.0 spec describing the HTTP surface this service exposes.
// Returned verbatim from GET /api-docs.json. Kept inline (no codegen) because
// the API is tiny — two endpoints.
//
// The spec inherited from aperture had drifted away from the implementation: it
// named `daily_spent_so_far_lamports` where the code reads
// `daily_spent_before_lamports`, omitted `policy_id`, `operator_id`,
// `current_unix_timestamp`, `time_restrictions` and `stripe_receipt_hash`
// entirely, and still advertised `journal_digest`, `amount_range_min`,
// `amount_range_max` and `image_id` — response fields left over from the RISC
// Zero prover that the Circom implementation never produced. It is rewritten
// here against the code rather than carried forward.
export const openapiSpec = {
  openapi: '3.0.3',
  info: {
    title: 'Mandate Prover',
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
          service: { type: 'string', example: 'mandate-prover' },
          version: { type: 'string', example: '0.1.0' },
          backend: { type: 'string', example: 'circom+snarkjs' },
        },
      },
      TimeRestriction: {
        type: 'object',
        description:
          'Optional window the payment must fall inside. Only the first entry is read.',
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
          'operator_id',
          'max_daily_spend_lamports',
          'max_per_transaction_lamports',
          'allowed_endpoint_categories',
          'blocked_addresses',
          'token_whitelist',
          'payment_amount_lamports',
          'payment_token_mint',
          'payment_recipient',
          'payment_endpoint_category',
          'daily_spent_before_lamports',
          'current_unix_timestamp',
        ],
        properties: {
          policy_id: { type: 'string', format: 'uuid' },
          operator_id: { type: 'string', description: 'Base58 32-byte operator key.' },
          max_daily_spend_lamports: { type: 'string', description: 'Non-negative integer.' },
          max_per_transaction_lamports: { type: 'string', description: 'Non-negative integer.' },
          allowed_endpoint_categories: {
            type: 'array', items: { type: 'string', maxLength: 32 }, maxItems: 8,
          },
          blocked_addresses: { type: 'array', items: { type: 'string' }, maxItems: 10 },
          token_whitelist: { type: 'array', items: { type: 'string' }, maxItems: 10 },
          payment_amount_lamports: { type: 'string', description: 'Non-negative integer.' },
          payment_token_mint: { type: 'string' },
          payment_recipient: { type: 'string' },
          payment_endpoint_category: { type: 'string', maxLength: 32 },
          daily_spent_before_lamports: { type: 'string', description: 'Non-negative integer.' },
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
            description: 'The ten public signals, keyed by name in circuit output order.',
          },
          groth16: {
            type: 'object',
            properties: {
              proof_a: { type: 'string', description: '64-byte G1 point, base64 (Y-negated).' },
              proof_b: { type: 'string', description: '128-byte G2 point, base64 (Fp2 reversed).' },
              proof_c: { type: 'string', description: '64-byte G1 point, base64.' },
              public_inputs: { type: 'array', items: { type: 'string' } },
            },
          },
          raw_proof: { type: 'object', description: 'Original snarkjs proof object.' },
          raw_public: { type: 'array', items: { type: 'string' } },
          proof_hash: { type: 'string', description: 'Alias of policy_data_hash_hex.' },
          verification_timestamp: { type: 'string', format: 'date-time' },
          receipt_bytes: { type: 'array', items: { type: 'integer' } },
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
