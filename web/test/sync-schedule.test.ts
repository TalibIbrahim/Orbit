import { test } from "node:test";
import assert from "node:assert/strict";
import {
  localParts,
  parseHHMM,
  validateSchedule,
  scheduleAllows,
  nextChange,
  describeSchedule,
} from "../lib/sync/schedule.ts";

// 2026-10-26 is a Monday.
const at = (iso: string) => Date.parse(iso);
const utc = (windows: { days: number[]; start: string; end: string }[]) => ({
  enabled: true,
  timezone: "UTC",
  windows,
});

test("parseHHMM", () => {
  assert.equal(parseHHMM("00:00"), 0);
  assert.equal(parseHHMM("23:59"), 1439);
  assert.equal(parseHHMM("07:30"), 450);
  for (const bad of ["24:00", "12:60", "7:30", "1230", "", "ab:cd"]) assert.equal(parseHHMM(bad), null);
});

test("localParts and invalid zone fallback", () => {
  assert.deepEqual(localParts(at("2026-10-26T00:00:00Z"), "UTC"), { day: 1, minutes: 0 });
  assert.deepEqual(localParts(at("2026-10-25T23:59:00Z"), "UTC"), { day: 0, minutes: 1439 });
  assert.deepEqual(localParts(at("2026-10-26T10:15:00Z"), "Not/AZone"), { day: 1, minutes: 615 });
});

test("validateSchedule", () => {
  const ok = validateSchedule({
    enabled: true,
    timezone: "UTC",
    windows: [{ days: [3, 1, 3], start: "01:00", end: "07:00" }],
  });
  assert.ok(ok.ok);
  if (ok.ok) assert.deepEqual(ok.schedule.windows[0].days, [1, 3]);
  const bad = (x: unknown, re: RegExp) => {
    const r = validateSchedule(x);
    assert.ok(!r.ok);
    if (!r.ok) assert.match(r.error, re);
  };
  bad(null, /object/);
  bad({ enabled: "yes", timezone: "UTC", windows: [] }, /enabled/);
  bad({ enabled: true, timezone: "Mars/Base", windows: [] }, /timezone/);
  bad({ enabled: true, timezone: "UTC", windows: [] }, /at least one window/);
  bad({ enabled: true, timezone: "UTC", windows: "x" }, /array/);
  bad({ enabled: true, timezone: "UTC", windows: Array(15).fill({ days: [1], start: "01:00", end: "02:00" }) }, /14/);
  bad({ enabled: true, timezone: "UTC", windows: [{ days: [], start: "01:00", end: "02:00" }] }, /day/);
  bad({ enabled: true, timezone: "UTC", windows: [{ days: [7], start: "01:00", end: "02:00" }] }, /0-6/);
  bad({ enabled: true, timezone: "UTC", windows: [{ days: [1], start: "25:00", end: "02:00" }] }, /start/);
  bad({ enabled: true, timezone: "UTC", windows: [{ days: [1], start: "01:00", end: "2" }] }, /end/);
  assert.ok(validateSchedule({ enabled: false, timezone: "UTC", windows: [] }).ok);
});

test("same-day window boundaries", () => {
  const s = utc([{ days: [1], start: "01:00", end: "07:00" }]);
  assert.equal(scheduleAllows(s, at("2026-10-26T00:59:00Z")), false);
  assert.equal(scheduleAllows(s, at("2026-10-26T01:00:00Z")), true);
  assert.equal(scheduleAllows(s, at("2026-10-26T06:59:00Z")), true);
  assert.equal(scheduleAllows(s, at("2026-10-26T07:00:00Z")), false);
  assert.equal(scheduleAllows(s, at("2026-10-27T03:00:00Z")), false);
});

test("overnight window incl. Saturday -> Sunday wrap", () => {
  const s = utc([{ days: [1, 6], start: "22:00", end: "06:00" }]);
  assert.equal(scheduleAllows(s, at("2026-10-26T21:59:00Z")), false);
  assert.equal(scheduleAllows(s, at("2026-10-26T22:00:00Z")), true);
  assert.equal(scheduleAllows(s, at("2026-10-27T05:59:00Z")), true); // Tue morning
  assert.equal(scheduleAllows(s, at("2026-10-27T06:00:00Z")), false);
  assert.equal(scheduleAllows(s, at("2026-10-26T03:00:00Z")), false); // Mon early: Sunday not listed
  assert.equal(scheduleAllows(s, at("2026-10-31T23:00:00Z")), true); // Sat night
  assert.equal(scheduleAllows(s, at("2026-11-01T02:00:00Z")), true); // Sun morning (6 -> 0)
  assert.equal(scheduleAllows(s, at("2026-11-01T06:00:00Z")), false);
});

