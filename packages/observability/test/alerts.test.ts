import { describe, it, expect } from "vitest";
import {
  createAlerting,
  keeperStalled,
  indexerLagging,
  proofFailureRate,
  disputesPilingUp,
  webhookNotifier,
  logNotifier,
  type Alert,
  type AlertRule,
} from "../src/alerts.js";
import { createLogger } from "../src/logger.js";

function harness(rules: AlertRule[], service?: string) {
  let now = 1_000_000;
  const notified: Alert[] = [];
  const alerting = createAlerting({
    rules,
    notify: async (alert) => {
      notified.push(alert);
    },
    clock: () => now,
    ...(service === undefined ? {} : { service }),
  });
  return {
    notified,
    alerting,
    advance(seconds: number) {
      now += seconds * 1000;
    },
    now: () => now,
  };
}

describe("a keeper that stops", () => {
  it("pages exactly once after the age holds past forSeconds, then resolves exactly once", async () => {
    const h = harness([keeperStalled({ maxPendingAgeSeconds: 600, forSeconds: 120 })], "keeper");

    for (const age of [0, 30, 60]) {
      await h.alerting.evaluate({ oldestPendingAgeSeconds: age });
      h.advance(30);
    }
    expect(h.notified).toHaveLength(0);

    await h.alerting.evaluate({ oldestPendingAgeSeconds: 700 });
    expect(h.notified).toHaveLength(0);
    h.advance(60);
    await h.alerting.evaluate({ oldestPendingAgeSeconds: 760 });
    expect(h.notified).toHaveLength(0);
    expect(h.alerting.state()[0]).toMatchObject({ rule: "keeperStalled", firing: false });

    h.advance(60);
    const fired = await h.alerting.evaluate({ oldestPendingAgeSeconds: 820 });
    expect(fired.notified).toHaveLength(1);
    expect(h.notified).toHaveLength(1);
    expect(h.notified[0]).toMatchObject({
      kind: "firing",
      rule: "keeperStalled",
      severity: "page",
      service: "keeper",
      heldForSeconds: 120,
    });
    expect(h.notified[0]?.detail).toContain("820s");

    for (const age of [850, 880, 910]) {
      h.advance(30);
      await h.alerting.evaluate({ oldestPendingAgeSeconds: age });
    }
    expect(h.notified).toHaveLength(1);
    expect(h.alerting.state()[0]).toMatchObject({ firing: true });

    h.advance(30);
    await h.alerting.evaluate({ oldestPendingAgeSeconds: 0 });
    expect(h.notified).toHaveLength(2);
    expect(h.notified[1]).toMatchObject({ kind: "resolved", rule: "keeperStalled", severity: "page" });
    expect(h.notified[1]?.heldForSeconds).toBe(240);

    for (let i = 0; i < 5; i += 1) {
      h.advance(30);
      await h.alerting.evaluate({ oldestPendingAgeSeconds: 0 });
    }
    expect(h.notified).toHaveLength(2);
    expect(h.alerting.state()[0]).toMatchObject({ firing: false, undelivered: 0 });
  });

  it("does not notify for a blip shorter than forSeconds", async () => {
    const h = harness([keeperStalled({ maxPendingAgeSeconds: 600, forSeconds: 120 })]);
    await h.alerting.evaluate({ oldestPendingAgeSeconds: 900 });
    h.advance(60);
    await h.alerting.evaluate({ oldestPendingAgeSeconds: 0 });
    h.advance(60);
    await h.alerting.evaluate({ oldestPendingAgeSeconds: 900 });
    h.advance(60);
    await h.alerting.evaluate({ oldestPendingAgeSeconds: 0 });
    expect(h.notified).toHaveLength(0);
  });

  it("fires on the first true tick when forSeconds is zero", async () => {
    const h = harness([keeperStalled({ maxPendingAgeSeconds: 600, forSeconds: 0 })]);
    await h.alerting.evaluate({ oldestPendingAgeSeconds: 601 });
    expect(h.notified).toHaveLength(1);
    expect(h.notified[0]?.heldForSeconds).toBe(0);
  });

  it("stays quiet when the sample is missing", async () => {
    const h = harness([keeperStalled({ maxPendingAgeSeconds: 600, forSeconds: 0 })]);
    await h.alerting.evaluate({});
    await h.alerting.evaluate({ oldestPendingAgeSeconds: Number.NaN });
    expect(h.notified).toHaveLength(0);
  });
});

