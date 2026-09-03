import type { Env } from "./types";
import { NORMALIZED_ROSTER } from "./normalizedRoster";
import { contentHash } from "./signupgenius";

function clean(v: unknown) { return String(v ?? "").trim(); }
function norm(v: unknown) { return clean(v).toLowerCase(); }
function same(a: unknown, b: unknown) { return clean(a) === clean(b); }

async function runBatches(env: Env, statements: any[], batchSize = 75) {
  for (let i = 0; i < statements.length; i += batchSize) {
    await env.DB.batch(statements.slice(i, i + batchSize));
  }
}

/** Hash of the compiled-in roster. Changes only when the Worker is redeployed. */
let rosterHash: string | null = null;
function hashRoster() {
  if (rosterHash) return rosterHash;
  const parts: string[] = [];
  for (const r of NORMALIZED_ROSTER) parts.push(`${norm(r.email)}|${norm(r.studentName)}|${norm(r.program)}|${clean(r.parentName)}`);
  parts.sort();
  rosterHash = contentHash([NORMALIZED_ROSTER.length, parts.join("\n")]);
  return rosterHash;
}

/**
 * Synchronize D1 mappings from the embedded normalized roster.
 *
 * The roster is compiled into the Worker bundle, so it cannot change without a
 * deploy — yet this ran in full on every 15-minute cron, reading the roster table
 * plus two whole-table aggregates and writing a log row each time. It now compares
 * a hash of the compiled roster against settings.roster_hash and returns after a
 * single indexed one-row read when nothing has changed.
 */
export async function syncContacts(env: Env, force = false) {
  const hash = hashRoster();

  if (!force) {
    const stored = await env.DB.prepare("SELECT value FROM settings WHERE key='roster_hash'").first<any>();
    if (stored?.value === hash) {
      return {
        skipped: true, reason: "roster unchanged since last sync",
        rows: 0, rosterRows: NORMALIZED_ROSTER.length, uniqueEmails: 0, multiProgramEmails: 0,
        sourceCounts: {} as Record<string, number>,
        inserted: 0, updated: 0, deleted: 0, unchanged: 0, writes: 0, errors: [] as string[]
      };
    }
  }

  const seenSource = new Set<string>();
  const desired = new Map<string, { email: string; parentName: string | null; studentName: string | null; program: string; sourceTab: string; sourceType: string }>();
  const sourceCounts: Record<string, number> = {};

  for (const row of NORMALIZED_ROSTER) {
    const email = norm(row.email);
    const program = clean(row.program);
    if (!email || !program) continue;
    const studentName = clean(row.studentName);
    const key = [email, studentName.toLowerCase(), program.toLowerCase()].join("|");
    if (seenSource.has(key)) continue;
    seenSource.add(key);
    desired.set(key, {
      email,
      parentName: clean(row.parentName) || null,
      studentName: studentName || null,
      program,
      sourceTab: "2026-2027 Parent Contacts",
      sourceType: "normalized_roster"
    });
    sourceCounts[program] = (sourceCounts[program] || 0) + 1;
  }

  const currentRows = await env.DB.prepare(`
    SELECT id,email,parent_name,student_name,program,source_tab,source_type
    FROM contact_mappings
    WHERE source_type='normalized_roster'
  `).all<any>();

  const currentByKey = new Map<string, any[]>();
  for (const row of currentRows.results || []) {
    const key = [norm(row.email), norm(row.student_name), norm(row.program)].join("|");
    const list = currentByKey.get(key) || [];
    list.push(row);
    currentByKey.set(key, list);
  }

  const statements: any[] = [];
  let inserted = 0, updated = 0, deleted = 0, unchanged = 0;

  for (const [key, next] of desired) {
    const matches = currentByKey.get(key) || [];
    const old = matches.shift();
    if (!old) {
      statements.push(env.DB.prepare(`
        INSERT INTO contact_mappings(email,parent_name,student_name,program,source_tab,source_type,updated_at)
        VALUES(?,?,?,?,?,'normalized_roster',datetime('now'))
      `).bind(next.email, next.parentName, next.studentName, next.program, next.sourceTab));
      inserted++;
    } else {
      const changed =
        !same(old.email, next.email) ||
        !same(old.parent_name, next.parentName) ||
        !same(old.student_name, next.studentName) ||
        !same(old.program, next.program) ||
        !same(old.source_tab, next.sourceTab) ||
        !same(old.source_type, next.sourceType);
      if (changed) {
        statements.push(env.DB.prepare(`
          UPDATE contact_mappings
          SET email=?,parent_name=?,student_name=?,program=?,source_tab=?,source_type='normalized_roster',updated_at=datetime('now')
          WHERE id=?
        `).bind(next.email, next.parentName, next.studentName, next.program, next.sourceTab, old.id));
        updated++;
      } else {
        unchanged++;
      }
    }
    currentByKey.set(key, matches);
  }

  // Remove stale rows and any duplicate normalized-roster mappings left by an older build.
  for (const leftovers of currentByKey.values()) {
    for (const row of leftovers) {
      statements.push(env.DB.prepare("DELETE FROM contact_mappings WHERE id=?").bind(row.id));
      deleted++;
    }
  }

  await runBatches(env, statements);

  // Two whole-table aggregates folded into one round trip.
  const totals = await env.DB.prepare(`SELECT
    (SELECT COUNT(DISTINCT LOWER(email)) FROM contact_mappings) uniqueEmails,
    (SELECT COUNT(*) FROM (SELECT LOWER(email) e FROM contact_mappings GROUP BY LOWER(email) HAVING COUNT(DISTINCT program)>1)) multi`).first<any>();

  const changed = inserted + updated + deleted;
  await env.DB.batch([
    env.DB.prepare("INSERT INTO contact_sync_log(sync_time,records,status,message) VALUES(datetime('now'),?,'success',?)")
      .bind(desired.size, changed
        ? `Roster sync: ${inserted} inserted, ${updated} updated, ${deleted} deleted, ${unchanged} unchanged.`
        : `Roster sync: no mapping changes; ${unchanged} rows unchanged.`),
    env.DB.prepare("INSERT INTO settings(key,value,updated_at) VALUES('roster_hash',?,datetime('now')) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=datetime('now')")
      .bind(hash)
  ]);

  return {
    skipped: false,
    reason: force ? "forced" : "roster changed",
    rows: desired.size,
    rosterRows: NORMALIZED_ROSTER.length,
    uniqueEmails: Number(totals?.uniqueEmails || 0),
    multiProgramEmails: Number(totals?.multi || 0),
    sourceCounts,
    inserted,
    updated,
    deleted,
    unchanged,
    writes: changed,
    errors: [] as string[]
  };
}
