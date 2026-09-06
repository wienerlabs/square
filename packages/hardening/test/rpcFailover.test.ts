import { createPublicClient, custom } from "viem";
import type { Transport } from "viem";
import { describe, expect, it, vi } from "vitest";
import { RpcEndpointCooldownError, createFailoverTransport, jitteredBackoffDelay, withRpcRetry } from "../src/rpcFailover.js";

type Handler = (args: { method: string; params?: unknown }) => Promise<unknown>;

function fakeTransports(handlers: Record<string, Handler>): (url: string) => Transport {
  return (url) => {
    const handler = handlers[url];
    if (handler === undefined) throw new Error(`no handler for ${url}`);
    return custom({ request: handler });
  };
}

const PRIMARY = "https://primary.test";
const SECONDARY = "https://secondary.test";

describe("createFailoverTransport", () => {
  it("fails over, reports the broken endpoint in cooldown, skips it while cooling, and retries it afterwards", async () => {
    let clock = 100_000;
    const primary = vi.fn<Handler>(async () => {
      throw new Error("primary down");
    });
    const secondary = vi.fn<Handler>(async () => "0x10");
    const onFailover = vi.fn<(from: string, to: string, error: Error) => void>();
    const transport = createFailoverTransport([PRIMARY, SECONDARY], {
      transportFactory: fakeTransports({ [PRIMARY]: primary, [SECONDARY]: secondary }),
      onFailover,
      baseCooldownMs: 5_000,
      maxBackoffMs: 60_000,
      retryCount: 0,
      now: () => clock,
    });
    const client = createPublicClient({ transport });

    expect(await client.request({ method: "eth_blockNumber" })).toBe("0x10");
    expect(primary).toHaveBeenCalledTimes(1);
    expect(secondary).toHaveBeenCalledTimes(1);
    expect(onFailover).toHaveBeenCalledTimes(1);
    expect(onFailover.mock.calls[0]?.[0]).toBe(PRIMARY);
    expect(onFailover.mock.calls[0]?.[1]).toBe(SECONDARY);
    expect(onFailover.mock.calls[0]?.[2]).toBeInstanceOf(Error);
    expect(onFailover.mock.calls[0]?.[2].message).toContain("primary down");

    const [primaryHealth, secondaryHealth] = transport.getHealth();
    expect(primaryHealth).toMatchObject({ url: PRIMARY, healthy: false, consecutiveFailures: 1, cooldownUntil: clock + 5_000 });
    expect(primaryHealth?.lastError).toContain("primary down");
    expect(secondaryHealth).toMatchObject({ url: SECONDARY, healthy: true, consecutiveFailures: 0, lastSuccessAt: clock });

    expect(await client.request({ method: "eth_blockNumber" })).toBe("0x10");
    expect(primary).toHaveBeenCalledTimes(1);
    expect(secondary).toHaveBeenCalledTimes(2);
    expect(onFailover).toHaveBeenCalledTimes(1);

    clock += 5_001;
    primary.mockImplementation(async () => "0x20");
    expect(await client.request({ method: "eth_blockNumber" })).toBe("0x20");
    expect(primary).toHaveBeenCalledTimes(2);
    expect(secondary).toHaveBeenCalledTimes(2);
    expect(transport.getHealth()[0]).toMatchObject({ healthy: true, consecutiveFailures: 0, cooldownUntil: undefined });
  });

  it("still tries a cooling endpoint when nothing healthier follows it", async () => {
    const clock = 100_000;
    const primary = vi.fn<Handler>(async () => {
      throw new Error("primary down");
    });
    const secondary = vi.fn<Handler>(async () => {
      throw new Error("secondary down");
    });
    const transport = createFailoverTransport([PRIMARY, SECONDARY], {
      transportFactory: fakeTransports({ [PRIMARY]: primary, [SECONDARY]: secondary }),
      retryCount: 0,
      now: () => clock,
    });
    const client = createPublicClient({ transport });

    await expect(client.request({ method: "eth_blockNumber" })).rejects.toThrow(/secondary down/);
    expect(transport.getHealth().map((endpoint) => endpoint.healthy)).toEqual([false, false]);

    await expect(client.request({ method: "eth_blockNumber" })).rejects.toThrow(/secondary down/);
    expect(primary).toHaveBeenCalledTimes(2);
    expect(secondary).toHaveBeenCalledTimes(2);
  });

  it("skips a cooling endpoint with a cooldown error that never reaches the caller", async () => {
    let clock = 100_000;
    const primary = vi.fn<Handler>(async () => {
      throw new Error("primary down");
    });
    const secondary = vi.fn<Handler>(async () => "0x1");
    const transport = createFailoverTransport([PRIMARY, SECONDARY], {
      transportFactory: fakeTransports({ [PRIMARY]: primary, [SECONDARY]: secondary }),
      retryCount: 0,
      now: () => clock,
    });
    const instance = transport({});
    await instance.request({ method: "eth_chainId" });
    clock += 1;
    await expect(instance.request({ method: "eth_chainId" })).resolves.toBe("0x1");
    expect(primary).toHaveBeenCalledTimes(1);
    expect(new RpcEndpointCooldownError(PRIMARY, clock).message).toContain(PRIMARY);
  });

  it("backs off exponentially and caps the cooldown at maxBackoffMs", async () => {
    const clock = 50_000;
    const only = vi.fn<Handler>(async () => {
      throw new Error("down");
    });
    const transport = createFailoverTransport([PRIMARY], {
      transportFactory: fakeTransports({ [PRIMARY]: only }),
      baseCooldownMs: 1_000,
      maxBackoffMs: 3_000,
      retryCount: 0,
      now: () => clock,
    });
    const instance = transport({});
    const cooldowns: Array<number | undefined> = [];
    for (let i = 0; i < 4; i += 1) {
      await expect(instance.request({ method: "eth_chainId" })).rejects.toThrow(/down/);
      cooldowns.push(transport.getHealth()[0]?.cooldownUntil);
    }
    expect(cooldowns).toEqual([clock + 1_000, clock + 2_000, clock + 3_000, clock + 3_000]);
    expect(only).toHaveBeenCalledTimes(4);
  });

  it("waits for failureThreshold consecutive failures before cooling down", async () => {
    const clock = 50_000;
    const only = vi.fn<Handler>(async () => {
      throw new Error("down");
    });
    const transport = createFailoverTransport([PRIMARY], {
      transportFactory: fakeTransports({ [PRIMARY]: only }),
      failureThreshold: 2,
      retryCount: 0,
      now: () => clock,
    });
    const instance = transport({});
    await expect(instance.request({ method: "eth_chainId" })).rejects.toThrow();
    expect(transport.getHealth()[0]?.healthy).toBe(true);
    await expect(instance.request({ method: "eth_chainId" })).rejects.toThrow();
    expect(transport.getHealth()[0]?.healthy).toBe(false);
  });

  it("rejects an empty url list", () => {
    expect(() => createFailoverTransport([])).toThrow(TypeError);
  });
});