describe("engine", () => {
  it("retries delivery on the next tick without duplicating", async () => {
    let now = 0;
    let failNext = true;
    const delivered: Alert[] = [];
    const alerting = createAlerting({
      rules: [disputesPilingUp({ maxOpenDisputes: 1, forSeconds: 0 })],
      clock: () => now,
      notify: async (alert) => {
        if (failNext) {
          failNext = false;
          throw new Error("webhook down");
        }
        delivered.push(alert);
      },
    });
    const first = await alerting.evaluate({ disputesOpen: 5 });
    expect(first.notified).toHaveLength(0);
    expect(first.errors).toEqual([{ rule: "disputesPilingUp", stage: "notify", error: "webhook down" }]);
    expect(alerting.state()[0]?.undelivered).toBe(1);
    now += 30_000;
    const second = await alerting.evaluate({ disputesOpen: 5 });
    expect(second.notified).toHaveLength(1);
    expect(delivered).toHaveLength(1);
    now += 30_000;
    await alerting.evaluate({ disputesOpen: 5 });
    expect(delivered).toHaveLength(1);
  });

  it("keeps firing and resolved in order when delivery was down across both", async () => {
    let now = 0;
    let down = true;
    const delivered: Alert[] = [];
    const alerting = createAlerting({
      rules: [disputesPilingUp({ maxOpenDisputes: 1, forSeconds: 0 })],
      clock: () => now,
      notify: async (alert) => {
        if (down) throw new Error("down");
        delivered.push(alert);
      },
    });
    await alerting.evaluate({ disputesOpen: 5 });
    now += 30_000;
    await alerting.evaluate({ disputesOpen: 0 });
    expect(delivered).toHaveLength(0);
    down = false;
    now += 30_000;
    await alerting.evaluate({ disputesOpen: 0 });
    expect(delivered.map((a) => a.kind)).toEqual(["firing", "resolved"]);
  });

  it("isolates a throwing rule and still evaluates the others", async () => {
    const h = harness([
      { name: "broken", severity: "warn", evaluate: () => { throw new Error("bad rule"); } },
      disputesPilingUp({ maxOpenDisputes: 1, forSeconds: 0 }),
    ]);
    const result = await h.alerting.evaluate({ disputesOpen: 3 });
    expect(result.errors).toEqual([{ rule: "broken", stage: "evaluate", error: "bad rule" }]);
    expect(result.notified.map((a) => a.rule)).toEqual(["disputesPilingUp"]);
  });

  it("rejects duplicate rule names", () => {
    expect(() =>
      createAlerting({ rules: [disputesPilingUp(), disputesPilingUp()], notify: async () => undefined }),
    ).toThrow(/duplicate/);
  });
});

