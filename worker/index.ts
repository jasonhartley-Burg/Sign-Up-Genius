import type { Env } from "./types";
import { dashboard, getSettings } from "./db";
import { sync, dayFromEpoch } from "./signupgenius";
import { syncContacts } from "./contacts";
import { ensureSchema, forceSchema, SCHEMA_VERSION } from "./schema";

const VERSION = "0.6.0";

const json = (x: unknown, s = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(x), { status: s, headers: { "content-type": "application/json", "cache-control": "no-store", ...headers } });

const adminSecret = (env: Env) => env.ADMIN_TOKEN || env.SYNC_ADMIN_TOKEN || "";
const adminOK = (req: Request, env: Env) => {
  const secret = adminSecret(env); if (!secret) return false;
  const h = req.headers.get("authorization") || "";
  return h === `Bearer ${secret}`;
};
const adminRequired = (req: Request, env: Env) => {
  const configured = !!adminSecret(env);
  return adminOK(req, env) ? null : json({ error: configured ? "Administrative authentication required." : "ADMIN_TOKEN is not configured. Add it as a Cloudflare Worker secret before using /admin." }, configured ? 401 : 503);
};

const num = (v: string | undefined, fallback: number) => { const n = Number(v); return Number.isFinite(n) && n >= 0 ? n : fallback; };

/**
 * Public dashboard responses are cached at the edge. Every uncached load runs a
 * dozen aggregate queries over the whole slot table, so an unthrottled dashboard
 * was capable of burning the daily rows-read allowance on its own. Data is at
 * most DASHBOARD_CACHE_SECONDS old, which is well inside the sync cadence.
 */
function cacheKeyFor(u: URL) {
  const start = u.searchParams.get("start") || "";
  const end = u.searchParams.get("end") || "";
  const k = new URL(u.origin + "/__cache/dashboard");
  if (start) k.searchParams.set("start", start);
  if (end) k.searchParams.set("end", end);
  return new Request(k.toString(), { method: "GET" });
}

async function purgeDashboardCache(u: URL) {
  try { await caches.default.delete(cacheKeyFor(new URL(u.origin + "/api/dashboard"))); } catch { /* best effort */ }
}

async function pruneLogs(env: Env, keep = 200) {
  // Cheap, PK-ranged deletes so the log tables do not grow without bound.
  await env.DB.batch([
    env.DB.prepare(`DELETE FROM sync_log WHERE id <= (SELECT MAX(id) FROM sync_log) - ?`).bind(keep),
    env.DB.prepare(`DELETE FROM contact_sync_log WHERE id <= (SELECT MAX(id) FROM contact_sync_log) - ?`).bind(keep)
  ]);
}

async function runSignup(env: Env) {
  const t = new Date().toISOString();
  try {
    const r = await sync(env);
    await env.DB.prepare("INSERT INTO sync_log(sync_time,records,status,message) VALUES(?,?,?,?)")
      .bind(t, r.rows, "success", `Synced ${r.events} events, ${r.rows} report rows, ${r.filledQty} filled assignments, ${r.openQty} open assignments, ${r.tbdQty} time-TBD assignments. D1 changes: ${r.inserted} inserted, ${r.updated} updated, ${r.deleted} deleted, ${r.unchanged} unchanged; ${r.eventsChanged} event rows changed.`).run();
    return r;
  } catch (e) {
    const m = e instanceof Error ? e.message : String(e);
    await env.DB.prepare("INSERT INTO sync_log(sync_time,records,status,message) VALUES(?,?,?,?)").bind(t, 0, "error", m.slice(0, 2000)).run();
    throw e;
  }
}

async function runAll(env: Env, forceContacts = false) {
  const signup = await runSignup(env);
  let contacts: any = null, contactError: string | null = null;
  try { contacts = await syncContacts(env, forceContacts); } catch (e) { contactError = e instanceof Error ? e.message : String(e); }
  if (Math.random() < 0.05) { try { await pruneLogs(env); } catch { /* non-fatal */ } }
  return { signup, contacts, contactError };
}

