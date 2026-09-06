import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { privateKeyToAccount } from "viem/accounts";
import {
  KeystoreSchema,
  decryptKeystore,
  deleteKeystore,
  encryptKeystore,
  generateWallet,
  importPrivateKey,
  keystoreExists,
  loadKeystore,
  saveKeystore,
  walletFromPrivateKey,
} from "../src/core/wallet.js";

/**
 * The scrypt parameters are deliberately expensive (N = 2^17), so anything that
 * derives a key gets a generous timeout. Lowering N for the tests would leave
 * the parameter that actually protects the keystore untested.
 */
const SLOW = 20_000;

/**
 * Private key 1 — the smallest valid secp256k1 scalar.
 *
 * A fixed key makes the parsing and swapped-address cases deterministic. This
 * one is used rather than a random-looking constant so that nothing in the repo
 * can be mistaken for a real secret, by a reader or by a secret scanner.
 */
const KEY_A = `0x${"00".repeat(31)}01` as const;
const ADDRESS_A = privateKeyToAccount(KEY_A).address;

describe("generateWallet", () => {
  it("produces distinct wallets", () => {
    expect(generateWallet().address).not.toBe(generateWallet().address);
  });

  it("produces a 32-byte secp256k1 key", () => {
    const { privateKey } = generateWallet();
    expect(privateKey).toMatch(/^0x[0-9a-f]{64}$/);
  });

  it("derives the address the key actually controls", () => {
    const w = generateWallet();
    expect(w.address).toBe(privateKeyToAccount(w.privateKey).address);
  });
});

describe("importPrivateKey", () => {
  it("accepts the 0x-prefixed hex every EVM tool exports", () => {
    expect(importPrivateKey(KEY_A).address).toBe(ADDRESS_A);
  });

  it("accepts the same key without the prefix", () => {
    expect(importPrivateKey(KEY_A.slice(2)).address).toBe(ADDRESS_A);
  });

  it("trims surrounding whitespace", () => {
    expect(importPrivateKey(`  ${KEY_A}\n`).address).toBe(ADDRESS_A);
  });

  it("rejects non-hexadecimal input", () => {
    expect(() => importPrivateKey("not-a-key")).toThrow(/hexadecimal/);
  });

  it("rejects keys of the wrong length", () => {
    expect(() => importPrivateKey(`0x${"ab".repeat(16)}`)).toThrow(/32 bytes/);
  });

  it("rejects a key of zero, which is the right length but off the curve", () => {
    expect(() => importPrivateKey(`0x${"00".repeat(32)}`)).toThrow(/secp256k1/);
  });

  it("rejects a key at or above the curve order", () => {
    // secp256k1 n = fffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141
    const n = "0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141";
    expect(() => importPrivateKey(n)).toThrow(/secp256k1/);
  });
});

describe("encryptKeystore / decryptKeystore", () => {
  it("round-trips a wallet through encryption", async () => {
    const original = generateWallet();
    const keystore = await encryptKeystore(original, "correct horse battery staple");
    const recovered = await decryptKeystore(keystore, "correct horse battery staple");
    expect(recovered.address).toBe(original.address);
    expect(recovered.privateKey).toBe(original.privateKey);
  }, SLOW);

  it("fails with the wrong passphrase", async () => {
    const keystore = await encryptKeystore(generateWallet(), "correct horse");
    await expect(decryptKeystore(keystore, "wrong horse")).rejects.toThrow(/decrypt/);
  }, SLOW);

  it("rejects short passphrases", async () => {
    await expect(encryptKeystore(generateWallet(), "short")).rejects.toThrow(/at least 8/);
  });

  it("produces schema-valid output", async () => {
    const keystore = await encryptKeystore(generateWallet(), "a-decent-passphrase");
    expect(KeystoreSchema.safeParse(keystore).success).toBe(true);
    expect(keystore.version).toBe(2);
    expect(keystore.curve).toBe("secp256k1");
    expect(keystore.algorithm).toBe("aes-256-gcm");
    expect(keystore.kdf.N).toBe(2 ** 17);
  }, SLOW);

  it("uses unique salts and IVs across keystores", async () => {
    const wallet = generateWallet();
    const a = await encryptKeystore(wallet, "same-passphrase-twice");
    const b = await encryptKeystore(wallet, "same-passphrase-twice");
    expect(a.kdf.salt).not.toBe(b.kdf.salt);
    expect(a.iv).not.toBe(b.iv);
    expect(a.ciphertext).not.toBe(b.ciphertext);
  }, SLOW);

  it("authenticates the ciphertext (tamper detection)", async () => {
    const keystore = await encryptKeystore(generateWallet(), "a-decent-passphrase");
    const tampered = {
      ...keystore,
      ciphertext: Buffer.from("totally-different-ciphertext-32b").toString("base64"),
    };
    await expect(decryptKeystore(tampered, "a-decent-passphrase")).rejects.toThrow(/decrypt/);
  }, SLOW);

  it("detects a flipped bit in the ciphertext", async () => {
    const keystore = await encryptKeystore(generateWallet(), "a-decent-passphrase");
    const bytes = Buffer.from(keystore.ciphertext, "base64");
    bytes[0] = bytes[0]! ^ 0x01;
    const tampered = { ...keystore, ciphertext: bytes.toString("base64") };
    await expect(decryptKeystore(tampered, "a-decent-passphrase")).rejects.toThrow(/decrypt/);
  }, SLOW);

  it("detects a tampered auth tag", async () => {
    const keystore = await encryptKeystore(generateWallet(), "a-decent-passphrase");
    const tag = Buffer.from(keystore.authTag, "base64");
    tag[0] = tag[0]! ^ 0xff;
    const tampered = { ...keystore, authTag: tag.toString("base64") };
    await expect(decryptKeystore(tampered, "a-decent-passphrase")).rejects.toThrow(/decrypt/);
  }, SLOW);

  it("detects a tampered salt", async () => {
    const keystore = await encryptKeystore(generateWallet(), "a-decent-passphrase");
    const salt = Buffer.from(keystore.kdf.salt, "base64");
    salt[0] = salt[0]! ^ 0xff;
    const tampered = { ...keystore, kdf: { ...keystore.kdf, salt: salt.toString("base64") } };
    await expect(decryptKeystore(tampered, "a-decent-passphrase")).rejects.toThrow(/decrypt/);
  }, SLOW);

  it("detects a swapped address, which sits outside the AEAD", async () => {
    // The address is metadata, not ciphertext, so GCM does not cover it. Left
    // unchecked, a file could name one signer and hand back another.
    const keystore = await encryptKeystore(walletFromPrivateKey(KEY_A), "a-decent-passphrase");
    const tampered = { ...keystore, address: "0x0000000000000000000000000000000000000001" };
    await expect(decryptKeystore(tampered, "a-decent-passphrase")).rejects.toThrow(
      /does not match/,
    );
  }, SLOW);
});