describe("built-in rules", () => {
  it("indexerLagging fires above maxLagBlocks", async () => {
    const h = harness([indexerLagging({ maxLagBlocks: 50, forSeconds: 0 })]);
    await h.alerting.evaluate({ indexerLagBlocks: 50 });
    expect(h.notified).toHaveLength(0);
    await h.alerting.evaluate({ indexerLagBlocks: 51 });
    expect(h.notified).toHaveLength(1);
    expect(h.notified[0]).toMatchObject({ rule: "indexerLagging", severity: "warn", kind: "firing" });
  });

  it("proofFailureRate measures the ratio over a sliding window of cumulative counters", async () => {
    const h = harness([proofFailureRate({ maxFailureRatio: 0.5, windowSeconds: 60, minAttempts: 2, forSeconds: 0 })]);
    await h.alerting.evaluate({ proofAttempts: 10, proofFailures: 0 });
    expect(h.notified).toHaveLength(0);
    h.advance(10);
    await h.alerting.evaluate({ proofAttempts: 12, proofFailures: 2 });
    expect(h.notified).toHaveLength(1);
    expect(h.notified[0]?.detail).toContain("2/2");
    h.advance(70);
    await h.alerting.evaluate({ proofAttempts: 12, proofFailures: 2 });
    expect(h.notified).toHaveLength(2);
    expect(h.notified[1]?.kind).toBe("resolved");
  });

  it("proofFailureRate ignores windows with too few attempts and survives counter resets", async () => {
    const h = harness([proofFailureRate({ maxFailureRatio: 0.5, windowSeconds: 60, minAttempts: 5, forSeconds: 0 })]);
    await h.alerting.evaluate({ proofAttempts: 0, proofFailures: 0 });
    h.advance(10);
    await h.alerting.evaluate({ proofAttempts: 2, proofFailures: 2 });
    expect(h.notified).toHaveLength(0);
    h.advance(10);
    await h.alerting.evaluate({ proofAttempts: 1, proofFailures: 1 });
    expect(h.notified).toHaveLength(0);
    h.advance(10);
    await h.alerting.evaluate({ proofAttempts: 7, proofFailures: 5 });
    expect(h.notified).toHaveLength(1);
  });

  it("disputesPilingUp fires above maxOpenDisputes", async () => {
    const h = harness([disputesPilingUp({ maxOpenDisputes: 3, forSeconds: 0 })]);
    await h.alerting.evaluate({ disputesOpen: 3 });
    expect(h.notified).toHaveLength(0);
    await h.alerting.evaluate({ disputesOpen: 4 });
    expect(h.notified).toHaveLength(1);
  });

  it("ships sensible defaults", () => {
    expect(keeperStalled()).toMatchObject({ name: "keeperStalled", severity: "page", forSeconds: 60 });
    expect(indexerLagging()).toMatchObject({ name: "indexerLagging", severity: "warn", forSeconds: 120 });
    expect(proofFailureRate()).toMatchObject({ name: "proofFailureRate", severity: "warn", forSeconds: 0 });
    expect(disputesPilingUp()).toMatchObject({ name: "disputesPilingUp", severity: "warn", forSeconds: 0 });
    expect(keeperStalled().evaluate({ oldestPendingAgeSeconds: 601 }, { now: 0 }).firing).toBe(true);
    expect(keeperStalled().evaluate({ oldestPendingAgeSeconds: 600 }, { now: 0 }).firing).toBe(false);
    expect(indexerLagging().evaluate({ indexerLagBlocks: 101 }, { now: 0 }).firing).toBe(true);
    expect(disputesPilingUp().evaluate({ disputesOpen: 11 }, { now: 0 }).firing).toBe(true);
  });
});

describe("notifiers", () => {
  const alert: Alert = {
    kind: "firing",
    rule: "keeperStalled",
    severity: "page",
    at: 1_700_000_000_000,
    since: 1_699_999_880_000,
    heldForSeconds: 120,
    service: "keeper",
    detail: "oldest finalizable job has waited 820s, above 600s",
  };

  it("webhookNotifier posts the alert as JSON", async () => {
    const calls: Array<{ url: string; init: RequestInit | undefined }> = [];
    const fakeFetch: typeof fetch = async (input, init) => {
      calls.push({ url: String(input), init });
      return new Response(null, { status: 204 });
    };
    const notify = webhookNotifier("https://hooks.example/abc", { fetch: fakeFetch, headers: { authorization: "Bearer t" } });
    await notify(alert);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe("https://hooks.example/abc");
    expect(calls[0]?.init?.method).toBe("POST");
    expect(calls[0]?.init?.headers).toMatchObject({ "content-type": "application/json", authorization: "Bearer t" });
    expect(JSON.parse(String(calls[0]?.init?.body))).toEqual({
      kind: "firing",
      rule: "keeperStalled",
      severity: "page",
      service: "keeper",
      at: "2023-11-14T22:13:20.000Z",
      since: "2023-11-14T22:11:20.000Z",
      heldForSeconds: 120,
      detail: alert.detail,
    });
  });

  it("webhookNotifier throws on a non-2xx response without echoing the url", async () => {
    const fakeFetch: typeof fetch = async () => new Response("nope", { status: 500 });
    const notify = webhookNotifier("https://hooks.example/secret-token", { fetch: fakeFetch });
    await expect(notify(alert)).rejects.toThrow(/status 500/);
    await expect(notify(alert)).rejects.not.toThrow(/secret-token/);
  });

  it("logNotifier writes through the redacting logger", async () => {
    const lines: string[] = [];
    const logger = createLogger({ service: "keeper", version: "1", sink: (line) => { lines.push(line); } });
    const notify = logNotifier(logger);
    await notify(alert);
    await notify({ ...alert, severity: "warn" });
    await notify({ ...alert, kind: "resolved" });
    const parsed = lines.map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(parsed.map((p) => [p.event, p.level])).toEqual([
      ["alert_firing", "error"],
      ["alert_firing", "warn"],
      ["alert_resolved", "info"],
    ]);
    expect(parsed[0]).toMatchObject({ rule: "keeperStalled", age: 120, reason: alert.detail });
    expect(parsed[0]).not.toHaveProperty("dropped_fields");
  });
});
