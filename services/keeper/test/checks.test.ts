import { describe, it, expect } from "vitest";
import type { Address } from "viem";
import type { Database } from "@squaresdk/data";
import { createHealth, type CheckReport, type HealthStatus } from "@squaresdk/observability";
import { keeperChecks } from "../src/checks.js";

const CHAIN = 5042002;
const ACCOUNT = "0xcc55417B17a31163325cB83Cf6900C98BE595e7A" as Address;
const FINALIZE_GAS = 450_000n;
const GWEI = 1_000_000_000n;
const LIVE_GAS_PRICE = 25n * GWEI;
const ONE_FINALIZE = LIVE_GAS_PRICE * FINALIZE_GAS;
const OLD_FIXED_THRESHOLD = 10n ** 16n;

interface Fakes {
  rowCount?: number;
  chainId?: number;
  balance?: bigint;
  gasPriceWei?: bigint;
  minActionsFunded?: number;
  ephemeralMirror?: boolean;
}

function harness(fakes: Fakes = {}) {
  const db = { query: async () => ({ rows: [], rowCount: fakes.rowCount ?? 1 }) } as unknown as Database;
  const publicClient = {
    getChainId: async () => fakes.chainId ?? CHAIN,
    getBalance: async () => fakes.balance ?? 10n ** 18n,
    getGasPrice: async () => fakes.gasPriceWei ?? LIVE_GAS_PRICE,
  };
  return createHealth({
    service: "square-keeper",
    version: "0",
    checks: keeperChecks({
      db,
      publicClient,
      chainId: CHAIN,
      account: ACCOUNT,
      finalizeGas: FINALIZE_GAS,
      ephemeralMirror: fakes.ephemeralMirror ?? false,
      ...(fakes.minActionsFunded === undefined ? {} : { minActionsFunded: fakes.minActionsFunded }),
    }),
  });
}

function checkOf(status: HealthStatus, name: string): CheckReport {
  const report = status.checks[name];
  if (report === undefined) throw new Error(`the health report carries no ${name} check`);
  return report;
}

describe("the balance check reads the gas price, not a constant", () => {
  it("fails the balance that the fixed 0.01 USDC threshold used to pass, because it buys no finalize", async () => {
    const status = await harness({ balance: OLD_FIXED_THRESHOLD + 1n }).status();

    const balance = checkOf(status, "balance");
    expect(balance.ok).toBe(false);
    expect(balance.critical).toBe(true);
    expect(balance.detail).toContain("covers 0 finalize sends");
    expect(balance.detail).toContain("minimum 3");
    expect(status.status).toBe("unhealthy");
  });

  it("passes at the configured number of actions and fails one wei below it", async () => {
    const funded = await harness({ balance: ONE_FINALIZE * 3n }).status();
    expect(checkOf(funded, "balance")).toMatchObject({ ok: true });
    expect(checkOf(funded, "balance").detail).toContain("covers 3 finalize sends");
    expect(funded.status).toBe("healthy");

    const short = await harness({ balance: ONE_FINALIZE * 3n - 1n }).status();
    expect(checkOf(short, "balance").ok).toBe(false);
    expect(checkOf(short, "balance").detail).toContain("covers 2 finalize sends");
  });

  it("follows the gas price up: the same balance that covered four finalizes covers one at four times the price", async () => {
    const balance = ONE_FINALIZE * 4n;

    const calm = await harness({ balance }).status();
    expect(checkOf(calm, "balance")).toMatchObject({ ok: true });
    expect(checkOf(calm, "balance").detail).toContain("covers 4 finalize sends");

    const spike = await harness({ balance, gasPriceWei: LIVE_GAS_PRICE * 4n }).status();
    expect(checkOf(spike, "balance").ok).toBe(false);
    expect(checkOf(spike, "balance").detail).toContain("covers 1 finalize sends");
    expect(checkOf(spike, "balance").detail).toContain(`${LIVE_GAS_PRICE * 4n} wei per gas`);
  });

  it("takes the number of actions from the operator and reports a free chain honestly", async () => {
    const oneIsEnough = await harness({ balance: ONE_FINALIZE, minActionsFunded: 1 }).status();
    expect(checkOf(oneIsEnough, "balance")).toMatchObject({ ok: true });
    expect(checkOf(oneIsEnough, "balance").detail).toContain("minimum 1");

    const free = await harness({ balance: 0n, gasPriceWei: 0n }).status();
    expect(checkOf(free, "balance")).toMatchObject({ ok: true });
    expect(checkOf(free, "balance").detail).toContain("gas is free");
  });
});

describe("the database, rpc and mirror checks", () => {
  it("pass against a database that answers, an endpoint on the configured chain and a shared mirror", async () => {
    const status = await harness().status();

    expect(checkOf(status, "database")).toMatchObject({ ok: true, critical: true });
    expect(checkOf(status, "rpc")).toMatchObject({ ok: true, critical: true });
    expect(checkOf(status, "mirror")).toMatchObject({ ok: true, detail: "reading the mirror an indexer writes" });
    expect(status.status).toBe("healthy");
  });

  it("fail on a database with no row, an endpoint on another chain, and a mirror nobody writes", async () => {
    const noRow = await harness({ rowCount: 0 }).status();
    expect(checkOf(noRow, "database")).toMatchObject({ ok: false, critical: true });
    expect(noRow.status).toBe("unhealthy");

    const otherChain = await harness({ chainId: 31337 }).status();
    expect(checkOf(otherChain, "rpc")).toMatchObject({ ok: false, critical: true });
    expect(otherChain.status).toBe("unhealthy");

    const alone = await harness({ ephemeralMirror: true }).status();
    expect(checkOf(alone, "mirror")).toMatchObject({ ok: false, critical: false });
    expect(checkOf(alone, "mirror").detail).toContain("DATABASE_URL");
    expect(alone.status).toBe("degraded");
  });
});
