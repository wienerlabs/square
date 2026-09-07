export interface CheckResult {
  ok: boolean;
  detail?: string;
}

export type CheckFunction = () => Promise<CheckResult> | CheckResult;

export interface CheckDefinition {
  check: CheckFunction;
  critical?: boolean;
  timeoutMs?: number;
}

export type HealthCheck = CheckFunction | CheckDefinition;

export type HealthState = "healthy" | "degraded" | "unhealthy";

export interface CheckReport {
  ok: boolean;
  critical: boolean;
  latencyMs: number;
  detail?: string;
}

export interface HealthStatus {
  status: HealthState;
  service: string;
  version: string;
  checks: Record<string, CheckReport>;
  uptimeSeconds: number;
}

export interface VersionInfo {
  service: string;
  version: string;
  commit?: string;
  node: string;
}

export interface HealthOptions {
  service: string;
  version: string;
  checks?: Record<string, HealthCheck>;
  commit?: string;
  checkTimeoutMs?: number;
}

export interface Health {
  status(): Promise<HealthStatus>;
  version(): VersionInfo;
}

interface NormalizedCheck {
  name: string;
  check: CheckFunction;
  critical: boolean;
  timeoutMs: number;
}

export const DEFAULT_CHECK_TIMEOUT_MS = 5000;
const MAX_DETAIL_LENGTH = 1024;

function normalize(name: string, entry: HealthCheck, defaultTimeoutMs: number): NormalizedCheck {
  if (typeof entry === "function") {
    return { name, check: entry, critical: false, timeoutMs: defaultTimeoutMs };
  }
  return {
    name,
    check: entry.check,
    critical: entry.critical ?? false,
    timeoutMs: entry.timeoutMs ?? defaultTimeoutMs,
  };
}

function withTimeout(check: CheckFunction, timeoutMs: number): Promise<CheckResult> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`check timed out after ${timeoutMs}ms`)), timeoutMs);
    Promise.resolve()
      .then(() => check())
      .then(
        (result) => {
          clearTimeout(timer);
          resolve(result);
        },
        (error: unknown) => {
          clearTimeout(timer);
          reject(error instanceof Error ? error : new Error(String(error)));
        },
      );
  });
}

async function run(entry: NormalizedCheck): Promise<CheckReport> {
  const started = performance.now();
  let result: CheckResult;
  try {
    result = await withTimeout(entry.check, entry.timeoutMs);
  } catch (error) {
    result = { ok: false, detail: error instanceof Error ? error.message : String(error) };
  }
  const report: CheckReport = {
    ok: result !== null && typeof result === "object" && result.ok === true,
    critical: entry.critical,
    latencyMs: Math.round(performance.now() - started),
  };
  if (result !== null && typeof result === "object" && typeof result.detail === "string" && result.detail.length > 0) {
    report.detail = result.detail.slice(0, MAX_DETAIL_LENGTH);
  }
  return report;
}

function aggregate(reports: ReadonlyArray<readonly [string, CheckReport]>): HealthState {
  let state: HealthState = "healthy";
  for (const [, report] of reports) {
    if (report.ok) continue;
    if (report.critical) return "unhealthy";
    state = "degraded";
  }
  return state;
}

export function createHealth(options: HealthOptions): Health {
  const { service, version } = options;
  const timeoutMs = options.checkTimeoutMs ?? DEFAULT_CHECK_TIMEOUT_MS;
  const entries = Object.entries(options.checks ?? {}).map(([name, entry]) => normalize(name, entry, timeoutMs));

  return {
    async status() {
      const reports = await Promise.all(entries.map(async (entry) => [entry.name, await run(entry)] as const));
      const checks: Record<string, CheckReport> = {};
      for (const [name, report] of reports) checks[name] = report;
      return {
        status: aggregate(reports),
        service,
        version,
        checks,
        uptimeSeconds: Math.floor(process.uptime()),
      };
    },
    version() {
      const info: VersionInfo = { service, version, node: process.version };
      const commit = options.commit ?? process.env.GIT_SHA;
      if (commit !== undefined && commit.length > 0) info.commit = commit;
      return info;
    },
  };
}
