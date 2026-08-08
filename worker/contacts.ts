import type { Env } from "./types";
import { NORMALIZED_ROSTER } from "./normalizedRoster";

function clean(v: unknown) { return String(v ?? "").trim(); }

/**
 * Rebuild the D1 contact mapping table from the normalized 2026-2027 parent roster.
 * This roster is authoritative for program attribution. Each email may legitimately
 * appear in more than one program; downstream reporting splits volunteer credit
 * evenly across those distinct programs.
 */
export async function syncContacts(env: Env) {
  await env.DB.prepare("DELETE FROM contact_mappings").run();

  const seen = new Set<string>();
  let inserted = 0;
  const sourceCounts: Record<string, number> = {};

  for (const row of NORMALIZED_ROSTER) {
    const email = clean(row.email).toLowerCase();
    const program = clean(row.program);
    if (!email || !program) continue;

    const key = [email, clean(row.studentName).toLowerCase(), program.toLowerCase()].join("|");
    if (seen.has(key)) continue;
    seen.add(key);

    await env.DB.prepare(`
      INSERT INTO contact_mappings(email,parent_name,student_name,program,source_tab,source_type,updated_at)
      VALUES(?,?,?,?,?,'normalized_roster',datetime('now'))
    `).bind(email, clean(row.parentName) || null, clean(row.studentName) || null, program, "2026-2027 Parent Contacts").run();

    inserted++;
    sourceCounts[program] = (sourceCounts[program] || 0) + 1;
  }

  const uniqueEmails = await env.DB.prepare("SELECT COUNT(DISTINCT LOWER(email)) n FROM contact_mappings").first<any>();
  const multi = await env.DB.prepare("SELECT COUNT(*) n FROM (SELECT LOWER(email) e FROM contact_mappings GROUP BY LOWER(email) HAVING COUNT(DISTINCT program)>1)").first<any>();

  await env.DB.prepare("INSERT INTO contact_sync_log(sync_time,records,status,message) VALUES(datetime('now'),?,'success',?)")
    .bind(inserted, "2026-2027 normalized roster loaded as authoritative attribution source").run();

  return {
    rows: inserted,
    uniqueEmails: Number(uniqueEmails?.n || 0),
    multiProgramEmails: Number(multi?.n || 0),
    sourceCounts,
    errors: [] as string[]
  };
}
