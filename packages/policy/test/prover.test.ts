import { createServer, type Server } from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createProverClient, ProverError, proveRequest } from "../src/prover.js";
import { MIN_POLICY_SALT, parsePolicy } from "../src/policy.js";

const OPERATOR = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8" as const;
const USDC = "0x5FbDB2315678afecb367f032d93F642f64180aa3" as const;
const policy = parsePolicy({
  policy_id: "6f1c2a7e-3b1d-4c5e-9a8b-0c1d2e3f4a5b",
  policy_salt: (MIN_POLICY_SALT + 1n).toString(),
  operator_id: OPERATOR,
  max_daily_spend: "100000",
  max_per_transaction: "50000",
  allowed_endpoint_categories: ["api-call"],
  blocked_addresses: [],
  token_whitelist: [USDC],
});

/** A prover that answers by the path of the request's category, so each case picks its own reply. */
let server: Server;
let url: string;
const received: unknown[] = [];
beforeAll(async () => {
  server = createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      const request = JSON.parse(body) as { payment_endpoint_category: string };
      received.push(request);
      const reply = (status: number, text: string, type = "application/json") => {
        res.writeHead(status, { "content-type": type });
        res.end(text);
      };
      switch (request.payment_endpoint_category) {
        case "refuse":
          return reply(400, JSON.stringify({ error: "policy_salt: must be at least 2^128" }));
        case "html":
          return reply(502, "<html>Bad Gateway</html>", "text/html");
        case "empty":
          return reply(200, JSON.stringify({ ok: true }));
        case "slow":
          return setTimeout(() => reply(200, "{}"), 500);
        default:
          return reply(
            200,
            JSON.stringify({
              is_compliant: true,
              violated_rules: [],
              policy_data_hash: "1",
              policy_data_hash_hex: `0x${"0".repeat(63)}1`,
              public_signals: {},
              solidity: { a: ["1", "2"], b: [["3", "4"], ["5", "6"]], c: ["7", "8"], input: ["1", "1", "1", "1", "1", "0", "1", "0"] },
            }),
          );
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as { port: number };
  url = `http://127.0.0.1:${address.port}/`;
});
afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

const payment = (category: string) => ({ recipient: OPERATOR, amount: 10n, token: USDC, category, dailySpentBefore: 0n, timestamp: 1_800_000_000n });

describe("createProverClient", () => {
  it("posts the policy and the payment as the prover's request, and hands back the proof", async () => {
    const prover = createProverClient({ url });
    const response = await prover.prove(proveRequest(policy, payment("api-call")));
    expect(response.is_compliant).toBe(true);
    expect(response.solidity.input).toHaveLength(8);
    expect(received.at(-1)).toMatchObject({ policy_id: policy.policy_id, policy_salt: policy.policy_salt, payment_amount: "10", payment_recipient: OPERATOR, current_unix_timestamp: "1800000000", daily_spent_before: "0" });
  });

  it("carries the prover's refusal, with its status and its message", async () => {
    const prover = createProverClient({ url });
    await expect(prover.prove(proveRequest(policy, payment("refuse")))).rejects.toMatchObject({ name: "ProverError", status: 400, message: /refused the request \(400\): policy_salt: must be at least 2\^128/ });
  });

  it("says when the answer is not JSON, and when it is JSON without a proof", async () => {
    const prover = createProverClient({ url });
    await expect(prover.prove(proveRequest(policy, payment("html")))).rejects.toThrow(/answered 502 with a body that is not JSON/);
    await expect(prover.prove(proveRequest(policy, payment("empty")))).rejects.toThrow(/answered without a proof/);
  });

  it("gives up after its timeout, and when nothing listens", async () => {
    const prover = createProverClient({ url, timeoutMs: 100 });
    await expect(prover.prove(proveRequest(policy, payment("slow")))).rejects.toThrow(/did not answer within 100 ms/);
    const nobody = createProverClient({ url: "http://127.0.0.1:9" });
    await expect(nobody.prove(proveRequest(policy, payment("api-call")))).rejects.toBeInstanceOf(ProverError);
  });
});
