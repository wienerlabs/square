export { createLogger, redact, DEFAULT_ALLOWLIST, RESERVED_KEYS, MAX_STRING_LENGTH } from "./logger.js";
export type { Logger, LoggerOptions, LogLevel, LogSink, LogFields, RedactOptions, RedactResult } from "./logger.js";

export {
  createMetrics,
  renderMetrics,
  metricNames,
  classifyProofFailure,
  endpointLabel,
  DEFAULT_PREFIX,
  PROOF_FAILURE_REASONS,
  UNPARSABLE_ENDPOINT_LABEL,
} from "./metrics.js";
export type {
  Metrics,
  MetricsOptions,
  MetricsSnapshot,
  MetricNames,
  ProofTimer,
  KeeperActionResult,
  HookWriteKind,
  AlertDispatchStage,
  ProofFailureReason,
} from "./metrics.js";

export { createHealth, DEFAULT_CHECK_TIMEOUT_MS } from "./health.js";
export type {
  Health,
  HealthOptions,
  HealthCheck,
  HealthState,
  HealthStatus,
  CheckDefinition,
  CheckFunction,
  CheckReport,
  CheckResult,
  VersionInfo,
} from "./health.js";

export { mountObservability, observabilityHandlers, resolvePaths, DEFAULT_PATHS } from "./http.js";
export type {
  ObservabilityOptions,
  ObservabilityPaths,
  ObservabilityResponse,
  ObservabilityHandlers,
  ResolvedPaths,
  ExpressLikeApp,
  ExpressLikeHandler,
  ExpressLikeResponse,
} from "./http.js";

export {
  createAlerting,
  keeperStalled,
  indexerLagging,
  proofFailureRate,
  disputesPilingUp,
  hookWriteFailures,
  webhookNotifier,
  webhookPayload,
  logNotifier,
  DEFAULT_KEEPER_SLACK_SECONDS,
  DEFAULT_MAX_PENDING_AGE_SECONDS,
  DEFAULT_MAX_LAG_BLOCKS,
  DEFAULT_MAX_FAILURE_RATIO,
  DEFAULT_FAILURE_WINDOW_SECONDS,
  DEFAULT_MIN_ATTEMPTS,
  DEFAULT_MAX_OPEN_DISPUTES,
  DEFAULT_MAX_TICK_AGE_SECONDS,
} from "./alerts.js";
export type {
  Alert,
  AlertKind,
  AlertRule,
  AlertSeverity,
  AlertSnapshot,
  AlertVerdict,
  AlertError,
  Alerting,
  AlertingOptions,
  EvaluationContext,
  EvaluationResult,
  RuleState,
  RuleOptions,
  KeeperStalledOptions,
  IndexerLaggingOptions,
  ProofFailureRateOptions,
  DisputesPilingUpOptions,
  HookWriteFailuresOptions,
  Notifier,
  WebhookNotifierOptions,
} from "./alerts.js";
