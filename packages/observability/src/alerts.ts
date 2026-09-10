import type { Logger } from "./logger.js";

export type AlertSeverity = "page" | "warn";

export type AlertKind = "firing" | "resolved";

export interface AlertSnapshot {
  oldestPendingAgeSeconds?: number;
  finalizePending?: number;
  indexerLagBlocks?: number | undefined;
  proofAttempts?: number;
  proofFailures?: number;
  disputesOpen?: number;
  lastKeeperTickAt?: number;
  hookWriteFailures?: number;
  [key: string]: unknown;
}

export interface AlertVerdict {
  firing: boolean;
  detail?: string;
}

export interface EvaluationContext {
  now: number;
}

export interface AlertRule {
  name: string;
  severity: AlertSeverity;
  evaluate: (snapshot: AlertSnapshot, context: EvaluationContext) => AlertVerdict;
  forSeconds?: number;
}

export interface Alert {
  kind: AlertKind;
  rule: string;
  severity: AlertSeverity;
  at: number;
  since: number;
  heldForSeconds: number;
  service?: string;
  detail?: string;
}

export type Notifier = (alert: Alert) => Promise<void>;

export interface AlertingOptions {
  rules: readonly AlertRule[];
  notify: Notifier;
  clock?: () => number;
  service?: string;
}

export interface AlertError {
  rule: string;
  stage: "evaluate" | "notify";
  error: string;
}

export interface EvaluationResult {
  notified: Alert[];
  errors: AlertError[];
  skipped: boolean;
}

export interface RuleState {
  rule: string;
  severity: AlertSeverity;
  firing: boolean;
  since?: number;
  firedAt?: number;
  detail?: string;
  undelivered: number;
}

export interface Alerting {
  evaluate(snapshot: AlertSnapshot): Promise<EvaluationResult>;
  state(): RuleState[];
}

