import type { Env } from "./types";

/**
 * Schema bootstrap.
 *
 * The previous build executed ~27 DDL/seed statements against D1 on every cold
 * isolate, before every API request. Workers recycles isolates constantly, so
 * that alone burned a large share of the daily D1 allowance.
 *
 * Now a single indexed one-row lookup of settings.schema_version decides whether
 * any work is needed. Bump SCHEMA_VERSION whenever the statements below change.
 */
export const SCHEMA_VERSION = "0.6.1";

const TABLES = [
  `CREATE TABLE IF NOT EXISTS settings(key TEXT PRIMARY KEY,value TEXT NOT NULL,updated_at TEXT NOT NULL DEFAULT(datetime('now')))`,
  `CREATE TABLE IF NOT EXISTS programs(id INTEGER PRIMARY KEY AUTOINCREMENT,name TEXT NOT NULL UNIQUE,required_hours REAL NOT NULL DEFAULT 0,color TEXT,created_at TEXT NOT NULL DEFAULT(datetime('now')),updated_at TEXT NOT NULL DEFAULT(datetime('now')))`,
  `CREATE TABLE IF NOT EXISTS families(id INTEGER PRIMARY KEY AUTOINCREMENT,parent_name TEXT,parent_email TEXT UNIQUE,secondary_email TEXT,phone TEXT,created_at TEXT NOT NULL DEFAULT(datetime('now')),updated_at TEXT NOT NULL DEFAULT(datetime('now')))`,
  `CREATE TABLE IF NOT EXISTS students(id INTEGER PRIMARY KEY AUTOINCREMENT,family_id INTEGER,student_name TEXT NOT NULL,program_id INTEGER,graduation_year INTEGER,created_at TEXT NOT NULL DEFAULT(datetime('now')),updated_at TEXT NOT NULL DEFAULT(datetime('now')))`,
  `CREATE TABLE IF NOT EXISTS events(id INTEGER PRIMARY KEY AUTOINCREMENT,signupgenius_id TEXT NOT NULL UNIQUE,title TEXT NOT NULL,event_date TEXT,location TEXT,affiliation TEXT,raw_json TEXT,updated_at TEXT NOT NULL DEFAULT(datetime('now')),created_at TEXT NOT NULL DEFAULT(datetime('now')))`,
  `CREATE TABLE IF NOT EXISTS volunteer_slots(id INTEGER PRIMARY KEY AUTOINCREMENT,event_id INTEGER NOT NULL,signupgenius_slot_id TEXT NOT NULL UNIQUE,title TEXT NOT NULL,slot_date TEXT,start_time TEXT,end_time TEXT,hours REAL NOT NULL DEFAULT 0,status TEXT NOT NULL DEFAULT 'unknown',volunteer_name TEXT,volunteer_email TEXT,raw_json TEXT,quantity INTEGER NOT NULL DEFAULT 1,hours_known INTEGER NOT NULL DEFAULT 0,created_at TEXT NOT NULL DEFAULT(datetime('now')),updated_at TEXT NOT NULL DEFAULT(datetime('now')))`,
  `CREATE TABLE IF NOT EXISTS sync_log(id INTEGER PRIMARY KEY AUTOINCREMENT,sync_time TEXT NOT NULL,records INTEGER NOT NULL DEFAULT 0,status TEXT NOT NULL,message TEXT)`,
  `CREATE TABLE IF NOT EXISTS contact_mappings(id INTEGER PRIMARY KEY AUTOINCREMENT,email TEXT NOT NULL,parent_name TEXT,student_name TEXT,program TEXT NOT NULL,source_tab TEXT,source_type TEXT NOT NULL DEFAULT 'program_roster',updated_at TEXT NOT NULL DEFAULT(datetime('now')))`,
  `CREATE TABLE IF NOT EXISTS contact_sync_log(id INTEGER PRIMARY KEY AUTOINCREMENT,sync_time TEXT NOT NULL,records INTEGER NOT NULL DEFAULT 0,status TEXT NOT NULL,message TEXT)`,
  `CREATE TABLE IF NOT EXISTS volunteer_program_overrides(id INTEGER PRIMARY KEY AUTOINCREMENT,email TEXT NOT NULL,volunteer_name TEXT,program TEXT NOT NULL,created_at TEXT NOT NULL DEFAULT(datetime('now')),updated_at TEXT NOT NULL DEFAULT(datetime('now')),UNIQUE(email,program))`,
  `CREATE TABLE IF NOT EXISTS volunteer_affiliation_history(id INTEGER PRIMARY KEY AUTOINCREMENT,email TEXT NOT NULL,volunteer_name TEXT,program TEXT NOT NULL,effective_from TEXT NOT NULL,effective_to TEXT,created_at TEXT NOT NULL DEFAULT(datetime('now')),updated_at TEXT NOT NULL DEFAULT(datetime('now')),UNIQUE(email,program,effective_from))`
];

