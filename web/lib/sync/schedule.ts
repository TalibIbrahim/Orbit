import type { SyncSchedule, SyncWindow } from "@orbit/shared";

const DAY_INDEX: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
const DAY_NAMES = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MINUTE = 60_000;
const LOOKAHEAD_MINUTES = 8 * 24 * 60;

const formatters = new Map<string, Intl.DateTimeFormat>();

function formatterFor(timeZone: string): Intl.DateTimeFormat {
  let f = formatters.get(timeZone);
  if (f) return f;
  const opts: Intl.DateTimeFormatOptions = {
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  };
  try {
    f = new Intl.DateTimeFormat("en-US", { ...opts, timeZone });
  } catch {
    f = new Intl.DateTimeFormat("en-US", { ...opts, timeZone: "UTC" });
  }
  formatters.set(timeZone, f);
  return f;
}

/** Local weekday (0 = Sunday) and minutes since local midnight in an IANA zone (invalid zone -> UTC). */
export function localParts(now: number, timeZone: string): { day: number; minutes: number } {
  const parts = formatterFor(timeZone).formatToParts(new Date(now));
  let day = 0;
  let hour = 0;
  let minute = 0;
  for (const p of parts) {
    if (p.type === "weekday") day = DAY_INDEX[p.value] ?? 0;
    else if (p.type === "hour") hour = Number(p.value) % 24;
    else if (p.type === "minute") minute = Number(p.value);
  }
  return { day, minutes: hour * 60 + minute };
}

/** Parse "HH:MM" (00:00..23:59) to minutes since midnight, or null. */
export function parseHHMM(s: string): number | null {
  if (typeof s !== "string") return null;
  const m = /^(\d{2}):(\d{2})$/.exec(s);
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (h > 23 || min > 59) return null;
  return h * 60 + min;
}

/** Validate and normalise untrusted input into a SyncSchedule. */
export function validateSchedule(
  input: unknown,
): { ok: true; schedule: SyncSchedule } | { ok: false; error: string } {
  if (!input || typeof input !== "object") return { ok: false, error: "schedule must be an object" };
  const o = input as Record<string, unknown>;
  if (typeof o.enabled !== "boolean") return { ok: false, error: "enabled must be a boolean" };
  if (typeof o.timezone !== "string" || !o.timezone) return { ok: false, error: "timezone must be a string" };
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: o.timezone });
  } catch {
    return { ok: false, error: `unknown timezone: ${o.timezone}` };
  }
  if (!Array.isArray(o.windows)) return { ok: false, error: "windows must be an array" };
  if (o.windows.length > 14) return { ok: false, error: "at most 14 windows" };
  const windows: SyncWindow[] = [];
  for (let i = 0; i < o.windows.length; i++) {
    const w = o.windows[i] as Record<string, unknown> | null;
    if (!w || typeof w !== "object") return { ok: false, error: `window ${i + 1}: must be an object` };
    if (!Array.isArray(w.days) || w.days.length === 0)
      return { ok: false, error: `window ${i + 1}: choose at least one day` };
    for (const d of w.days) {
      if (!Number.isInteger(d) || d < 0 || d > 6)
        return { ok: false, error: `window ${i + 1}: days must be integers 0-6` };
    }
    const days = [...new Set(w.days as number[])].sort((a, b) => a - b);
    if (typeof w.start !== "string" || parseHHMM(w.start) === null)
      return { ok: false, error: `window ${i + 1}: invalid start time` };
    if (typeof w.end !== "string" || parseHHMM(w.end) === null)
      return { ok: false, error: `window ${i + 1}: invalid end time` };
    windows.push({ days, start: w.start, end: w.end });
  }
  if (o.enabled && windows.length === 0) return { ok: false, error: "add at least one window" };
  return { ok: true, schedule: { enabled: o.enabled, timezone: o.timezone, windows } };
}

function insideAny(windows: SyncWindow[], day: number, t: number): boolean {
  for (const w of windows) {
    const S = parseHHMM(w.start);
    const E = parseHHMM(w.end);
    if (S === null || E === null) continue;
    for (const d of w.days) {
      if (S < E) {
        if (day === d && t >= S && t < E) return true;
      } else if ((day === d && t >= S) || (day === (d + 1) % 7 && t < E)) {
        return true;
      }
    }
  }
  return false;
}

/** True when sync is permitted at `now` (always true if the schedule is disabled). */
export function scheduleAllows(s: SyncSchedule, now: number): boolean {
  if (!s.enabled) return true;
  const { day, minutes } = localParts(now, s.timezone);
  return insideAny(s.windows, day, minutes);
}

/** Next instant (ms, second 0) at which scheduleAllows flips; null if disabled or no flip within 8 days. */
export function nextChange(s: SyncSchedule, now: number): number | null {
  if (!s.enabled) return null;
  const current = scheduleAllows(s, now);
  const first = (Math.floor(now / MINUTE) + 1) * MINUTE;
  for (let i = 0; i < LOOKAHEAD_MINUTES; i++) {
    const t = first + i * MINUTE;
    if (scheduleAllows(s, t) !== current) return t;
  }
  return null;
}

function describeDays(days: number[]): string {
  if (days.length === 7) return "every day";
  // Monday-first order so Sat, Sun are adjacent
  const order = [1, 2, 3, 4, 5, 6, 0].filter((d) => days.includes(d));
  const runs: number[][] = [];
  for (const d of order) {
    const last = runs[runs.length - 1];
    const prev = last?.[last.length - 1];
    if (last && prev !== undefined && (prev + 1) % 7 === d && d !== 1) last.push(d);
    else runs.push([d]);
  }
  return runs
    .map((r) =>
      r.length >= 3
        ? `${DAY_NAMES[r[0]]}–${DAY_NAMES[r[r.length - 1]]}`
        : r.map((d) => DAY_NAMES[d]).join(", "),
    )
    .join(", ");
}

/** Human-readable summary, e.g. "Sync allowed Mon–Fri 01:00–07:00 (Europe/Berlin)". */
export function describeSchedule(s: SyncSchedule): string {
  if (!s.enabled) return "No schedule (sync always allowed)";
  const parts = s.windows.map((w) => {
    const days = describeDays([...new Set(w.days)].sort((a, b) => a - b));
    return w.start === w.end ? `${days} all day` : `${days} ${w.start}–${w.end}`;
  });
  return `Sync allowed ${parts.join(", ")} (${s.timezone})`;
}