describe("keystore disk I/O", () => {
  let sandbox: string;
  let originalHome: string | undefined;

  beforeEach(async () => {
    sandbox = await mkdtemp(join(tmpdir(), "mandate-cli-test-"));
    originalHome = process.env.MANDATE_HOME;
    process.env.MANDATE_HOME = sandbox;
  });

  afterEach(async () => {
    if (originalHome !== undefined) process.env.MANDATE_HOME = originalHome;
    else delete process.env.MANDATE_HOME;
    await rm(sandbox, { recursive: true, force: true });
  });

  it("reports no keystore initially", async () => {
    expect(await keystoreExists()).toBe(false);
  });

  it("round-trips through disk with 0600 permissions", async () => {
    const original = generateWallet();
    await saveKeystore(await encryptKeystore(original, "disk-test-passphrase"));

    expect(await keystoreExists()).toBe(true);

    const onDisk = await loadKeystore();
    expect(onDisk.address).toBe(original.address);

    const recovered = await decryptKeystore(onDisk, "disk-test-passphrase");
    expect(recovered.privateKey).toBe(original.privateKey);

    const stats = await stat(join(sandbox, "keystore.json"));
    expect((stats.mode & 0o777).toString(8)).toBe("600");
  }, SLOW);

  it("throws NotFoundError when there is no file", async () => {
    await expect(loadKeystore()).rejects.toMatchObject({ name: "NotFoundError" });
  });

  it("refuses a version-1 Solana keystore instead of misreading it", async () => {
    // The wrapper is byte-identical between v1 and v2, so this file parses. What
    // it holds is an Ed25519 keypair that cannot sign an Arc transaction.
    await writeFile(
      join(sandbox, "keystore.json"),
      JSON.stringify({
        version: 1,
        publicKey: "7imsPo1owz6arqjqHpHvEfNgTepXnm9vtjmHQoVWmABX",
        algorithm: "aes-256-gcm",
        kdf: { name: "scrypt", salt: "AA==", N: 131072, r: 8, p: 1, keyLen: 32 },
        iv: "AA==",
        ciphertext: "AA==",
        authTag: "AA==",
        createdAt: new Date().toISOString(),
      }),
    );
    await expect(loadKeystore()).rejects.toThrow(/Solana/);
  });

  it("rejects a malformed keystore", async () => {
    await writeFile(join(sandbox, "keystore.json"), '{"version":2}');
    await expect(loadKeystore()).rejects.toThrow(/malformed/);
  });

  it("deletes the keystore", async () => {
    await saveKeystore(await encryptKeystore(generateWallet(), "soon-to-delete"));
    expect(await keystoreExists()).toBe(true);
    await deleteKeystore();
    expect(await keystoreExists()).toBe(false);
  }, SLOW);

  it("delete is idempotent when no keystore exists", async () => {
    await expect(deleteKeystore()).resolves.toBeUndefined();
  });
});