// ALTER TABLE ... ADD COLUMN has no IF NOT EXISTS in SQLite, so each one is run
// on its own and a "duplicate column name" error is treated as success.
const COLUMNS: Array<[string, string]> = [
  ["events", "ALTER TABLE events ADD COLUMN affiliation TEXT"],
  ["volunteer_slots", "ALTER TABLE volunteer_slots ADD COLUMN quantity INTEGER NOT NULL DEFAULT 1"],
  ["volunteer_slots", "ALTER TABLE volunteer_slots ADD COLUMN hours_known INTEGER NOT NULL DEFAULT 0"],
  // v0.6.0 columns: these replace repeated json_extract() calls over raw_json,
  // which forced a full scan plus a JSON parse of every row on every dashboard query.
  ["volunteer_slots", "ALTER TABLE volunteer_slots ADD COLUMN start_epoch INTEGER"],
  ["volunteer_slots", "ALTER TABLE volunteer_slots ADD COLUMN slot_day TEXT"],
  ["volunteer_slots", "ALTER TABLE volunteer_slots ADD COLUMN source TEXT NOT NULL DEFAULT 'signupgenius'"],
  ["volunteer_slots", "ALTER TABLE volunteer_slots ADD COLUMN content_hash TEXT"]
];

/**
 * D1 bills rows_written per row PLUS one per index entry touched. Every extra
 * index on volunteer_slots therefore multiplies the cost of the sync, which is
 * the hot write path. This list is deliberately minimal: three indexes plus the
 * implicit UNIQUE index on signupgenius_slot_id, which is one fewer than the
 * previous build carried.
 *
 * The wide, rarely-written tables (contacts, overrides, affiliations) can afford
 * more, since the roster sync is now hash-gated and barely writes at all.
 */
const INDEXES = [
  // volunteer_slots — hot write path, keep tight.
  `CREATE INDEX IF NOT EXISTS idx_slots_event ON volunteer_slots(event_id)`,
  `CREATE INDEX IF NOT EXISTS idx_slots_email_lower ON volunteer_slots(LOWER(volunteer_email))`,
  `CREATE INDEX IF NOT EXISTS idx_slots_status_epoch ON volunteer_slots(status,start_epoch)`,

  `CREATE INDEX IF NOT EXISTS idx_contact_program ON contact_mappings(program)`,
  `CREATE INDEX IF NOT EXISTS idx_contact_email_lower ON contact_mappings(LOWER(email))`,
  `CREATE INDEX IF NOT EXISTS idx_contact_source_type ON contact_mappings(source_type)`,
  `CREATE INDEX IF NOT EXISTS idx_override_email_lower ON volunteer_program_overrides(LOWER(email))`,
  `CREATE INDEX IF NOT EXISTS idx_override_program ON volunteer_program_overrides(program)`,
  `CREATE INDEX IF NOT EXISTS idx_affiliation_history_email_lower ON volunteer_affiliation_history(LOWER(email))`,
  `CREATE INDEX IF NOT EXISTS idx_affiliation_history_dates ON volunteer_affiliation_history(email,effective_from,effective_to)`,
  `CREATE INDEX IF NOT EXISTS idx_affiliation_history_program ON volunteer_affiliation_history(program)`
];