interface TrackedRule {
  rule: AlertRule;
  firing: boolean;
  since: number | undefined;
  firedAt: number | undefined;
  detail: string | undefined;
  outbox: Alert[];
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function createAlerting(options: AlertingOptions): Alerting {
  const clock = options.clock ?? Date.now;
  const names = new Set<string>();
  const tracked: TrackedRule[] = options.rules.map((rule) => {
    if (names.has(rule.name)) throw new Error(`duplicate alert rule name: ${rule.name}`);
    names.add(rule.name);
    return { rule, firing: false, since: undefined, firedAt: undefined, detail: undefined, outbox: [] };
  });

  function makeAlert(entry: TrackedRule, kind: AlertKind, now: number, since: number, detail: string | undefined): Alert {
    const alert: Alert = {
      kind,
      rule: entry.rule.name,
      severity: entry.rule.severity,
      at: now,
      since,
      heldForSeconds: (now - since) / 1000,
    };
    if (options.service !== undefined) alert.service = options.service;
    if (detail !== undefined) alert.detail = detail;
    return alert;
  }

  function step(entry: TrackedRule, snapshot: AlertSnapshot, now: number, errors: AlertError[]): void {
    let verdict: AlertVerdict;
    try {
      verdict = entry.rule.evaluate(snapshot, { now });
    } catch (error) {
      errors.push({ rule: entry.rule.name, stage: "evaluate", error: errorMessage(error) });
      return;
    }
    if (verdict.firing) {
      if (entry.since === undefined) entry.since = now;
      entry.detail = verdict.detail;
      const held = (now - entry.since) / 1000;
      if (!entry.firing && held >= (entry.rule.forSeconds ?? 0)) {
        entry.firing = true;
        entry.firedAt = now;
        entry.outbox.push(makeAlert(entry, "firing", now, entry.since, verdict.detail));
      }
      return;
    }
    if (entry.firing && entry.since !== undefined) {
      entry.outbox.push(makeAlert(entry, "resolved", now, entry.since, verdict.detail));
    }
    entry.firing = false;
    entry.since = undefined;
    entry.firedAt = undefined;
    entry.detail = undefined;
  }

  async function flush(entry: TrackedRule, notified: Alert[], errors: AlertError[]): Promise<void> {
    while (entry.outbox.length > 0) {
      const next = entry.outbox[0];
      if (next === undefined) return;
      try {
        await options.notify(next);
      } catch (error) {
        errors.push({ rule: entry.rule.name, stage: "notify", error: errorMessage(error) });
        return;
      }
      entry.outbox.shift();
      notified.push(next);
    }
  }

  let running = false;

  async function evaluateOnce(snapshot: AlertSnapshot): Promise<EvaluationResult> {
    const now = clock();
    const notified: Alert[] = [];
    const errors: AlertError[] = [];
    for (const entry of tracked) step(entry, snapshot, now, errors);
    for (const entry of tracked) await flush(entry, notified, errors);
    return { notified, errors, skipped: false };
  }

  return {
    async evaluate(snapshot) {
      if (running) return { notified: [], errors: [], skipped: true };
      running = true;
      try {
        return await evaluateOnce(snapshot);
      } finally {
        running = false;
      }
    },
    state() {
      return tracked.map((entry) => {
        const state: RuleState = {
          rule: entry.rule.name,
          severity: entry.rule.severity,
          firing: entry.firing,
          undelivered: entry.outbox.length,
        };
        if (entry.since !== undefined) state.since = entry.since;
        if (entry.firedAt !== undefined) state.firedAt = entry.firedAt;
        if (entry.detail !== undefined) state.detail = entry.detail;
        return state;
      });
    },
  };
}

function numeric(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

export const DEFAULT_KEEPER_SLACK_SECONDS = 300;
export const DEFAULT_MAX_PENDING_AGE_SECONDS = 2 * DEFAULT_KEEPER_SLACK_SECONDS;
export const DEFAULT_MAX_LAG_BLOCKS = 100;
export const DEFAULT_MAX_FAILURE_RATIO = 0.2;
export const DEFAULT_FAILURE_WINDOW_SECONDS = 300;
export const DEFAULT_MIN_ATTEMPTS = 5;
export const DEFAULT_MAX_OPEN_DISPUTES = 10;
export const DEFAULT_MAX_TICK_AGE_SECONDS = 300;

export interface RuleOptions {
  forSeconds?: number;
  severity?: AlertSeverity;
}

export interface KeeperStalledOptions extends RuleOptions {
  maxPendingAgeSeconds?: number;
  maxTickAgeSeconds?: number;
}

export function keeperStalled(options: KeeperStalledOptions = {}): AlertRule {
  const max = options.maxPendingAgeSeconds ?? DEFAULT_MAX_PENDING_AGE_SECONDS;
  const maxTickAge = options.maxTickAgeSeconds ?? DEFAULT_MAX_TICK_AGE_SECONDS;
  return {
    name: "keeperStalled",
    severity: options.severity ?? "page",
    forSeconds: options.forSeconds ?? 60,
    evaluate(snapshot, context) {
      const lastTickAt = numeric(snapshot.lastKeeperTickAt);
      if (lastTickAt !== undefined) {
        const tickAge = Math.round((context.now - lastTickAt) / 1000);
        if (tickAge > maxTickAge) {
          return { firing: true, detail: `no keeper tick completed for ${tickAge}s, above ${maxTickAge}s` };
        }
      }
      const age = numeric(snapshot.oldestPendingAgeSeconds);
      if (age === undefined) {
        if (lastTickAt === undefined) return { firing: false, detail: "no pending-age sample" };
        return { firing: false, detail: `a keeper tick completed within ${maxTickAge}s` };
      }
      if (age > max) {
        return { firing: true, detail: `oldest finalizable job has waited ${age}s, above ${max}s` };
      }
      return { firing: false, detail: `oldest finalizable job has waited ${age}s, within ${max}s` };
    },
  };
}

export interface IndexerLaggingOptions extends RuleOptions {
  maxLagBlocks?: number;
}

export function indexerLagging(options: IndexerLaggingOptions = {}): AlertRule {
  const max = options.maxLagBlocks ?? DEFAULT_MAX_LAG_BLOCKS;
  return {
    name: "indexerLagging",
    severity: options.severity ?? "warn",
    forSeconds: options.forSeconds ?? 120,
    evaluate(snapshot) {
      const lag = numeric(snapshot.indexerLagBlocks);
      if (lag === undefined) return { firing: false, detail: "no lag sample" };
      if (lag > max) return { firing: true, detail: `indexer is ${lag} blocks behind the chain head, above ${max}` };
      return { firing: false, detail: `indexer is ${lag} blocks behind the chain head, within ${max}` };
    },
  };
}

export interface ProofFailureRateOptions extends RuleOptions {
  maxFailureRatio?: number;
  windowSeconds?: number;
  minAttempts?: number;
}

interface CounterSample {
  at: number;
  attempts: number;
  failures: number;
}

export function proofFailureRate(options: ProofFailureRateOptions = {}): AlertRule {
  const maxRatio = options.maxFailureRatio ?? DEFAULT_MAX_FAILURE_RATIO;
  const windowSeconds = options.windowSeconds ?? DEFAULT_FAILURE_WINDOW_SECONDS;
  const windowMs = windowSeconds * 1000;
  const minAttempts = Math.max(1, options.minAttempts ?? DEFAULT_MIN_ATTEMPTS);
  const samples: CounterSample[] = [];
  return {
    name: "proofFailureRate",
    severity: options.severity ?? "warn",
    forSeconds: options.forSeconds ?? 0,
    evaluate(snapshot, context) {
      const attempts = numeric(snapshot.proofAttempts);
      const failures = numeric(snapshot.proofFailures);
      if (attempts === undefined || failures === undefined) return { firing: false, detail: "no proof counters" };
      const last = samples[samples.length - 1];
      if (last !== undefined && (attempts < last.attempts || failures < last.failures)) samples.length = 0;
      samples.push({ at: context.now, attempts, failures });
      const cutoff = context.now - windowMs;
      let baselineIndex = 0;
      for (let i = samples.length - 1; i >= 0; i -= 1) {
        const sample = samples[i];
        if (sample !== undefined && sample.at <= cutoff) {
          baselineIndex = i;
          break;
        }
      }
      if (baselineIndex > 0) samples.splice(0, baselineIndex);
      const baseline = samples[0];
      if (baseline === undefined) return { firing: false, detail: "no proof counters" };
      const windowFailures = failures - baseline.failures;
      const windowAttempts = Math.max(attempts - baseline.attempts, windowFailures);
      if (windowAttempts < minAttempts) {
        return { firing: false, detail: `${windowAttempts} proof attempts in the last ${windowSeconds}s, below ${minAttempts}` };
      }
      const ratio = windowFailures / windowAttempts;
      const summary = `${windowFailures}/${windowAttempts} proofs failed (${(ratio * 100).toFixed(1)}%) in the last ${windowSeconds}s`;
      if (ratio > maxRatio) return { firing: true, detail: `${summary}, above ${(maxRatio * 100).toFixed(1)}%` };
      return { firing: false, detail: summary };
    },
  };
}

export interface HookWriteFailuresOptions extends RuleOptions {
  maxFailures?: number;
}

export function hookWriteFailures(options: HookWriteFailuresOptions = {}): AlertRule {
  const max = options.maxFailures ?? 0;
  return {
    name: "hookWriteFailures",
    severity: options.severity ?? "warn",
    forSeconds: options.forSeconds ?? 0,
    evaluate(snapshot) {
      const failures = numeric(snapshot.hookWriteFailures);
      if (failures === undefined) return { firing: false, detail: "no hook write sample" };
      if (failures > max) {
        return { firing: true, detail: `${failures} hook writes or hook calls failed, these should never fire` };
      }
      return { firing: false, detail: "no hook write or hook call has failed" };
    },
  };
}

export interface DisputesPilingUpOptions extends RuleOptions {
  maxOpenDisputes?: number;
}

export function disputesPilingUp(options: DisputesPilingUpOptions = {}): AlertRule {
  const max = options.maxOpenDisputes ?? DEFAULT_MAX_OPEN_DISPUTES;
  return {
    name: "disputesPilingUp",
    severity: options.severity ?? "warn",
    forSeconds: options.forSeconds ?? 0,
    evaluate(snapshot) {
      const open = numeric(snapshot.disputesOpen);
      if (open === undefined) return { firing: false, detail: "no dispute sample" };
      if (open > max) return { firing: true, detail: `${open} disputes open, above ${max}` };
      return { firing: false, detail: `${open} disputes open, within ${max}` };
    },
  };
}

export interface WebhookNotifierOptions {
  fetch?: typeof fetch;
  headers?: Record<string, string>;
  timeoutMs?: number;
}

export function webhookPayload(alert: Alert): Record<string, unknown> {
  const payload: Record<string, unknown> = {
    kind: alert.kind,
    rule: alert.rule,
    severity: alert.severity,
    at: new Date(alert.at).toISOString(),
    since: new Date(alert.since).toISOString(),
    heldForSeconds: alert.heldForSeconds,
  };
  if (alert.service !== undefined) payload.service = alert.service;
  if (alert.detail !== undefined) payload.detail = alert.detail;
  return payload;
}

export function webhookNotifier(url: string, options: WebhookNotifierOptions = {}): Notifier {
  const send = options.fetch ?? globalThis.fetch;
  const timeoutMs = options.timeoutMs ?? 10_000;
  return async (alert) => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await send(url, {
        method: "POST",
        headers: { "content-type": "application/json", ...options.headers },
        body: JSON.stringify(webhookPayload(alert)),
        signal: controller.signal,
      });
      if (!response.ok) throw new Error(`alert webhook responded with status ${response.status}`);
    } finally {
      clearTimeout(timer);
    }
  };
}

export function logNotifier(logger: Logger): Notifier {
  return async (alert) => {
    const fields: Record<string, unknown> = { rule: alert.rule, age: alert.heldForSeconds };
    if (alert.detail !== undefined) fields.reason = alert.detail;
    if (alert.kind === "resolved") {
      logger.info("alert_resolved", fields);
    } else if (alert.severity === "page") {
      logger.error("alert_firing", fields);
    } else {
      logger.warn("alert_firing", fields);
    }
  };
}
