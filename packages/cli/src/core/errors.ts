/**
 * Every failure the CLI reports is one of these. The exit codes come from
 * sysexits.h, so a shell script wrapping the CLI can tell a bad argument from
 * an unreachable RPC without parsing English.
 */
export const ExitCode = {
  Ok: 0,
  Generic: 1,
  ValidationError: 65,
  NetworkError: 69,
  NotFound: 70,
  WalletError: 77,
  ConfigError: 78,
} as const;

export type ExitCodeValue = (typeof ExitCode)[keyof typeof ExitCode];

export class MandateError extends Error {
  readonly exitCode: ExitCodeValue;
  readonly hint: string | undefined;

  constructor(message: string, exitCode: ExitCodeValue = ExitCode.Generic, hint?: string) {
    super(message);
    this.name = "MandateError";
    this.exitCode = exitCode;
    this.hint = hint;
  }
}

export class ValidationError extends MandateError {
  constructor(message: string, hint?: string) {
    super(message, ExitCode.ValidationError, hint);
    this.name = "ValidationError";
  }
}

export class NetworkError extends MandateError {
  constructor(message: string, hint?: string) {
    super(message, ExitCode.NetworkError, hint);
    this.name = "NetworkError";
  }
}

export class NotFoundError extends MandateError {
  constructor(message: string, hint?: string) {
    super(message, ExitCode.NotFound, hint);
    this.name = "NotFoundError";
  }
}

export class WalletError extends MandateError {
  constructor(message: string, hint?: string) {
    super(message, ExitCode.WalletError, hint);
    this.name = "WalletError";
  }
}

export class ConfigError extends MandateError {
  constructor(message: string, hint?: string) {
    super(message, ExitCode.ConfigError, hint);
    this.name = "ConfigError";
  }
}

export function isMandateError(e: unknown): e is MandateError {
  return e instanceof MandateError;
}