/**
 * Indexes carried by earlier versions that nothing queries any more. Each one was
 * adding a write to every slot insert and update for no read benefit:
 *  - idx_slots_email          superseded by the LOWER(email) index; every query lowercases.
 *  - idx_slots_signupgenius_slot_id  fully redundant with the UNIQUE constraint's own index.
 *  - idx_contact_email        superseded by idx_contact_email_lower.
 *  - idx_override_email       superseded by idx_override_email_lower.
 *  - idx_affiliation_history_email   superseded by idx_affiliation_history_email_lower.
 */
const DROP_INDEXES = [
  `DROP INDEX IF EXISTS idx_slots_email`,
  `DROP INDEX IF EXISTS idx_slots_signupgenius_slot_id`,
  `DROP INDEX IF EXISTS idx_contact_email`,
  `DROP INDEX IF EXISTS idx_override_email`,
  `DROP INDEX IF EXISTS idx_affiliation_history_email`
];

const SEEDS = [
  `INSERT OR IGNORE INTO programs(name,required_hours) VALUES('Guard',0),('Percussion',0),('Winds',0),('Band Boosters',0)`,
  `INSERT OR IGNORE INTO settings(key,value) VALUES('estimate_untimed_enabled','0'),('estimate_untimed_hours','6')`
];

// One-time backfill of the v0.6.0 columns from the legacy raw_json payload.
const BACKFILL = [
  `UPDATE volunteer_slots
     SET start_epoch = COALESCE(
           CAST(json_extract(raw_json,'$.startdate') AS INTEGER),
           CASE WHEN slot_date GLOB '[0-9][0-9][0-9][0-9]-*' THEN CAST(strftime('%s',slot_date) AS INTEGER)
                WHEN slot_date GLOB '[0-9]*' THEN CAST(slot_date AS INTEGER) END,
           0)
   WHERE start_epoch IS NULL`,
  `UPDATE volunteer_slots
     SET slot_day = COALESCE(
           CASE WHEN start_epoch > 0 THEN date(start_epoch,'unixepoch') END,
           date(slot_date))
   WHERE slot_day IS NULL`,
  `UPDATE volunteer_slots
     SET source = 'manual'
   WHERE source <> 'manual'
     AND (signupgenius_slot_id LIKE 'manual:%' OR COALESCE(json_extract(raw_json,'$.source'),'') = 'manual')`
];

let ready: Promise<void> | null = null;

async function bootstrap(env: Env) {
  await env.DB.batch(TABLES.map(sql => env.DB.prepare(sql)));

  for (const [, sql] of COLUMNS) {
    try {
      await env.DB.prepare(sql).run();
    } catch (e) {
      const m = e instanceof Error ? e.message : String(e);
      if (!/duplicate column name/i.test(m)) throw e;
    }
  }

  await env.DB.batch(DROP_INDEXES.map(sql => env.DB.prepare(sql)));
  await env.DB.batch(INDEXES.map(sql => env.DB.prepare(sql)));
  await env.DB.batch(SEEDS.map(sql => env.DB.prepare(sql)));
  for (const sql of BACKFILL) await env.DB.prepare(sql).run();
}

async function check(env: Env) {
  let current: string | null = null;
  try {
    const row = await env.DB.prepare("SELECT value FROM settings WHERE key='schema_version'").first<any>();
    current = row?.value ?? null;
  } catch {
    current = null; // settings table does not exist yet
  }
  if (current === SCHEMA_VERSION) return;

  await bootstrap(env);
  await env.DB.prepare(
    "INSERT INTO settings(key,value,updated_at) VALUES('schema_version',?,datetime('now')) " +
    "ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=datetime('now')"
  ).bind(SCHEMA_VERSION).run();
}

/** Costs one indexed single-row read per isolate once the schema is current. */
export function ensureSchema(env: Env): Promise<void> {
  if (!ready) {
    ready = check(env).catch(err => {
      ready = null; // never cache a failure for the life of the isolate
      throw err;
    });
  }
  return ready;
}

export async function forceSchema(env: Env) {
  ready = null;
  await bootstrap(env);
  await env.DB.prepare(
    "INSERT INTO settings(key,value,updated_at) VALUES('schema_version',?,datetime('now')) " +
    "ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=datetime('now')"
  ).bind(SCHEMA_VERSION).run();
  ready = Promise.resolve();
}
