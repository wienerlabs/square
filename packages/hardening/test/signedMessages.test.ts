import { privateKeyToAccount } from "viem/accounts";
import { describe, expect, it } from "vitest";
import { canonicalJson, memoryNonceStore, signAction, verifyAction } from "../src/signedMessages.js";
import type { SquareAction } from "../src/signedMessages.js";

const alice = privateKeyToAccount("0x1111111111111111111111111111111111111111111111111111111111111111");
const bob = privateKeyToAccount("0x2222222222222222222222222222222222222222222222222222222222222222");
const NOW = 1_700_000_000n;

function action(overrides: Partial<SquareAction> = {}): SquareAction {
  return {
    actor: alice.address,
    action: "settle",
    resource: "invoice:42",
    nonce: 1n,
    issuedAt: NOW - 10n,
    expiresAt: NOW + 60n,
    chainId: 5042002n,
    ...overrides,
  };
}

function freshStore() {
  return memoryNonceStore({ now: () => NOW });
}

describe("verifyAction", () => {
  it("accepts a valid signature from the named and expected actor", async () => {
    const message = action();
    const signature = await signAction(alice, message);
    const result = await verifyAction({ message, signature, expectedActor: alice.address, now: NOW, nonceStore: freshStore() });
    expect(result).toEqual({ ok: true, actor: alice.address, message });
  });

  it("accepts the expected actor in any letter case", async () => {
    const message = action();
    const signature = await signAction(alice, message);
    const result = await verifyAction({
      message,
      signature,
      expectedActor: alice.address.toLowerCase() as `0x${string}`,
      now: NOW,
      nonceStore: freshStore(),
    });
    expect(result.ok).toBe(true);
  });

  it("rejects when the server expected a different actor", async () => {
    const message = action();
    const signature = await signAction(alice, message);
    const result = await verifyAction({ message, signature, expectedActor: bob.address, now: NOW, nonceStore: freshStore() });
    expect(result).toMatchObject({ ok: false, reason: "unexpected_actor" });
  });

  it("rejects when the message names an actor who did not sign it", async () => {
    const message = action({ actor: bob.address });
    const signature = await signAction(alice, message);
    const result = await verifyAction({ message, signature, expectedActor: bob.address, now: NOW, nonceStore: freshStore() });
    expect(result).toMatchObject({ ok: false, reason: "actor_mismatch" });
  });

  it("rejects a tampered message", async () => {
    const signature = await signAction(alice, action());
    const tampered = action({ resource: "invoice:43" });
    const result = await verifyAction({ message: tampered, signature, expectedActor: alice.address, now: NOW, nonceStore: freshStore() });
    expect(result).toMatchObject({ ok: false, reason: "actor_mismatch" });
  });

  it("rejects an expired message, including exactly at expiresAt", async () => {
    const message = action();
    const signature = await signAction(alice, message);
    const late = await verifyAction({ message, signature, expectedActor: alice.address, now: NOW + 61n, nonceStore: freshStore() });
    expect(late).toMatchObject({ ok: false, reason: "expired" });
    const boundary = await verifyAction({ message, signature, expectedActor: alice.address, now: message.expiresAt, nonceStore: freshStore() });
    expect(boundary).toMatchObject({ ok: false, reason: "expired" });
  });

  it("rejects a message that is not yet valid", async () => {
    const message = action();
    const signature = await signAction(alice, message);
    const result = await verifyAction({ message, signature, expectedActor: alice.address, now: NOW - 11n, nonceStore: freshStore() });
    expect(result).toMatchObject({ ok: false, reason: "not_yet_valid" });
  });

  it("rejects a reused nonce while keeping other nonces and actors usable", async () => {
    const nonceStore = freshStore();
    const message = action();
    const signature = await signAction(alice, message);
    const first = await verifyAction({ message, signature, expectedActor: alice.address, now: NOW, nonceStore });
    expect(first.ok).toBe(true);
    const replay = await verifyAction({ message, signature, expectedActor: alice.address, now: NOW, nonceStore });
    expect(replay).toMatchObject({ ok: false, reason: "nonce_reused" });

    const next = action({ nonce: 2n });
    const nextResult = await verifyAction({ message: next, signature: await signAction(alice, next), expectedActor: alice.address, now: NOW, nonceStore });
    expect(nextResult.ok).toBe(true);

    const bobs = action({ actor: bob.address });
    const bobResult = await verifyAction({ message: bobs, signature: await signAction(bob, bobs), expectedActor: bob.address, now: NOW, nonceStore });
    expect(bobResult.ok).toBe(true);
  });

  it("does not burn the nonce when an earlier check fails", async () => {
    const nonceStore = freshStore();
    const message = action();
    const signature = await signAction(alice, message);
    await verifyAction({ message, signature, expectedActor: bob.address, now: NOW, nonceStore });
    const result = await verifyAction({ message, signature, expectedActor: alice.address, now: NOW, nonceStore });
    expect(result.ok).toBe(true);
  });

  it("rejects a chain mismatch when the verifier pins a chain", async () => {
    const message = action();
    const signature = await signAction(alice, message);
    const result = await verifyAction({ message, signature, expectedActor: alice.address, now: NOW, nonceStore: freshStore(), expectedChainId: 1 });
    expect(result).toMatchObject({ ok: false, reason: "chain_mismatch" });
  });

  it("rejects garbage signatures without throwing", async () => {
    const message = action();
    const result = await verifyAction({ message, signature: "0x1234", expectedActor: alice.address, now: NOW, nonceStore: freshStore() });
    expect(result.ok).toBe(false);
    expect(result.ok ? undefined : result.reason).toMatch(/invalid_signature|actor_mismatch/);
  });

  it("rejects malformed messages", async () => {
    const message = action({ expiresAt: NOW - 20n });
    const signature = await signAction(alice, message);
    const result = await verifyAction({ message, signature, expectedActor: alice.address, now: NOW, nonceStore: freshStore() });
    expect(result).toMatchObject({ ok: false, reason: "malformed_message" });
  });
});

