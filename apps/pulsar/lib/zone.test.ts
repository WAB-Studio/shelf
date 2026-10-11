import assert from "node:assert/strict";
import test from "node:test";

import {
  civilDateInZone,
  civilDateShort,
  civilDayMonthShort,
  clockOverride,
  timeInZone,
  todayInZone,
} from "./zone";

test("an instant at 23:30 Bogotá reads 23:30 whatever the process zone", () => {
  assert.equal(timeInZone("2026-09-29T04:30:00Z"), "23:30");
});

test("04:59 UTC reads the Bogotá hour before midnight", () => {
  assert.equal(timeInZone("2026-09-29T04:59:00Z"), "23:59");
});

test("midnight Bogotá reads 00:00, never 24:00", () => {
  assert.equal(timeInZone("2026-09-29T05:05:00Z"), "00:05");
});

test("a civil day reads as weekday, day and three-letter month whatever the process zone", () => {
  assert.equal(civilDateShort("2026-09-22"), "martes 22 sep");
  assert.equal(civilDateShort("2026-01-01"), "jueves 1 ene");
  assert.equal(civilDateShort("2026-12-31"), "jueves 31 dic");
});

test("a civil day reads as day and three-letter month, no weekday, whatever the process zone", () => {
  assert.equal(civilDayMonthShort("2026-09-13"), "13 sep");
  assert.equal(civilDayMonthShort("2026-01-01"), "1 ene");
  assert.equal(civilDayMonthShort("2026-12-31"), "31 dic");
});

const LOCAL_DB = "postgresql://postgres:postgres@127.0.0.1:54322/postgres";
const REMOTE_DB = "postgresql://postgres.abc:pw@aws-0-us-east-1.pooler.supabase.com:6543/postgres";

test("no PULSAR_CLOCK, no override, whatever the database", () => {
  assert.equal(clockOverride({}), null);
  assert.equal(clockOverride({ PULSAR_CLOCK: "", DATABASE_URL: REMOTE_DB }), null);
});

test("PULSAR_CLOCK against the local stack is today", () => {
  assert.equal(clockOverride({ PULSAR_CLOCK: "2026-10-21", DATABASE_URL: LOCAL_DB }), "2026-10-21");
  assert.equal(
    clockOverride({ PULSAR_CLOCK: "2026-10-21", DATABASE_URL: "postgres://u:p@localhost:5432/db" }),
    "2026-10-21",
  );
});

test("PULSAR_CLOCK against any other database is refused", () => {
  assert.throws(() => clockOverride({ PULSAR_CLOCK: "2026-10-21", DATABASE_URL: REMOTE_DB }), /PULSAR_CLOCK/);
  assert.throws(() => clockOverride({ PULSAR_CLOCK: "2026-10-21" }), /PULSAR_CLOCK/);
  assert.throws(() => clockOverride({ PULSAR_CLOCK: "2026-10-21", DATABASE_URL: "not a url" }), /PULSAR_CLOCK/);
  assert.throws(
    () => clockOverride({ PULSAR_CLOCK: "2026-10-21", DATABASE_URL: "postgres://u:p@127.0.0.1.pooler.supabase.com:6543/db" }),
    /PULSAR_CLOCK/,
  );
  assert.throws(
    () => clockOverride({ PULSAR_CLOCK: "2026-10-21", DATABASE_URL: "postgres://127.0.0.1@aws-0.pooler.supabase.com:6543/db" }),
    /PULSAR_CLOCK/,
  );
});

test("PULSAR_CLOCK on Vercel is refused even against a loopback database", () => {
  assert.throws(() => clockOverride({ PULSAR_CLOCK: "2026-10-21", DATABASE_URL: LOCAL_DB, VERCEL: "1" }), /PULSAR_CLOCK/);
});

test("a PULSAR_CLOCK that names no real day is refused", () => {
  assert.throws(() => clockOverride({ PULSAR_CLOCK: "2026-02-31", DATABASE_URL: LOCAL_DB }), /PULSAR_CLOCK/);
  assert.throws(() => clockOverride({ PULSAR_CLOCK: "21/10/2026", DATABASE_URL: LOCAL_DB }), /PULSAR_CLOCK/);
});

test("todayInZone reads PULSAR_CLOCK from the process, and the real day without it", () => {
  const saved = { clock: process.env.PULSAR_CLOCK, db: process.env.DATABASE_URL };
  try {
    process.env.DATABASE_URL = LOCAL_DB;
    process.env.PULSAR_CLOCK = "2031-03-21";
    assert.equal(todayInZone(), "2031-03-21");
    delete process.env.PULSAR_CLOCK;
    assert.equal(todayInZone(), civilDateInZone(new Date()));
    process.env.PULSAR_CLOCK = "2031-03-21";
    process.env.DATABASE_URL = REMOTE_DB;
    assert.throws(() => todayInZone(), /PULSAR_CLOCK/);
  } finally {
    for (const [key, value] of [
      ["PULSAR_CLOCK", saved.clock],
      ["DATABASE_URL", saved.db],
    ] as const) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});
