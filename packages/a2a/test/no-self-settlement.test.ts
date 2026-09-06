import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * The acceptance criterion, enforced against the source rather than argued in a
 * comment: there is no path by which an agent triggers its own payment.
 *
 * The predecessor had one. `dispatchToAgent` took an `onSettle` callback and
 * called `onSettle("release")` the moment the provider's own status poll came
 * back COMPLETED, and `onSettle("refund")` when it came back FAILED. The
 * provider's self-report was the trigger for moving money.
 *
 * This suite scans the shipped source for the shapes that would bring it back.
 * A structural test rather than a behavioural one, because the property is an
 * absence, and you cannot write a behavioural test for something that is not
 * there — the way it regresses is somebody adding it back, and that is exactly
 * what reading the source catches.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const SRC = join(HERE, "../src");

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? sourceFiles(join(dir, e.name)) : e.name.endsWith(".ts") ? [join(dir, e.name)] : [],
  );
}

const files = sourceFiles(SRC).map((path) => ({
  path: path.slice(SRC.length + 1),
  text: readFileSync(path, "utf8"),
}));

/** Comments explain why the forbidden thing is forbidden, so they cannot be the evidence. */
function code(text: string): string {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .map((line) => line.replace(/\/\/.*$/, ""))
    .join("\n");
}

describe("no path from a provider's own report to its own payment", () => {
  it("ships at least the modules this is meant to cover", () => {
    // A scan over an empty list passes vacuously. This is the tripwire.
    const names = files.map((f) => f.path).sort();
    expect(names).toContain("client.ts");
    expect(names).toContain("task-machine.ts");
    expect(names).toContain("states.ts");
    expect(names.length).toBeGreaterThanOrEqual(5);
  });

  it("never calls a settlement action", () => {
    // complete() and reject() are the evaluator's, and claimRefund is the
    // client's or anyone's after expiry. This package calls none of them.
    const forbidden = [/\bcomplete\s*\(/, /\breject\s*\(/, /\bclaimRefund\s*\(/, /\brelease\s*\(/];
    for (const file of files) {
      const body = code(file.text);
      for (const pattern of forbidden) {
        expect(pattern.test(body), `${file.path} calls ${pattern}`).toBe(false);
      }
    }
  });

  it("takes no settlement callback", () => {
    // The predecessor's exact shape: a callback the dispatcher invoked with
    // "release" or "refund" off the back of the provider's own status.
    const forbidden = [/onSettle/i, /settleCallback/i, /["']release["']/, /["']refund["']/];
    for (const file of files) {
      const body = code(file.text);
      for (const pattern of forbidden) {
        expect(pattern.test(body), `${file.path} matches ${pattern}`).toBe(false);
      }
    }
  });

  it("does not send, sign or submit a transaction", () => {
    // No wallet, no signer, no chain write. The package speaks HTTP.
    const forbidden = [
      /writeContract/,
      /sendTransaction/,
      /signTransaction/,
      /walletClient/i,
      /privateKey/i,
    ];
    for (const file of files) {
      const body = code(file.text);
      for (const pattern of forbidden) {
        expect(pattern.test(body), `${file.path} matches ${pattern}`).toBe(false);
      }
    }
  });

  it("depends on no chain library at all", () => {
    // viem or ethers appearing here would mean the protocol layer had grown the
    // ability to move money, whatever it did with it today.
    const pkg = JSON.parse(readFileSync(join(HERE, "../package.json"), "utf8")) as {
      dependencies?: Record<string, string>;
    };
    expect(Object.keys(pkg.dependencies ?? {})).toEqual([]);
    for (const file of files) {
      expect(/from ["'](viem|ethers|web3)/.test(file.text), `${file.path} imports a chain library`).toBe(false);
    }
  });

  it("mentions no token or amount on the wire", () => {
    // task/create used to carry `amount` and `paymentRef`, which let a provider
    // read what it was owed out of the request that asked it to work.
    const messages = files.find((f) => f.path === "messages.ts")!;
    const body = code(messages.text);
    for (const pattern of [/\bamount\b/i, /paymentRef/i, /\bUSDC\b/i, /\bprice\b/i]) {
      expect(pattern.test(body), `messages.ts exposes ${pattern}`).toBe(false);
    }
  });
});