describe("memoryNonceStore", () => {
  it("forgets nonces once their message has expired", async () => {
    let clock = NOW;
    const store = memoryNonceStore({ now: () => clock });
    expect(await store.consume(alice.address, 1n, NOW + 10n)).toBe(true);
    expect(await store.consume(alice.address, 1n, NOW + 10n)).toBe(false);
    clock = NOW + 10n;
    expect(await store.consume(alice.address, 1n, NOW + 20n)).toBe(true);
  });
});

describe("canonicalJson", () => {
  it("sorts keys recursively and strips whitespace", () => {
    expect(canonicalJson({ b: [3, { z: 1, y: "s" }], a: null, c: true })).toBe('{"a":null,"b":[3,{"y":"s","z":1}],"c":true}');
  });

  it("drops undefined members and turns undefined array items into null", () => {
    expect(canonicalJson({ a: undefined, b: [undefined, 1] })).toBe('{"b":[null,1]}');
  });

  it("keeps numbers exactly as JSON numbers", () => {
    expect(canonicalJson({ n: 1e21, m: -0, k: 0.1, j: 1000000 })).toBe('{"j":1000000,"k":0.1,"m":0,"n":1e+21}');
  });

  it("escapes strings like JSON.stringify", () => {
    expect(canonicalJson({ s: 'quote " and \n newline' })).toBe('{"s":"quote \\" and \\n newline"}');
  });

  it("uses toJSON like JSON.stringify", () => {
    expect(canonicalJson({ at: new Date(0) })).toBe('{"at":"1970-01-01T00:00:00.000Z"}');
  });

  it("refuses values that have no canonical form", () => {
    expect(() => canonicalJson(Number.NaN)).toThrow(TypeError);
    expect(() => canonicalJson({ big: 1n })).toThrow(TypeError);
    expect(() => canonicalJson(undefined)).toThrow(TypeError);
  });
});
