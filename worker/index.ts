import type { Env } from "./types";
import { dashboard, getSettings } from "./db";
import { sync } from "./signupgenius";
import { syncContacts } from "./contacts";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS programs(id INTEGER PRIMARY KEY AUTOINCREMENT,name TEXT NOT NULL UNIQUE,required_hours REAL NOT NULL DEFAULT 0,color TEXT,created_at TEXT NOT NULL DEFAULT(datetime('now')),updated_at TEXT NOT NULL DEFAULT(datetime('now')));
CREATE TABLE IF NOT EXISTS families(id INTEGER PRIMARY KEY AUTOINCREMENT,parent_name TEXT,parent_email TEXT UNIQUE,secondary_email TEXT,phone TEXT,created_at TEXT NOT NULL DEFAULT(datetime('now')),updated_at TEXT NOT NULL DEFAULT(datetime('now')));
CREATE TABLE IF NOT EXISTS students(id INTEGER PRIMARY KEY AUTOINCREMENT,family_id INTEGER,student_name TEXT NOT NULL,program_id INTEGER,graduation_year INTEGER,created_at TEXT NOT NULL DEFAULT(datetime('now')),updated_at TEXT NOT NULL DEFAULT(datetime('now')));
CREATE TABLE IF NOT EXISTS events(id INTEGER PRIMARY KEY AUTOINCREMENT,signupgenius_id TEXT NOT NULL UNIQUE,title TEXT NOT NULL,event_date TEXT,location TEXT,affiliation TEXT,raw_json TEXT,updated_at TEXT NOT NULL DEFAULT(datetime('now')),created_at TEXT NOT NULL DEFAULT(datetime('now')));
CREATE TABLE IF NOT EXISTS volunteer_slots(id INTEGER PRIMARY KEY AUTOINCREMENT,event_id INTEGER NOT NULL,signupgenius_slot_id TEXT NOT NULL UNIQUE,title TEXT NOT NULL,slot_date TEXT,start_time TEXT,end_time TEXT,hours REAL NOT NULL DEFAULT 0,status TEXT NOT NULL DEFAULT 'unknown',volunteer_name TEXT,volunteer_email TEXT,raw_json TEXT,quantity INTEGER NOT NULL DEFAULT 1,hours_known INTEGER NOT NULL DEFAULT 0,created_at TEXT NOT NULL DEFAULT(datetime('now')),updated_at TEXT NOT NULL DEFAULT(datetime('now')));
CREATE TABLE IF NOT EXISTS sync_log(id INTEGER PRIMARY KEY AUTOINCREMENT,sync_time TEXT NOT NULL,records INTEGER NOT NULL DEFAULT 0,status TEXT NOT NULL,message TEXT);
CREATE TABLE IF NOT EXISTS settings(key TEXT PRIMARY KEY,value TEXT NOT NULL,updated_at TEXT NOT NULL DEFAULT(datetime('now')));
CREATE TABLE IF NOT EXISTS contact_mappings(id INTEGER PRIMARY KEY AUTOINCREMENT,email TEXT NOT NULL,parent_name TEXT,student_name TEXT,program TEXT NOT NULL,source_tab TEXT,source_type TEXT NOT NULL DEFAULT 'program_roster',updated_at TEXT NOT NULL DEFAULT(datetime('now')));
CREATE TABLE IF NOT EXISTS contact_sync_log(id INTEGER PRIMARY KEY AUTOINCREMENT,sync_time TEXT NOT NULL,records INTEGER NOT NULL DEFAULT 0,status TEXT NOT NULL,message TEXT);
CREATE TABLE IF NOT EXISTS volunteer_program_overrides(id INTEGER PRIMARY KEY AUTOINCREMENT,email TEXT NOT NULL,volunteer_name TEXT,program TEXT NOT NULL,created_at TEXT NOT NULL DEFAULT(datetime('now')),updated_at TEXT NOT NULL DEFAULT(datetime('now')),UNIQUE(email,program));
CREATE TABLE IF NOT EXISTS volunteer_affiliation_history(id INTEGER PRIMARY KEY AUTOINCREMENT,email TEXT NOT NULL,volunteer_name TEXT,program TEXT NOT NULL,effective_from TEXT NOT NULL,effective_to TEXT,created_at TEXT NOT NULL DEFAULT(datetime('now')),updated_at TEXT NOT NULL DEFAULT(datetime('now')),UNIQUE(email,program,effective_from));
CREATE INDEX IF NOT EXISTS idx_slots_event ON volunteer_slots(event_id);
CREATE INDEX IF NOT EXISTS idx_slots_email ON volunteer_slots(volunteer_email);
CREATE INDEX IF NOT EXISTS idx_contact_email ON contact_mappings(email);
CREATE INDEX IF NOT EXISTS idx_contact_program ON contact_mappings(program);
CREATE INDEX IF NOT EXISTS idx_override_email ON volunteer_program_overrides(email);
CREATE INDEX IF NOT EXISTS idx_override_program ON volunteer_program_overrides(program);
CREATE INDEX IF NOT EXISTS idx_affiliation_history_email ON volunteer_affiliation_history(email);
CREATE INDEX IF NOT EXISTS idx_affiliation_history_dates ON volunteer_affiliation_history(email,effective_from,effective_to);
CREATE INDEX IF NOT EXISTS idx_affiliation_history_program ON volunteer_affiliation_history(program);
INSERT OR IGNORE INTO programs(name,required_hours) VALUES('Guard',0),('Percussion',0),('Winds',0),('Band Boosters',0);
INSERT OR IGNORE INTO settings(key,value) VALUES('estimate_untimed_enabled','0'),('estimate_untimed_hours','6');
`;

let schemaReady: Promise<void> | null = null;
async function ensureColumns(env: Env) {
  const eventCols = await env.DB.prepare("PRAGMA table_info(events)").all<any>();
  const eventNames = new Set((eventCols.results || []).map((x:any) => x.name));
  if (!eventNames.has("affiliation")) await env.DB.prepare("ALTER TABLE events ADD COLUMN affiliation TEXT").run();
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
const adminSecret=(env:Env)=>env.ADMIN_TOKEN||env.SYNC_ADMIN_TOKEN||"";
const adminOK=(req:Request,env:Env)=>{
  const secret=adminSecret(env); if(!secret) return false;
  const h=req.headers.get("authorization")||"";
  return h===`Bearer ${secret}`;
};
const adminRequired=(req:Request,env:Env)=>{const configured=!!adminSecret(env);return adminOK(req,env)?null:json({error:configured?"Administrative authentication required.":"ADMIN_TOKEN is not configured. Add it as a Cloudflare Worker secret before using /admin."},configured?401:503)};

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
      if(u.pathname==="/api/health") return json({ok:true,version:"0.5.0",contactsSource:"embedded-normalized-roster",contactSyncMode:"d1-batch",dateFiltering:true,manualOverrides:true,effectiveDatedAffiliations:true,visualizations:true,scoreboard:true,organizationContribution:true,publicAdminSplit:true,manualHours:true,publicEmails:false,adminConfigured:!!adminSecret(env)});
      if(u.pathname==="/api/dashboard" || u.pathname==="/api/admin/dashboard") {
        const isAdmin=u.pathname==="/api/admin/dashboard";
        if(isAdmin){const denied=adminRequired(req,env);if(denied)return denied;}
        const startDate=u.searchParams.get("start")||undefined;
        const endDate=u.searchParams.get("end")||undefined;
        const valid=(x:string|undefined)=>!x||/^\d{4}-\d{2}-\d{2}$/.test(x);
        if(!valid(startDate)||!valid(endDate)) return json({error:"Dates must use YYYY-MM-DD format."},400);
        if(startDate&&endDate&&startDate>endDate) return json({error:"Start date cannot be after end date."},400);
        const today=new Intl.DateTimeFormat("en-CA",{timeZone:"America/New_York",year:"numeric",month:"2-digit",day:"2-digit"}).format(new Date());
        const resolvedEndDate=endDate||(startDate?today:undefined);
        const startEpoch=startDate?Math.floor(Date.parse(startDate+"T00:00:00Z")/1000):undefined;
        const endEpochExclusive=resolvedEndDate?Math.floor(Date.parse(resolvedEndDate+"T00:00:00Z")/1000)+86400:undefined;
        const data=await dashboard(env,{startDate,endDate,startEpoch,endEpochExclusive,asOfDate:resolvedEndDate||today});
        if(isAdmin) return json(data);
        // Public API deliberately omits volunteer names, emails, unmatched records, settings and admin-only identifiers.
        return json({range:data.range,summary:data.summary,programs:data.programs,events:data.events.map((e:any)=>({id:e.id,title:e.title,eventDate:e.eventDate,location:e.location,hoursNeeded:e.hoursNeeded,hoursFilled:e.hoursFilled,openSlots:e.openSlots,assignedSlots:e.assignedSlots}))});
      }
      if(adminOK(req,env)&&u.pathname==="/api/settings"&&req.method==="GET") return json(await getSettings(env));
      if(adminOK(req,env)&&u.pathname==="/api/settings"&&req.method==="POST") {
        const b:any=await req.json(); const enabled=!!b.estimateUntimedEnabled; const hours=Number(b.estimateUntimedHours);
        if(!Number.isFinite(hours)||hours<0||hours>24) return json({error:"Estimated untimed hours must be between 0 and 24."},400);
        await env.DB.prepare("INSERT INTO settings(key,value,updated_at) VALUES('estimate_untimed_enabled',?,datetime('now')) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=datetime('now')").bind(enabled?"1":"0").run();
        await env.DB.prepare("INSERT INTO settings(key,value,updated_at) VALUES('estimate_untimed_hours',?,datetime('now')) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=datetime('now')").bind(String(hours)).run();
        return json({ok:true,estimateUntimedEnabled:enabled,estimateUntimedHours:hours});
      }
      if(adminOK(req,env)&&u.pathname==="/api/sync"&&req.method==="POST") {
        if(!env.SIGNUPGENIUS_API_KEY) return json({error:"SIGNUPGENIUS_API_KEY is not configured."},500);
        const r=await runAll(env);
        const c=r.contacts?` Contacts: ${r.contacts.uniqueEmails} unique emails, ${r.contacts.multiProgramEmails} multi-program.`:` Contacts not refreshed: ${r.contactError}`;
        return json({ok:true,message:`Sync complete: ${r.signup.events} events, ${r.signup.filledQty} filled assignments, ${r.signup.openQty} open assignments.${c}`});
      }
      if(adminOK(req,env)&&u.pathname==="/api/contacts/sync"&&req.method==="POST") {
        const r=await syncContacts(env); return json({ok:true,message:`Contact sync complete: ${r.rows} normalized roster mappings across ${Object.keys(r.sourceCounts).length} programs, ${r.uniqueEmails} unique emails, ${r.multiProgramEmails} multi-program emails.`,...r});
      }
      if(adminOK(req,env)&&u.pathname==="/api/affiliations/history"&&req.method==="GET") {
        const email=String(u.searchParams.get("email")||"").trim().toLowerCase();
        if(!email||!email.includes("@")) return json({error:"A valid volunteer email is required."},400);
        const rows=await env.DB.prepare("SELECT program,effective_from effectiveFrom,effective_to effectiveTo,volunteer_name volunteerName FROM volunteer_affiliation_history WHERE LOWER(email)=? ORDER BY effective_from DESC,program").bind(email).all<any>();
        return json({email,history:rows.results||[]});
      }
      if(adminOK(req,env)&&u.pathname==="/api/affiliations/change"&&req.method==="POST") {
        const b:any=await req.json();
        const email=String(b.email||"").trim().toLowerCase();
        const name=String(b.name||"").trim();
        const effectiveDate=String(b.effectiveDate||"").trim();
        const programs=Array.from(new Set((Array.isArray(b.programs)?b.programs:[]).map((x:any)=>String(x).trim()).filter(Boolean))) as string[];
        if(!email||!email.includes("@")) return json({error:"A valid volunteer email is required."},400);
        if(!/^\d{4}-\d{2}-\d{2}$/.test(effectiveDate)) return json({error:"Effective date must use YYYY-MM-DD format."},400);
        if(programs.length>10) return json({error:"Too many programs selected."},400);
        const previousDate=new Date(effectiveDate+"T00:00:00Z"); previousDate.setUTCDate(previousDate.getUTCDate()-1);
        const previous=previousDate.toISOString().slice(0,10);
        const existing=await env.DB.prepare("SELECT COUNT(*) n FROM volunteer_affiliation_history WHERE LOWER(email)=?").bind(email).first<any>();
        if(!Number(existing?.n||0)){
          const overrides=await env.DB.prepare("SELECT program FROM volunteer_program_overrides WHERE LOWER(email)=? ORDER BY program").bind(email).all<any>();
          const roster=overrides.results?.length?overrides:await env.DB.prepare("SELECT DISTINCT program FROM contact_mappings WHERE LOWER(email)=? ORDER BY program").bind(email).all<any>();
          const oldPrograms=(roster.results||[]).map((x:any)=>String(x.program||"").trim()).filter(Boolean);
          if(oldPrograms.length){
            await env.DB.batch(oldPrograms.map(program=>env.DB.prepare("INSERT OR IGNORE INTO volunteer_affiliation_history(email,volunteer_name,program,effective_from,effective_to,updated_at) VALUES(?,?,?,'1900-01-01',?,datetime('now'))").bind(email,name||null,program,previous)));
          }
        }
        await env.DB.prepare("UPDATE volunteer_affiliation_history SET effective_to=?,updated_at=datetime('now') WHERE LOWER(email)=? AND effective_from<? AND (effective_to IS NULL OR effective_to>=?)").bind(previous,email,effectiveDate,effectiveDate).run();
        await env.DB.prepare("DELETE FROM volunteer_affiliation_history WHERE LOWER(email)=? AND effective_from>=?").bind(email,effectiveDate).run();
        if(programs.length){
          await env.DB.batch(programs.map(program=>env.DB.prepare("INSERT INTO volunteer_affiliation_history(email,volunteer_name,program,effective_from,effective_to,updated_at) VALUES(?,?,?,?,NULL,datetime('now'))").bind(email,name||null,program,effectiveDate)));
        }
        return json({ok:true,email,effectiveDate,programs,message:`Affiliation change saved for ${email} effective ${effectiveDate}: ${programs.length?programs.join(", "):"no active programs"}. Historical assignments before that date are unchanged.`});
      }

      if(adminOK(req,env)&&u.pathname==="/api/attribution/override"&&req.method==="POST") {
        const b:any=await req.json();
        const email=String(b.email||"").trim().toLowerCase();
        const name=String(b.name||"").trim();
        const programs=Array.from(new Set((Array.isArray(b.programs)?b.programs:[]).map((x:any)=>String(x).trim()).filter(Boolean))) as string[];
        if(!email||!email.includes("@")) return json({error:"A valid volunteer email is required."},400);
        if(programs.length>10) return json({error:"Too many programs selected."},400);
        const deletes=env.DB.prepare("DELETE FROM volunteer_program_overrides WHERE LOWER(email)=?").bind(email);
        const writes=programs.map(program=>env.DB.prepare("INSERT INTO volunteer_program_overrides(email,volunteer_name,program,updated_at) VALUES(?,?,?,datetime('now'))").bind(email,name||null,program));
        await env.DB.batch([deletes,...writes]);
        return json({ok:true,email,programs,message:programs.length?`Saved manual attribution for ${email}: ${programs.join(", ")}.`:`Removed manual attribution for ${email}; roster matching will be used again.`});
      }


      if(u.pathname==="/api/admin/manual-hours"&&req.method==="GET") {
        const denied=adminRequired(req,env);if(denied)return denied;
        const rows=await env.DB.prepare(`SELECT v.id, v.volunteer_name name, v.volunteer_email email, v.slot_date workDate, v.hours, e.title description, e.location, v.created_at createdAt FROM volunteer_slots v JOIN events e ON e.id=v.event_id WHERE v.signupgenius_slot_id LIKE 'manual:%' ORDER BY v.slot_date DESC,v.id DESC LIMIT 250`).all<any>();
        return json({rows:rows.results||[]});
      }
      if(u.pathname==="/api/admin/manual-hours"&&req.method==="POST") {
        const denied=adminRequired(req,env);if(denied)return denied;
        const b:any=await req.json();
        const name=String(b.name||"").trim(),email=String(b.email||"").trim().toLowerCase(),workDate=String(b.workDate||"").trim(),description=String(b.description||"Manual volunteer service").trim(),location=String(b.location||"").trim();
        const hours=Number(b.hours);
        if(!name) return json({error:"Volunteer name is required."},400);
        if(!email||!email.includes("@")) return json({error:"A valid volunteer email is required so the hours can be attributed to the correct program."},400);
        if(!/^\d{4}-\d{2}-\d{2}$/.test(workDate)) return json({error:"Work date must use YYYY-MM-DD format."},400);
        if(!Number.isFinite(hours)||hours<=0||hours>24) return json({error:"Hours must be greater than 0 and no more than 24."},400);
        const id=crypto.randomUUID();
        const eventKey=`manual:${workDate}:${id}`;
        await env.DB.prepare("INSERT INTO events(signupgenius_id,title,event_date,location,raw_json,updated_at) VALUES(?,?,?,?,?,datetime('now'))").bind(eventKey,description,workDate,location||null,JSON.stringify({source:"manual"})).run();
        const er=await env.DB.prepare("SELECT id FROM events WHERE signupgenius_id=?").bind(eventKey).first<any>();
        if(!er?.id) return json({error:"Unable to create manual volunteer event record."},500);
        await env.DB.prepare("INSERT INTO volunteer_slots(event_id,signupgenius_slot_id,title,slot_date,hours,status,volunteer_name,volunteer_email,raw_json,quantity,hours_known,updated_at) VALUES(?,?,?,?,?,'filled',?,?,?,1,1,datetime('now'))").bind(er.id,`manual:${id}`,description,workDate,hours,name,email,JSON.stringify({source:"manual",enteredAt:new Date().toISOString()})).run();
        return json({ok:true,message:`Added ${hours} manual volunteer hours for ${name} on ${workDate}.`});
      }
      if(u.pathname.startsWith("/api/admin/manual-hours/")&&req.method==="DELETE") {
        const denied=adminRequired(req,env);if(denied)return denied;
        const id=Number(u.pathname.split("/").pop());
        if(!Number.isInteger(id)||id<=0) return json({error:"Invalid manual-hours record."},400);
        const row=await env.DB.prepare("SELECT event_id FROM volunteer_slots WHERE id=? AND signupgenius_slot_id LIKE 'manual:%'").bind(id).first<any>();
        if(!row) return json({error:"Manual-hours record not found."},404);
        await env.DB.prepare("DELETE FROM volunteer_slots WHERE id=?").bind(id).run();
        await env.DB.prepare("DELETE FROM events WHERE id=? AND signupgenius_id LIKE 'manual:%'").bind(row.event_id).run();
        return json({ok:true,message:"Manual volunteer-hours record deleted."});
      }
      if(["/api/settings","/api/sync","/api/contacts/sync","/api/affiliations/history","/api/affiliations/change","/api/attribution/override"].includes(u.pathname) && !adminOK(req,env)) {
        const denied=adminRequired(req,env);if(denied)return denied;
      }
      if(u.pathname.startsWith("/api/")) return json({error:"Not found"},404);
      return env.ASSETS.fetch(req);
    } catch(e) { return json({error:e instanceof Error?e.message:"Unexpected server error"},500); }
  },
  async scheduled(_c:any,env:Env) { if(env.SIGNUPGENIUS_API_KEY) await runAll(env); }
};
