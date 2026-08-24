import type { Env } from "./types";

const rec = (x: unknown): Record<string, any> => x && typeof x === "object" && !Array.isArray(x) ? x as Record<string, any> : {};
const str = (o: Record<string, any>, keys: string[]) => {
  for (const k of keys) {
    if (typeof o[k] === "string" && o[k].trim()) return o[k].trim();
    if (typeof o[k] === "number") return String(o[k]);
  }
  return null;
};
export const arr = (x: unknown): unknown[] => {
  if (Array.isArray(x)) return x;
  const o = rec(x);
  for (const k of ["data", "results", "signups", "signup", "items", "slots", "reports", "report", "rows", "records"]) {
    if (Array.isArray(o[k])) return o[k];
    if (o[k] && typeof o[k] === "object") {
      const a = arr(o[k]);
      if (a.length) return a;
    }
  }
  return [];
};

export async function apiGet(env: Env, path: string) {
  const u = new URL(`${(env.SIGNUPGENIUS_API_BASE || "https://api.signupgenius.com/v2/k/").replace(/\/+$/, "")}/${path.replace(/^\/+/, "")}`);
  u.searchParams.set("user_key", env.SIGNUPGENIUS_API_KEY);
  const r = await fetch(u, { headers: { Accept: "application/json" } });
  const t = await r.text();
  if (!r.ok) throw Error(`SignUpGenius API ${r.status}: ${t.slice(0, 400)}`);
  return JSON.parse(t);
}

function txt(o: Record<string, any>, k: string) { const v = o[k]; return v === null || v === undefined ? "" : String(v).trim(); }
function volunteer(o: Record<string, any>) {
  const first = txt(o, "firstname"), last = txt(o, "lastname");
  const name = [first, last].filter(Boolean).join(" ") || txt(o, "name");
  return { name, email: txt(o, "email") };
}
function quantity(o: Record<string, any>) { const n = Number(o.myqty ?? o.quantity ?? 1); return Number.isFinite(n) && n > 0 ? Math.round(n) : 1; }
function duration(o: Record<string, any>) { const start = Number(o.startdate || 0), end = Number(o.enddate || 0); if (start > 0 && end > start) return { hours: (end - start) / 3600, known: true }; return { hours: 0, known: false }; }
function rowId(eid: string, o: Record<string, any>, i: number) { const member = txt(o, "itemmemberid"); if (member) return `${eid}:member:${member}`; const slot = txt(o, "slotitemid"); if (slot) return `${eid}:open:${slot}`; return `${eid}:row:${i}`; }
function slotDate(o: Record<string, any>) { return txt(o, "startdatestring") || txt(o, "startdate"); }
function slotStart(o: Record<string, any>) { return txt(o, "startdatestring") || txt(o, "starttime"); }
function slotEnd(o: Record<string, any>) { return txt(o, "enddatestring") || txt(o, "endtime"); }

function same(a: unknown, b: unknown) {
  if (a === null || a === undefined) a = "";
  if (b === null || b === undefined) b = "";
  return String(a) === String(b);
}

async function runBatches(env: Env, statements: any[], batchSize = 75) {
  for (let i = 0; i < statements.length; i += batchSize) {
    await env.DB.batch(statements.slice(i, i + batchSize));
  }
}

/**
 * Incremental SignUpGenius synchronization.
 *
 * The old implementation deleted every slot for every event and reinserted the
 * complete report every 15 minutes. D1 counts each deleted/inserted row as a
 * write, which caused the free-tier write limit to be exceeded even when the
 * source data had not changed.
 *
 * This implementation only inserts new slots, updates changed slots, and
 * deletes slots that disappeared from the latest report.
 */
