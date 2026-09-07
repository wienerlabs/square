import { getAddress, isAddress, zeroAddress } from "viem";

const USDC_UNIT = 1_000_000n;

function groupThousands(digits: string): string {
  return digits.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

export function formatUsdc(value: bigint, minimumFraction = 2): string {
  const negative = value < 0n;
  const abs = negative ? -value : value;
  const whole = abs / USDC_UNIT;
  const fraction = abs % USDC_UNIT;
  let fractionText = fraction.toString().padStart(6, "0").replace(/0+$/, "");
  if (fractionText.length < minimumFraction) fractionText = fractionText.padEnd(minimumFraction, "0");
  const wholeText = groupThousands(whole.toString());
  const text = fractionText.length > 0 ? `${wholeText}.${fractionText}` : wholeText;
  return negative ? `-${text}` : text;
}

export function parseUsdc(input: string): bigint | null {
  const trimmed = input.trim().replace(/,/g, "");
  if (!/^\d+(\.\d{1,6})?$/.test(trimmed)) return null;
  const [wholePart, fractionPart] = trimmed.split(".");
  return BigInt(wholePart ?? "0") * USDC_UNIT + BigInt((fractionPart ?? "").padEnd(6, "0"));
}

export function formatBigint(value: bigint): string {
  return groupThousands(value.toString());
}

export function shortAddress(address: string): string {
  if (!isAddress(address)) return address;
  const checksum = getAddress(address);
  return `${checksum.slice(0, 6)}…${checksum.slice(-4)}`;
}

export function shortHash(hash: string): string {
  if (hash.length <= 18) return hash;
  return `${hash.slice(0, 10)}…${hash.slice(-6)}`;
}

export function isZeroAddress(address: string): boolean {
  return address.toLowerCase() === zeroAddress;
}

export function formatTimestamp(seconds: number | bigint): string {
  const value = Number(seconds);
  if (!Number.isFinite(value) || value <= 0) return "Not set";
  return new Date(value * 1000).toLocaleString("en-GB", {
    year: "numeric",
    month: "short",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
    timeZoneName: "short",
  });
}

export function formatDuration(totalSeconds: number): string {
  const seconds = Math.max(0, Math.floor(totalSeconds));
  const days = Math.floor(seconds / 86_400);
  const hours = Math.floor((seconds % 86_400) / 3_600);
  const minutes = Math.floor((seconds % 3_600) / 60);
  const rest = seconds % 60;
  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${minutes}m`;
  if (minutes > 0) return `${minutes}m ${rest}s`;
  return `${rest}s`;
}

export function formatCountdown(target: number, now: number): string {
  const remaining = target - now;
  return remaining > 0 ? `${formatDuration(remaining)} left` : "Closed";
}

export function formatBps(bps: number | bigint): string {
  const percent = Number(bps) / 100;
  return `${percent.toFixed(2).replace(/\.?0+$/, "")}%`;
}

export const STATUS_LABELS = ["Open", "Funded", "Submitted", "Completed", "Rejected", "Expired"] as const;

export function statusLabel(status: number): string {
  return STATUS_LABELS[status] ?? `Status ${status}`;
}

function pad(value: number): string {
  return value.toString().padStart(2, "0");
}

export function toDatetimeLocal(seconds: number): string {
  const date = new Date(seconds * 1000);
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

export function fromDatetimeLocal(value: string): number | null {
  if (value.trim().length === 0) return null;
  const millis = new Date(value).getTime();
  if (!Number.isFinite(millis)) return null;
  return Math.floor(millis / 1000);
}

export function truncate(text: string, max = 160): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}
