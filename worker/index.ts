import type { Env } from "./types";
import { dashboard, getSettings } from "./db";
import { sync } from "./signupgenius";
import { syncContacts } from "./contacts";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS programs(id INTEGER PRIMARY KEY AUTOINCREMENT,name TEXT NOT NULL UNIQUE,required_hours REAL NOT NULL DEFAULT 0,color TEXT,created_at TEXT NOT NULL DEFAULT(datetime('now')),updated_at TEXT NOT NULL DEFAULT(datetime('now')));
CREATE TABLE IF NOT EXISTS families(id INTEGER PRIMARY KEY AUTOINCREMENT,parent_name TEXT,parent_email TEXT UNIQUE,secondary_email TEXT,phone TEXT,created_at TEXT NOT NULL DEFAULT(datetime('now')),updated_at TEXT NOT NULL DEFAULT(datetime('now')));
CREATE TABLE IF NOT EXISTS students(id INTEGER PRIMARY KEY AUTOINCREMENT,family_id INTEGER,student_name TEXT NOT NULL,program_id INTEGER,graduation_year INTEGER,created_at TEXT NOT NULL DEFAULT(datetime('now')),updated_at TEXT NOT NULL DEFAULT(datetime('now')));
CREATE TABLE IF NOT EXISTS events(id INTEGER PRIMARY KEY AUTOINCREMENT,signupgenius_id TEXT NOT NULL UNIQUE,title TEXT NOT NULL,event_date TEXT,location TEXT,raw_json TEXT,updated_at TEXT NOT NULL DEFAULT(datetime('now')),created_at TEXT NOT NULL DEFAULT(datetime('now')));
CREATE TABLE IF NOT EXISTS volunteer_slots(id INTEGER PRIMARY KEY AUTOINCREMENT,event_id INTEGER NOT NULL,signupgenius_slot_id TEXT NOT NULL UNIQUE,title TEXT NOT NULL,slot_date TEXT,start_time TEXT,end_time TEXT,hours REAL NOT NULL DEFAULT 0,status TEXT NOT NULL DEFAULT 'unknown',volunteer_name TEXT,volunteer_email TEXT,raw_json TEXT,quantity INTEGER NOT NULL DEFAULT 1,hours_known INTEGER NOT NULL DEFAULT 0,created_at TEXT NOT NULL DEFAULT(datetime('now')),updated_at TEXT NOT NULL DEFAULT(datetime('now')));
CREATE TABLE IF NOT EXISTS sync_log(id INTEGER PRIMARY KEY AUTOINCREMENT,sync_time TEXT NOT NULL,records INTEGER NOT NULL DEFAULT 0,status TEXT NOT NULL,message TEXT);
CREATE TABLE IF NOT EXISTS settings(key TEXT PRIMARY KEY,value TEXT NOT NULL,updated_at TEXT NOT NULL DEFAULT(datetime('now')));
CREATE TABLE IF NOT EXISTS contact_mappings(id INTEGER PRIMARY KEY AUTOINCREMENT,email TEXT NOT NULL,parent_name TEXT,student_name TEXT,program TEXT NOT NULL,source_tab TEXT,source_type TEXT NOT NULL DEFAULT 'program_roster',updated_at TEXT NOT NULL DEFAULT(datetime('now')));
CREATE TABLE IF NOT EXISTS contact_sync_log(id INTEGER PRIMARY KEY AUTOINCREMENT,sync_time TEXT NOT NULL,records INTEGER NOT NULL DEFAULT 0,status TEXT NOT NULL,message TEXT);
CREATE INDEX IF NOT EXISTS idx_slots_event ON volunteer_slots(event_id);
CREATE INDEX IF NOT EXISTS idx_slots_email ON volunteer_slots(volunteer_email);
CREATE INDEX IF NOT EXISTS idx_contact_email ON contact_mappings(email);
CREATE INDEX IF NOT EXISTS idx_contact_program ON contact_mappings(program);
INSERT OR IGNORE INTO programs(name,required_hours) VALUES('Guard',0),('Percussion',0),('Winds',0),('Band Boosters',0);
INSERT OR IGNORE INTO settings(key,value) VALUES('estimate_untimed_enabled','0'),('estimate_untimed_hours','6');
`;

let schemaReady: Promise<void> | null = null;
async function ensureColumns(env: Env) {
  const cols = await env.DB.prepare("PRAGMA table_info(volunteer_slots)").all<any>();
  const names = new Set((cols.results || []).map((x:any) => x.name));
  if (!names.has("quantity")) await env.DB.prepare("ALTER TABLE volunteer_slots ADD COLUMN quantity INTEGER NOT NULL DEFAULT 1").run();
  if (!names.has("hours_known")) await env.DB.prepare("ALTER TABLE volunteer_slots ADD COLUMN hours_known INTEGER NOT NULL DEFAULT 0").run();
}
async function ensureSchema(env: Env) {
  if (!schemaReady) schemaReady = (async () => {
    for (const statement of SCHEMA.split(";").map(x => x.trim()).filter(Boolean)) await env.DB.prepare(statement).run();
    await ensureColumns(env);
  })();
  await schemaReady;
}
const json = (x:unknown, s=200) => new Response(JSON.stringify(x), { status:s, headers:{"content-type":"application/json","cache-control":"no-store"} });

async function runSignup(env:Env) {
  const t = new Date().toISOString();
  try {
    const r = await sync(env);
    await env.DB.prepare("INSERT INTO sync_log(sync_time,records,status,message) VALUES(?,?,?,?)")
      .bind(t,r.rows,"success",`Synced ${r.events} events, ${r.rows} report rows, ${r.filledQty} filled assignments, ${r.openQty} open assignments, ${r.tbdQty} time-TBD assignments.`).run();
    return r;
  } catch(e) {
    const m=e instanceof Error?e.message:String(e);
    await env.DB.prepare("INSERT INTO sync_log(sync_time,records,status,message) VALUES(?,?,?,?)").bind(t,0,"error",m.slice(0,2000)).run();
    throw e;
  }
}
async function runAll(env:Env) {
  const signup = await runSignup(env);
  let contacts:any = null, contactError:string|null = null;
  try { contacts = await syncContacts(env); } catch(e) { contactError = e instanceof Error ? e.message : String(e); }
  return { signup, contacts, contactError };
}

export default {
  async fetch(req:Request, env:Env) {
    const u=new URL(req.url);
    try {
      await ensureSchema(env);
      if(u.pathname==="/api/health") return json({ok:true,version:"0.3.1",contactsSource:"embedded-normalized-roster",contactSyncMode:"d1-batch",dateFiltering:true});
      if(u.pathname==="/api/dashboard") {
        const startDate=u.searchParams.get("start")||undefined;
        const endDate=u.searchParams.get("end")||undefined;
        const valid=(x:string|undefined)=>!x||/^\d{4}-\d{2}-\d{2}$/.test(x);
        if(!valid(startDate)||!valid(endDate)) return json({error:"Dates must use YYYY-MM-DD format."},400);
        if(startDate&&endDate&&startDate>endDate) return json({error:"Start date cannot be after end date."},400);
        const startEpoch=startDate?Math.floor(Date.parse(startDate+"T00:00:00Z")/1000):undefined;
        const endEpochExclusive=endDate?Math.floor(Date.parse(endDate+"T00:00:00Z")/1000)+86400:undefined;
        return json(await dashboard(env,{startDate,endDate,startEpoch,endEpochExclusive}));
      }
      if(u.pathname==="/api/settings"&&req.method==="GET") return json(await getSettings(env));
      if(u.pathname==="/api/settings"&&req.method==="POST") {
        const b:any=await req.json(); const enabled=!!b.estimateUntimedEnabled; const hours=Number(b.estimateUntimedHours);
        if(!Number.isFinite(hours)||hours<0||hours>24) return json({error:"Estimated untimed hours must be between 0 and 24."},400);
        await env.DB.prepare("INSERT INTO settings(key,value,updated_at) VALUES('estimate_untimed_enabled',?,datetime('now')) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=datetime('now')").bind(enabled?"1":"0").run();
        await env.DB.prepare("INSERT INTO settings(key,value,updated_at) VALUES('estimate_untimed_hours',?,datetime('now')) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=datetime('now')").bind(String(hours)).run();
        return json({ok:true,estimateUntimedEnabled:enabled,estimateUntimedHours:hours});
      }
      if(u.pathname==="/api/sync"&&req.method==="POST") {
        if(!env.SIGNUPGENIUS_API_KEY) return json({error:"SIGNUPGENIUS_API_KEY is not configured."},500);
        const r=await runAll(env);
        const c=r.contacts?` Contacts: ${r.contacts.uniqueEmails} unique emails, ${r.contacts.multiProgramEmails} multi-program.`:` Contacts not refreshed: ${r.contactError}`;
        return json({ok:true,message:`Sync complete: ${r.signup.events} events, ${r.signup.filledQty} filled assignments, ${r.signup.openQty} open assignments.${c}`});
      }
      if(u.pathname==="/api/contacts/sync"&&req.method==="POST") {
        const r=await syncContacts(env); return json({ok:true,message:`Contact sync complete: ${r.rows} normalized roster mappings across ${Object.keys(r.sourceCounts).length} programs, ${r.uniqueEmails} unique emails, ${r.multiProgramEmails} multi-program emails.`,...r});
      }
      if(u.pathname.startsWith("/api/")) return json({error:"Not found"},404);
      return env.ASSETS.fetch(req);
    } catch(e) { return json({error:e instanceof Error?e.message:"Unexpected server error"},500); }
  },
  async scheduled(_c:any,env:Env) { if(env.SIGNUPGENIUS_API_KEY) await runAll(env); }
};