describe("withRpcRetry", () => {
  it("retries with jittered exponential backoff until the call succeeds", async () => {
    const sleeps: number[] = [];
    let calls = 0;
    const result = await withRpcRetry(
      async (attempt) => {
        calls += 1;
        if (attempt < 3) throw new Error("flaky");
        return "ok";
      },
      { attempts: 3, baseDelayMs: 100, maxDelayMs: 1_000, random: () => 0.5, sleep: async (ms) => void sleeps.push(ms) }
    );
    expect(result).toBe("ok");
    expect(calls).toBe(3);
    expect(sleeps).toEqual([75, 150]);
  });

  it("gives up after the configured number of attempts", async () => {
    let calls = 0;
    await expect(
      withRpcRetry(
        async () => {
          calls += 1;
          throw new Error("flaky");
        },
        { attempts: 2, sleep: async () => undefined }
      )
    ).rejects.toThrow("flaky");
    expect(calls).toBe(2);
  });

  it("does not retry errors the predicate marks permanent", async () => {
    let calls = 0;
    await expect(
      withRpcRetry(
        async () => {
          calls += 1;
          throw new Error("permanent");
        },
        { attempts: 5, isRetryable: () => false, sleep: async () => undefined }
      )
    ).rejects.toThrow("permanent");
    expect(calls).toBe(1);
  });

  it("caps the delay at maxDelayMs and keeps half of the ceiling as a floor", () => {
    expect(jitteredBackoffDelay(10, 100, 1_000, () => 1)).toBe(1_000);
    expect(jitteredBackoffDelay(10, 100, 1_000, () => 0)).toBe(500);
    expect(jitteredBackoffDelay(1, 200, 5_000, () => 0)).toBe(100);
  });
});