export default {
  async fetch(req: Request, env: Env, ctx: ExecutionContext) {
    const u = new URL(req.url);
    const ttl = num(env.DASHBOARD_CACHE_SECONDS, 300);

    try {
      // No DB work at all for the health check.
      if (u.pathname === "/api/health") {
        return json({
          ok: true, version: VERSION, schemaVersion: SCHEMA_VERSION,
          dashboardCacheSeconds: ttl,
          contactsSource: "embedded-normalized-roster", contactSyncMode: "hash-gated-incremental-d1",
          dateFiltering: true, manualOverrides: true, effectiveDatedAffiliations: true, visualizations: true,
          scoreboard: true, organizationContribution: true, publicAdminSplit: true, manualHours: true,
          publicEmails: false, adminConfigured: !!adminSecret(env)
        });
      }

      if (!u.pathname.startsWith("/api/")) return env.ASSETS.fetch(req);

      // Public dashboard: try the edge cache before touching D1 at all.
      const isPublicDashboard = u.pathname === "/api/dashboard" && req.method === "GET";
      if (isPublicDashboard && ttl > 0) {
        const hit = await caches.default.match(cacheKeyFor(u));
        if (hit) { const h = new Response(hit.body, hit); h.headers.set("x-cache", "HIT"); return h; }
      }

      await ensureSchema(env);

      if (u.pathname === "/api/dashboard" || u.pathname === "/api/admin/dashboard") {
        const isAdmin = u.pathname === "/api/admin/dashboard";
        if (isAdmin) { const denied = adminRequired(req, env); if (denied) return denied; }
        const startDate = u.searchParams.get("start") || undefined;
        const endDate = u.searchParams.get("end") || undefined;
        const valid = (x: string | undefined) => !x || /^\d{4}-\d{2}-\d{2}$/.test(x);
        if (!valid(startDate) || !valid(endDate)) return json({ error: "Dates must use YYYY-MM-DD format." }, 400);
        if (startDate && endDate && startDate > endDate) return json({ error: "Start date cannot be after end date." }, 400);
        const today = new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
        const resolvedEndDate = endDate || (startDate ? today : undefined);
        const startEpoch = startDate ? Math.floor(Date.parse(startDate + "T00:00:00Z") / 1000) : undefined;
        const endEpochExclusive = resolvedEndDate ? Math.floor(Date.parse(resolvedEndDate + "T00:00:00Z") / 1000) + 86400 : undefined;
        const data = await dashboard(env, { startDate, endDate, startEpoch, endEpochExclusive, asOfDate: resolvedEndDate || today });

        if (isAdmin) return json(data);

        // Public API deliberately omits volunteer names, emails, unmatched records, settings and admin-only identifiers.
        const body = {
          range: data.range, summary: data.summary, programs: data.programs,
          events: data.events.map((e: any) => ({ id: e.id, title: e.title, eventDate: e.eventDate, location: e.location, hoursNeeded: e.hoursNeeded, hoursFilled: e.hoursFilled, openSlots: e.openSlots, assignedSlots: e.assignedSlots }))
        };
        if (ttl <= 0) return json(body);
        const res = json(body, 200, { "cache-control": `public, max-age=60, s-maxage=${ttl}`, "x-cache": "MISS" });
        ctx.waitUntil(caches.default.put(cacheKeyFor(u), res.clone()));
        return res;
      }

      if (adminOK(req, env) && u.pathname === "/api/settings" && req.method === "GET") return json(await getSettings(env));
      if (adminOK(req, env) && u.pathname === "/api/settings" && req.method === "POST") {
        const b: any = await req.json(); const enabled = !!b.estimateUntimedEnabled; const hours = Number(b.estimateUntimedHours);
        if (!Number.isFinite(hours) || hours < 0 || hours > 24) return json({ error: "Estimated untimed hours must be between 0 and 24." }, 400);
        await env.DB.batch([
          env.DB.prepare("INSERT INTO settings(key,value,updated_at) VALUES('estimate_untimed_enabled',?,datetime('now')) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=datetime('now')").bind(enabled ? "1" : "0"),
          env.DB.prepare("INSERT INTO settings(key,value,updated_at) VALUES('estimate_untimed_hours',?,datetime('now')) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=datetime('now')").bind(String(hours))
        ]);
        await purgeDashboardCache(u);
        return json({ ok: true, estimateUntimedEnabled: enabled, estimateUntimedHours: hours });
      }

      if (adminOK(req, env) && u.pathname === "/api/admin/bootstrap" && req.method === "POST") {
        await forceSchema(env);
        return json({ ok: true, schemaVersion: SCHEMA_VERSION, message: "Schema, indexes and backfill re-applied." });
      }

      if (adminOK(req, env) && u.pathname === "/api/sync" && req.method === "POST") {
        if (!env.SIGNUPGENIUS_API_KEY) return json({ error: "SIGNUPGENIUS_API_KEY is not configured." }, 500);
        const r = await runAll(env, u.searchParams.get("contacts") === "force");
        await purgeDashboardCache(u);
        const c = r.contacts
          ? (r.contacts.skipped ? " Contacts unchanged since last deploy; roster sync skipped." : ` Contacts: ${r.contacts.uniqueEmails} unique emails, ${r.contacts.multiProgramEmails} multi-activity.`)
          : ` Contacts not refreshed: ${r.contactError}`;
        return json({ ok: true, message: `Sync complete: ${r.signup.events} events, ${r.signup.filledQty} filled assignments, ${r.signup.openQty} open assignments.${c}` });
      }

      if (adminOK(req, env) && u.pathname === "/api/contacts/sync" && req.method === "POST") {
        // Manual contact syncs always force, so the button behaves as the operator expects.
        const r = await syncContacts(env, true);
        await purgeDashboardCache(u);
        return json({ ok: true, message: `Contact sync complete: ${r.rows} normalized roster mappings across ${Object.keys(r.sourceCounts).length} activities, ${r.uniqueEmails} unique emails, ${r.multiProgramEmails} multi-activity emails.`, ...r });
      }

      if (adminOK(req, env) && u.pathname === "/api/affiliations/history" && req.method === "GET") {
        const email = String(u.searchParams.get("email") || "").trim().toLowerCase();
        if (!email || !email.includes("@")) return json({ error: "A valid volunteer email is required." }, 400);
        const rows = await env.DB.prepare("SELECT program,effective_from effectiveFrom,effective_to effectiveTo,volunteer_name volunteerName FROM volunteer_affiliation_history WHERE LOWER(email)=? ORDER BY effective_from DESC,program").bind(email).all<any>();
        return json({ email, history: rows.results || [] });
      }

      if (adminOK(req, env) && u.pathname === "/api/affiliations/change" && req.method === "POST") {
        const b: any = await req.json();
        const email = String(b.email || "").trim().toLowerCase();
        const name = String(b.name || "").trim();
        const effectiveDate = String(b.effectiveDate || "").trim();
        const programs = Array.from(new Set((Array.isArray(b.programs) ? b.programs : []).map((x: any) => String(x).trim()).filter(Boolean))) as string[];
        if (!email || !email.includes("@")) return json({ error: "A valid volunteer email is required." }, 400);
        if (!/^\d{4}-\d{2}-\d{2}$/.test(effectiveDate)) return json({ error: "Effective date must use YYYY-MM-DD format." }, 400);
        if (programs.length > 10) return json({ error: "Too many activities selected." }, 400);
        const previousDate = new Date(effectiveDate + "T00:00:00Z"); previousDate.setUTCDate(previousDate.getUTCDate() - 1);
        const previous = previousDate.toISOString().slice(0, 10);
        const existing = await env.DB.prepare("SELECT COUNT(*) n FROM volunteer_affiliation_history WHERE LOWER(email)=?").bind(email).first<any>();
        if (!Number(existing?.n || 0)) {
          const overrides = await env.DB.prepare("SELECT program FROM volunteer_program_overrides WHERE LOWER(email)=? ORDER BY program").bind(email).all<any>();
          const roster = overrides.results?.length ? overrides : await env.DB.prepare("SELECT DISTINCT program FROM contact_mappings WHERE LOWER(email)=? ORDER BY program").bind(email).all<any>();
          const oldPrograms = (roster.results || []).map((x: any) => String(x.program || "").trim()).filter(Boolean);
          if (oldPrograms.length) {
            await env.DB.batch(oldPrograms.map((program: string) => env.DB.prepare("INSERT OR IGNORE INTO volunteer_affiliation_history(email,volunteer_name,program,effective_from,effective_to,updated_at) VALUES(?,?,?,'1900-01-01',?,datetime('now'))").bind(email, name || null, program, previous)));
          }
        }
        await env.DB.batch([
          env.DB.prepare("UPDATE volunteer_affiliation_history SET effective_to=?,updated_at=datetime('now') WHERE LOWER(email)=? AND effective_from<? AND (effective_to IS NULL OR effective_to>=?)").bind(previous, email, effectiveDate, effectiveDate),
          env.DB.prepare("DELETE FROM volunteer_affiliation_history WHERE LOWER(email)=? AND effective_from>=?").bind(email, effectiveDate)
        ]);
        if (programs.length) {
          await env.DB.batch(programs.map(program => env.DB.prepare("INSERT INTO volunteer_affiliation_history(email,volunteer_name,program,effective_from,effective_to,updated_at) VALUES(?,?,?,?,NULL,datetime('now'))").bind(email, name || null, program, effectiveDate)));
        }
        await purgeDashboardCache(u);
        return json({ ok: true, email, effectiveDate, programs, message: `Affiliation change saved for ${email} effective ${effectiveDate}: ${programs.length ? programs.join(", ") : "no active activities"}. Historical assignments before that date are unchanged.` });
      }

      if (adminOK(req, env) && u.pathname === "/api/attribution/override" && req.method === "POST") {
        const b: any = await req.json();
        const email = String(b.email || "").trim().toLowerCase();
        const name = String(b.name || "").trim();
        const programs = Array.from(new Set((Array.isArray(b.programs) ? b.programs : []).map((x: any) => String(x).trim()).filter(Boolean))) as string[];
        if (!email || !email.includes("@")) return json({ error: "A valid volunteer email is required." }, 400);
        if (programs.length > 10) return json({ error: "Too many activities selected." }, 400);
        const deletes = env.DB.prepare("DELETE FROM volunteer_program_overrides WHERE LOWER(email)=?").bind(email);
        const writes = programs.map(program => env.DB.prepare("INSERT INTO volunteer_program_overrides(email,volunteer_name,program,updated_at) VALUES(?,?,?,datetime('now'))").bind(email, name || null, program));
        await env.DB.batch([deletes, ...writes]);
        await purgeDashboardCache(u);
        return json({ ok: true, email, programs, message: programs.length ? `Saved manual attribution for ${email}: ${programs.join(", ")}.` : `Removed manual attribution for ${email}; roster matching will be used again.` });
      }

      if (u.pathname === "/api/admin/manual-hours" && req.method === "GET") {
        const denied = adminRequired(req, env); if (denied) return denied;
        // Indexed source lookup rather than a LIKE 'manual:%' scan of the whole table.
        const rows = await env.DB.prepare(`SELECT v.id, v.volunteer_name name, v.volunteer_email email, v.slot_date workDate, v.hours, e.title description, e.location, v.created_at createdAt FROM volunteer_slots v JOIN events e ON e.id=v.event_id WHERE v.source='manual' ORDER BY v.slot_date DESC,v.id DESC LIMIT 250`).all<any>();
        return json({ rows: rows.results || [] });
      }

      if (u.pathname === "/api/admin/manual-hours" && req.method === "POST") {
        const denied = adminRequired(req, env); if (denied) return denied;
        const b: any = await req.json();
        const name = String(b.name || "").trim(), email = String(b.email || "").trim().toLowerCase(), workDate = String(b.workDate || "").trim(), description = String(b.description || "Manual volunteer service").trim(), location = String(b.location || "").trim();
        const hours = Number(b.hours);
        if (!name) return json({ error: "Volunteer name is required." }, 400);
        if (!email || !email.includes("@")) return json({ error: "A valid volunteer email is required so the hours can be attributed to the correct activity." }, 400);
        if (!/^\d{4}-\d{2}-\d{2}$/.test(workDate)) return json({ error: "Work date must use YYYY-MM-DD format." }, 400);
        if (!Number.isFinite(hours) || hours <= 0 || hours > 24) return json({ error: "Hours must be greater than 0 and no more than 24." }, 400);
        const id = crypto.randomUUID();
        const eventKey = `manual:${workDate}:${id}`;
        const epoch = Math.floor(Date.parse(workDate + "T00:00:00Z") / 1000);
        await env.DB.prepare("INSERT INTO events(signupgenius_id,title,event_date,location,raw_json,updated_at) VALUES(?,?,?,?,?,datetime('now'))").bind(eventKey, description, workDate, location || null, JSON.stringify({ source: "manual" })).run();
        const er = await env.DB.prepare("SELECT id FROM events WHERE signupgenius_id=?").bind(eventKey).first<any>();
        if (!er?.id) return json({ error: "Unable to create manual volunteer event record." }, 500);
        await env.DB.prepare("INSERT INTO volunteer_slots(event_id,signupgenius_slot_id,title,slot_date,hours,status,volunteer_name,volunteer_email,raw_json,quantity,hours_known,start_epoch,slot_day,source,updated_at) VALUES(?,?,?,?,?,'filled',?,?,?,1,1,?,?,'manual',datetime('now'))")
          .bind(er.id, `manual:${id}`, description, workDate, hours, name, email, JSON.stringify({ source: "manual", startdate: epoch, enteredAt: new Date().toISOString() }), epoch, dayFromEpoch(epoch, workDate)).run();
        await purgeDashboardCache(u);
        return json({ ok: true, message: `Added ${hours} manual volunteer hours for ${name} on ${workDate}.` });
      }

      if (u.pathname.startsWith("/api/admin/manual-hours/") && req.method === "DELETE") {
        const denied = adminRequired(req, env); if (denied) return denied;
        const id = Number(u.pathname.split("/").pop());
        if (!Number.isInteger(id) || id <= 0) return json({ error: "Invalid manual-hours record." }, 400);
        const row = await env.DB.prepare("SELECT event_id FROM volunteer_slots WHERE id=? AND source='manual'").bind(id).first<any>();
        if (!row) return json({ error: "Manual-hours record not found." }, 404);
        await env.DB.batch([
          env.DB.prepare("DELETE FROM volunteer_slots WHERE id=?").bind(id),
          env.DB.prepare("DELETE FROM events WHERE id=? AND signupgenius_id LIKE 'manual:%'").bind(row.event_id)
        ]);
        await purgeDashboardCache(u);
        return json({ ok: true, message: "Manual volunteer-hours record deleted." });
      }

      if (["/api/settings", "/api/sync", "/api/contacts/sync", "/api/affiliations/history", "/api/affiliations/change", "/api/attribution/override", "/api/admin/bootstrap"].includes(u.pathname) && !adminOK(req, env)) {
        const denied = adminRequired(req, env); if (denied) return denied;
      }

      return json({ error: "Not found" }, 404);
    } catch (e) {
      return json({ error: e instanceof Error ? e.message : "Unexpected server error" }, 500);
    }
  },

  async scheduled(_c: ScheduledController, env: Env, ctx: ExecutionContext) {
    if (!env.SIGNUPGENIUS_API_KEY) return;
    await ensureSchema(env);
    await runAll(env);
    // The cron has fresh data, so drop the stale public copy.
    if (env.PUBLIC_ORIGIN) ctx.waitUntil(purgeDashboardCache(new URL(env.PUBLIC_ORIGIN)));
  }
};