export async function sync(env: Env) {
  const events = arr(await apiGet(env, "/signups/created/active/"));
  let rows = 0, filledQty = 0, openQty = 0, tbdQty = 0;
  let inserted = 0, updated = 0, deleted = 0, unchanged = 0, eventsChanged = 0;

  for (let i = 0; i < events.length; i++) {
    const e = rec(events[i]);
    const eid = str(e, ["signupid", "signupId", "id", "signup_id"]) || `unknown-${i}`;
    const title = str(e, ["title", "name", "signup_title", "signupTitle"]) || `SignUpGenius ${eid}`;
    const eventDate = str(e, ["date", "event_date", "eventDate", "start_date", "startDate"]);
    const location = str(e, ["location", "event_location", "eventLocation"]);
    const rawEvent = JSON.stringify(events[i]);

    const eventWrite = await env.DB.prepare(`
      INSERT INTO events(signupgenius_id,title,event_date,location,raw_json,updated_at)
      VALUES(?,?,?,?,?,datetime('now'))
      ON CONFLICT(signupgenius_id) DO UPDATE SET
        title=excluded.title,
        event_date=excluded.event_date,
        location=excluded.location,
        raw_json=excluded.raw_json,
        updated_at=datetime('now')
      WHERE title IS NOT excluded.title
         OR event_date IS NOT excluded.event_date
         OR location IS NOT excluded.location
         OR raw_json IS NOT excluded.raw_json
    `).bind(eid, title, eventDate, location, rawEvent).run();
    eventsChanged += Number(eventWrite.meta?.changes || 0);

    const db = await env.DB.prepare("SELECT id FROM events WHERE signupgenius_id=?").bind(eid).first<{ id: number }>();
    if (!db) continue;

    const report = arr(await apiGet(env, `/signups/report/all/${encodeURIComponent(eid)}/`));
    const existingRows = await env.DB.prepare(`
      SELECT id,event_id,signupgenius_slot_id,title,slot_date,start_time,end_time,hours,status,
             volunteer_name,volunteer_email,raw_json,quantity,hours_known
      FROM volunteer_slots
      WHERE event_id=?
    `).bind(db.id).all<any>();
    const existing = new Map<string, any>();
    for (const row of existingRows.results || []) existing.set(String(row.signupgenius_slot_id), row);

    const seen = new Set<string>();
    const statements: any[] = [];

    for (let j = 0; j < report.length; j++) {
      const s = rec(report[j]);
      const v = volunteer(s);
      const status = v.name || v.email || txt(s, "itemmemberid") ? "filled" : "open";
      const q = quantity(s);
      const d = duration(s);
      const sid = rowId(eid, s, j);
      const next = {
        event_id: db.id,
        signupgenius_slot_id: sid,
        title: txt(s, "item") || "Volunteer Slot",
        slot_date: slotDate(s),
        start_time: slotStart(s),
        end_time: slotEnd(s),
        hours: d.hours,
        status,
        volunteer_name: v.name || null,
        volunteer_email: v.email || null,
        raw_json: JSON.stringify(s),
        quantity: q,
        hours_known: d.known ? 1 : 0
      };

      seen.add(sid);
      rows++;
      if (status === "filled") filledQty += q; else openQty += q;
      if (!d.known) tbdQty += q;

      const old = existing.get(sid);
      if (!old) {
        statements.push(env.DB.prepare(`
          INSERT INTO volunteer_slots(
            event_id,signupgenius_slot_id,title,slot_date,start_time,end_time,hours,status,
            volunteer_name,volunteer_email,raw_json,quantity,hours_known
          ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)
        `).bind(
          next.event_id, next.signupgenius_slot_id, next.title, next.slot_date, next.start_time,
          next.end_time, next.hours, next.status, next.volunteer_name, next.volunteer_email,
          next.raw_json, next.quantity, next.hours_known
        ));
        inserted++;
        continue;
      }

      const changed =
        !same(old.event_id, next.event_id) ||
        !same(old.title, next.title) ||
        !same(old.slot_date, next.slot_date) ||
        !same(old.start_time, next.start_time) ||
        !same(old.end_time, next.end_time) ||
        Number(old.hours || 0) !== Number(next.hours || 0) ||
        !same(old.status, next.status) ||
        !same(old.volunteer_name, next.volunteer_name) ||
        !same(old.volunteer_email, next.volunteer_email) ||
        !same(old.raw_json, next.raw_json) ||
        Number(old.quantity || 1) !== Number(next.quantity || 1) ||
        Number(old.hours_known || 0) !== Number(next.hours_known || 0);

      if (changed) {
        statements.push(env.DB.prepare(`
          UPDATE volunteer_slots SET
            event_id=?,title=?,slot_date=?,start_time=?,end_time=?,hours=?,status=?,
            volunteer_name=?,volunteer_email=?,raw_json=?,quantity=?,hours_known=?,updated_at=datetime('now')
          WHERE signupgenius_slot_id=?
        `).bind(
          next.event_id, next.title, next.slot_date, next.start_time, next.end_time, next.hours,
          next.status, next.volunteer_name, next.volunteer_email, next.raw_json, next.quantity,
          next.hours_known, sid
        ));
        updated++;
      } else {
        unchanged++;
      }
    }

    for (const [sid] of existing) {
      if (!seen.has(sid)) {
        statements.push(env.DB.prepare("DELETE FROM volunteer_slots WHERE event_id=? AND signupgenius_slot_id=?").bind(db.id, sid));
        deleted++;
      }
    }

    await runBatches(env, statements);
  }

  return { events: events.length, rows, filledQty, openQty, tbdQty, inserted, updated, deleted, unchanged, eventsChanged };
}
