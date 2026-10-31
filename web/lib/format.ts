const BYTE_UNITS = ["B", "KB", "MB", "GB", "TB", "PB"];

/** Binary units (1024), e.g. "1.2 GB". */
export function formatBytes(bytes: number | null | undefined, digits = 1): string {
  if (bytes == null || !Number.isFinite(bytes)) return "—";
  const sign = bytes < 0 ? "-" : "";
  let v = Math.abs(bytes);
  let i = 0;
  while (v >= 1024 && i < BYTE_UNITS.length - 1) {
    v /= 1024;
    i++;
  }
  return `${sign}${i === 0 ? Math.round(v) : v.toFixed(digits)} ${BYTE_UNITS[i]}`;
}

/** bytes/second -> "1.2 MB/s". */
export function formatRate(bytesPerSec: number | null | undefined, digits = 1): string {
  if (bytesPerSec == null || !Number.isFinite(bytesPerSec)) return "—";
  return `${formatBytes(bytesPerSec, digits)}/s`;
}

/** 0..100 value -> "42%" (one decimal below 10). */
export function formatPercent(value: number | null | undefined, digits?: number): string {
  if (value == null || !Number.isFinite(value)) return "—";
  const d = digits ?? (Math.abs(value) < 10 && value !== 0 ? 1 : 0);
  return `${value.toFixed(d)}%`;
}

/** Milliseconds -> "3d 4h", "2h 5m", "45s". Two most significant units. */
export function formatDuration(ms: number | null | undefined): string {
  if (ms == null || !Number.isFinite(ms) || ms < 0) return "—";
  const s = Math.floor(ms / 1000);
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m ${s % 60}s`;
  return `${s}s`;
}

/** Epoch ms -> "2 min ago" / "just now" / "in 3 min". */
export function timeAgo(ts: number | null | undefined, now: number = Date.now()): string {
  if (ts == null || !Number.isFinite(ts)) return "never";
  const diff = now - ts;
  const abs = Math.abs(diff);
  const suffix = (n: number, unit: string) => {
    const label = `${n} ${unit}`;
    return diff >= 0 ? `${label} ago` : `in ${label}`;
  };
  if (abs < 45_000) return "just now";
  if (abs < 90_000) return suffix(1, "min");
  if (abs < 3_600_000) return suffix(Math.round(abs / 60_000), "min");
  if (abs < 86_400_000) return suffix(Math.round(abs / 3_600_000), "h");
  if (abs < 30 * 86_400_000) return suffix(Math.round(abs / 86_400_000), "d");
  return new Date(ts).toLocaleDateString();
}

/** Number of days -> "1 day" / "12 days" / "—"; fractional values rounded. */
export function formatDays(days: number | null | undefined): string {
  if (days == null || !Number.isFinite(days)) return "—";
  const n = days < 10 && days % 1 !== 0 ? Math.round(days * 10) / 10 : Math.round(days);
  return `${n} ${n === 1 ? "day" : "days"}`;
}
