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

function startEpoch(o: Record<string, any>, fallbackDate: string) {
  const n = Number(o.startdate || 0);
  if (Number.isFinite(n) && n > 0) return Math.floor(n);
  const d = String(fallbackDate || "").trim();
  if (/^\d{4}-\d{2}-\d{2}/.test(d)) { const t = Date.parse(`${d.slice(0, 10)}T00:00:00Z`); if (Number.isFinite(t)) return Math.floor(t / 1000); }
  if (/^\d+$/.test(d)) return Number(d);
  return 0;
}
export function dayFromEpoch(epoch: number, fallbackDate: string) {
  if (epoch > 0) return new Date(epoch * 1000).toISOString().slice(0, 10);
  const d = String(fallbackDate || "").trim();
  return /^\d{4}-\d{2}-\d{2}/.test(d) ? d.slice(0, 10) : null;
}

/** FNV-1a over the fields we actually persist. Cheap, synchronous, plenty for change detection. */
export function contentHash(parts: Array<string | number | null | undefined>) {
  const s = parts.map(p => p === null || p === undefined ? "" : String(p)).join("\u0001");
  let h1 = 0x811c9dc5, h2 = 0x01000193;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 16777619) >>> 0;
    h2 = Math.imul(h2 ^ (c + i), 2246822519) >>> 0;
  }
  return h1.toString(36) + "-" + h2.toString(36);
}

async function runBatches(env: Env, statements: any[], batchSize = 75) {
  for (let i = 0; i < statements.length; i += batchSize) {
    await env.DB.batch(statements.slice(i, i + batchSize));
  }
}

/**
 * Incremental SignUpGenius synchronization.
 *
 * v0.5.x already avoided the delete-and-reinsert pattern, but it compared the
 * full raw_json payload. SignUpGenius returns volatile fields (counters, server
 * timestamps, ordering keys) inside that payload, so almost every row looked
 * "changed" on almost every run and the whole table was rewritten every cycle.
 * That is what exhausted the D1 daily write allowance.
 *
 * v0.6.0 changes two things:
 *   1. Change detection uses a hash of only the fields we actually store.
 *   2. raw_json is reduced to the two keys anything downstream reads, so a row
 *      is small and stable.
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
    // Only the durable descriptive fields are persisted. Storing the whole event
    // payload made every volatile counter look like a real change.
    const rawEvent = JSON.stringify({ signupid: eid, source: "signupgenius" });

    const eventWrite = await env.DB.prepare(`
      INSERT INTO events(signupgenius_id,title,event_date,location,raw_json,updated_at)
      VALUES(?,?,?,?,?,datetime('now'))
      ON CONFLICT(signupgenius_id) DO UPDATE SET
        title=excluded.title,
        event_date=excluded.event_date,
        location=excluded.location,
        raw_json=excluded.raw_json,
        updated_at=datetime('now')
      WHERE events.title IS NOT excluded.title
         OR events.event_date IS NOT excluded.event_date
         OR events.location IS NOT excluded.location
         OR events.raw_json IS NOT excluded.raw_json
    `).bind(eid, title, eventDate, location, rawEvent).run();
    eventsChanged += Number(eventWrite.meta?.changes || 0);

    const db = await env.DB.prepare("SELECT id FROM events WHERE signupgenius_id=?").bind(eid).first<{ id: number }>();
    if (!db) continue;

    const report = arr(await apiGet(env, `/signups/report/all/${encodeURIComponent(eid)}/`));

    // Only the key and the hash are needed to decide what changed, so the compare
    // pass no longer drags every raw_json blob back across the wire.
    const existingRows = await env.DB.prepare(
      "SELECT signupgenius_slot_id sid, content_hash FROM volunteer_slots WHERE event_id=?"
    ).bind(db.id).all<any>();
    const existing = new Map<string, string | null>();
    for (const row of existingRows.results || []) existing.set(String(row.sid), row.content_hash ?? null);

    const seen = new Set<string>();
    const statements: any[] = [];

    for (let j = 0; j < report.length; j++) {
      const s = rec(report[j]);
      const v = volunteer(s);
      const status = v.name || v.email || txt(s, "itemmemberid") ? "filled" : "open";
      const q = quantity(s);
      const d = duration(s);
      const sid = rowId(eid, s, j);
      const sDate = slotDate(s);
      const epoch = startEpoch(s, sDate);
      const day = dayFromEpoch(epoch, sDate);
      const next = {
        title: txt(s, "item") || "Volunteer Slot",
        slot_date: sDate,
        start_time: slotStart(s),
        end_time: slotEnd(s),
        hours: d.hours,
        status,
        volunteer_name: v.name || null,
        volunteer_email: v.email || null,
        raw_json: JSON.stringify({ startdate: epoch, source: "signupgenius" }),
        quantity: q,
        hours_known: d.known ? 1 : 0,
        start_epoch: epoch,
        slot_day: day
      };
      const hash = contentHash([
        db.id, next.title, next.slot_date, next.start_time, next.end_time, next.hours, next.status,
        next.volunteer_name, next.volunteer_email, next.quantity, next.hours_known, next.start_epoch, next.slot_day
      ]);

      seen.add(sid);
      rows++;
      if (status === "filled") filledQty += q; else openQty += q;
      if (!d.known) tbdQty += q;

      if (!existing.has(sid)) {
        statements.push(env.DB.prepare(`
          INSERT INTO volunteer_slots(
            event_id,signupgenius_slot_id,title,slot_date,start_time,end_time,hours,status,
            volunteer_name,volunteer_email,raw_json,quantity,hours_known,start_epoch,slot_day,source,content_hash
          ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,'signupgenius',?)
        `).bind(
          db.id, sid, next.title, next.slot_date, next.start_time, next.end_time, next.hours, next.status,
          next.volunteer_name, next.volunteer_email, next.raw_json, next.quantity, next.hours_known,
          next.start_epoch, next.slot_day, hash
        ));
        inserted++;
        continue;
      }

      if (existing.get(sid) === hash) { unchanged++; continue; }

      statements.push(env.DB.prepare(`
        UPDATE volunteer_slots SET
          event_id=?,title=?,slot_date=?,start_time=?,end_time=?,hours=?,status=?,
          volunteer_name=?,volunteer_email=?,raw_json=?,quantity=?,hours_known=?,
          start_epoch=?,slot_day=?,source='signupgenius',content_hash=?,updated_at=datetime('now')
        WHERE signupgenius_slot_id=?
      `).bind(
        db.id, next.title, next.slot_date, next.start_time, next.end_time, next.hours, next.status,
        next.volunteer_name, next.volunteer_email, next.raw_json, next.quantity, next.hours_known,
        next.start_epoch, next.slot_day, hash, sid
      ));
      updated++;
    }

    for (const sid of existing.keys()) {
      if (!seen.has(sid)) {
        statements.push(env.DB.prepare("DELETE FROM volunteer_slots WHERE event_id=? AND signupgenius_slot_id=?").bind(db.id, sid));
        deleted++;
      }
    }

    await runBatches(env, statements);
  }

  return { events: events.length, rows, filledQty, openQty, tbdQty, inserted, updated, deleted, unchanged, eventsChanged };
}