test("24 h window and multiple windows", () => {
  const all = utc([{ days: [2], start: "00:00", end: "00:00" }]);
  assert.equal(scheduleAllows(all, at("2026-10-27T00:00:00Z")), true);
  assert.equal(scheduleAllows(all, at("2026-10-27T23:59:00Z")), true);
  assert.equal(scheduleAllows(all, at("2026-10-28T00:00:00Z")), false);
  assert.equal(scheduleAllows(all, at("2026-10-26T23:59:00Z")), false);
  const multi = utc([
    { days: [1], start: "01:00", end: "02:00" },
    { days: [1], start: "12:00", end: "13:00" },
  ]);
  assert.equal(scheduleAllows(multi, at("2026-10-26T01:30:00Z")), true);
  assert.equal(scheduleAllows(multi, at("2026-10-26T06:00:00Z")), false);
  assert.equal(scheduleAllows(multi, at("2026-10-26T12:30:00Z")), true);
});

test("disabled schedule", () => {
  const s = { enabled: false, timezone: "UTC", windows: [] };
  assert.equal(scheduleAllows(s, Date.now()), true);
  assert.equal(nextChange(s, Date.now()), null);
});

test("non-UTC zone (Asia/Kolkata)", () => {
  assert.deepEqual(localParts(at("2026-10-26T18:30:00Z"), "Asia/Kolkata"), { day: 2, minutes: 0 });
  const s = { enabled: true, timezone: "Asia/Kolkata", windows: [{ days: [1], start: "01:00", end: "07:00" }] };
  assert.equal(scheduleAllows(s, at("2026-10-25T19:30:00Z")), true); // Mon 01:00 IST
  assert.equal(scheduleAllows(s, at("2026-10-25T19:29:00Z")), false);
  assert.equal(scheduleAllows(s, at("2026-10-26T01:30:00Z")), false); // 07:00 IST
});

test("DST zone (Europe/Berlin) around 2026-10-25", () => {
  assert.deepEqual(localParts(at("2026-10-24T22:30:00Z"), "Europe/Berlin"), { day: 0, minutes: 30 }); // CEST +2
  assert.deepEqual(localParts(at("2026-10-26T23:30:00Z"), "Europe/Berlin"), { day: 2, minutes: 30 }); // CET +1
  const s = { enabled: true, timezone: "Europe/Berlin", windows: [{ days: [1], start: "01:00", end: "07:00" }] };
  assert.equal(scheduleAllows(s, at("2026-10-26T00:00:00Z")), true); // 01:00 CET
  assert.equal(scheduleAllows(s, at("2026-10-25T23:59:00Z")), false);
  assert.equal(scheduleAllows(s, at("2026-10-18T23:00:00Z")), true); // 01:00 CEST the week before
  assert.equal(scheduleAllows(s, at("2026-10-18T22:59:00Z")), false);
});

test("nextChange", () => {
  const s = utc([{ days: [1], start: "01:00", end: "07:00" }]);
  assert.equal(nextChange(s, at("2026-10-26T00:30:00Z")), at("2026-10-26T01:00:00Z"));
  assert.equal(nextChange(s, at("2026-10-26T01:00:00Z")), at("2026-10-26T07:00:00Z"));
  assert.equal(nextChange(s, at("2026-10-26T03:10:45Z")), at("2026-10-26T07:00:00Z"));
  assert.equal(nextChange(s, at("2026-10-26T07:00:00Z")), at("2026-11-02T01:00:00Z"));
  const always = utc([{ days: [0, 1, 2, 3, 4, 5, 6], start: "00:00", end: "00:00" }]);
  assert.equal(nextChange(always, at("2026-10-26T00:30:00Z")), null);
});

test("describeSchedule", () => {
  assert.equal(
    describeSchedule({ enabled: false, timezone: "UTC", windows: [] }),
    "No schedule (sync always allowed)",
  );
  assert.equal(
    describeSchedule({
      enabled: true,
      timezone: "Europe/Berlin",
      windows: [
        { days: [1, 2, 3, 4, 5], start: "01:00", end: "07:00" },
        { days: [6, 0], start: "08:00", end: "20:00" },
      ],
    }),
    "Sync allowed Mon–Fri 01:00–07:00, Sat, Sun 08:00–20:00 (Europe/Berlin)",
  );
  assert.equal(
    describeSchedule(utc([{ days: [0, 1, 2, 3, 4, 5, 6], start: "09:00", end: "09:00" }])),
    "Sync allowed every day all day (UTC)",
  );
});
