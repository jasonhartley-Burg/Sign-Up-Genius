import type { Env } from "./types";
import { NORMALIZED_ROSTER } from "./normalizedRoster";

function clean(v: unknown) { return String(v ?? "").trim(); }

/**
 * Rebuild D1 mappings from the embedded normalized roster. D1 batch() keeps this
 * operation to a small number of Worker subrequests instead of one request per row.
 */
export async function syncContacts(env: Env) {
  await env.DB.prepare("DELETE FROM contact_mappings").run();

  const seen = new Set<string>();
  const statements: any[] = [];
  const sourceCounts: Record<string, number> = {};

  for (const row of NORMALIZED_ROSTER) {
    const email = clean(row.email).toLowerCase();
    const program = clean(row.program);
    if (!email || !program) continue;
    const key = [email, clean(row.studentName).toLowerCase(), program.toLowerCase()].join("|");
    if (seen.has(key)) continue;
    seen.add(key);
    statements.push(env.DB.prepare(`
      INSERT INTO contact_mappings(email,parent_name,student_name,program,source_tab,source_type,updated_at)
      VALUES(?,?,?,?,?,'normalized_roster',datetime('now'))
    `).bind(email, clean(row.parentName) || null, clean(row.studentName) || null, program, "2026-2027 Parent Contacts"));
    sourceCounts[program] = (sourceCounts[program] || 0) + 1;
  }

  // Keep batches comfortably small for D1 while avoiding hundreds of Worker subrequests.
  const batchSize = 75;
  for (let i = 0; i < statements.length; i += batchSize) {
    await env.DB.batch(statements.slice(i, i + batchSize));
  }

  const uniqueEmails = await env.DB.prepare("SELECT COUNT(DISTINCT LOWER(email)) n FROM contact_mappings").first<any>();
  const multi = await env.DB.prepare("SELECT COUNT(*) n FROM (SELECT LOWER(email) e FROM contact_mappings GROUP BY LOWER(email) HAVING COUNT(DISTINCT program)>1)").first<any>();
  await env.DB.prepare("INSERT INTO contact_sync_log(sync_time,records,status,message) VALUES(datetime('now'),?,'success',?)")
    .bind(statements.length, "Embedded normalized roster loaded with batched D1 writes").run();

  return {
    rows: statements.length,
    rosterRows: NORMALIZED_ROSTER.length,
    uniqueEmails: Number(uniqueEmails?.n || 0),
    multiProgramEmails: Number(multi?.n || 0),
    sourceCounts,
    errors: [] as string[]
  };
}
