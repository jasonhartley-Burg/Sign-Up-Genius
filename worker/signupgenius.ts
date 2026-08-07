import type{Env}from"./types";
const rec=(x:unknown):Record<string,any>=>x&&typeof x==="object"?x as Record<string,any>:{};
const str=(o:Record<string,any>,keys:string[])=>{for(const k of keys){if(typeof o[k]==="string"&&o[k].trim())return o[k].trim();if(typeof o[k]==="number")return String(o[k])}return null};
const arr=(x:unknown):unknown[]=>{if(Array.isArray(x))return x;const o=rec(x);for(const k of["data","results","signups","signup","items","slots","reports","report"]){if(Array.isArray(o[k]))return o[k];if(o[k]&&typeof o[k]==="object"){const a=arr(o[k]);if(a.length)return a}}return[]};

async function get(env:Env,path:string){
  const u=new URL(`${(env.SIGNUPGENIUS_API_BASE||"https://api.signupgenius.com/v2/k/").replace(/\/+$/,"")}/${path.replace(/^\/+/,"")}`);
  u.searchParams.set("user_key",env.SIGNUPGENIUS_API_KEY);
  const r=await fetch(u,{headers:{Accept:"application/json"}});
  const t=await r.text();
  if(!r.ok)throw Error(`SignUpGenius API ${r.status}: ${t.slice(0,400)}`);
  return JSON.parse(t);
}

function numericHours(value:any){
  if(typeof value==="number"&&Number.isFinite(value)&&value>=0)return value;
  if(typeof value==="string"){
    const m=value.match(/(\d+(?:\.\d+)?)/);
    if(m){const n=Number(m[1]);if(Number.isFinite(n)&&n>=0)return n}
  }
  return null;
}

function timeMinutes(value:any){
  if(value==null)return null;
  const s=String(value).trim();
  if(!s)return null;

  // ISO/full date-time values.
  if(/\d{4}-\d{2}-\d{2}T/.test(s)){
    const d=new Date(s);
    if(!Number.isNaN(d.getTime()))return d.getHours()*60+d.getMinutes();
  }

  // HH:MM[:SS] with optional AM/PM.
  const m=s.match(/(\d{1,2}):(\d{2})(?::\d{2})?\s*(AM|PM)?/i);
  if(!m)return null;
  let h=Number(m[1]), min=Number(m[2]);
  const ap=(m[3]||"").toUpperCase();
  if(ap==="PM"&&h<12)h+=12;
  if(ap==="AM"&&h===12)h=0;
  if(h>23||min>59)return null;
  return h*60+min;
}

function hours(o:Record<string,any>){
  for(const k of["hours","duration_hours","slot_hours","length_hours","duration"]){
    const n=numericHours(o[k]);
    if(n!==null)return n;
  }
  const start=str(o,["start_time","startTime","start","time_start"]);
  const end=str(o,["end_time","endTime","end","time_end"]);
  const a=timeMinutes(start),b=timeMinutes(end);
  if(a!==null&&b!==null){
    let diff=b-a;
    if(diff<0)diff+=24*60;
    if(diff>0)return diff/60;
  }
  return 0;
}

function slotId(o:Record<string,any>,fallback:string){
  return str(o,["slotid","slotId","signupslotid","signup_slot_id","slot_id","id"])||fallback;
}

function volunteer(o:Record<string,any>){
  const v=rec(o.volunteer||o.member||o.signedup||o.signUp||{});
  const name=str(o,["volunteer_name","volunteerName","name","signedup_name","signedUpName","member_name","memberName"])||str(v,["name","full_name","fullName","volunteer_name","volunteerName"]);
  const email=str(o,["volunteer_email","volunteerEmail","email","signedup_email","signedUpEmail","member_email","memberEmail"])||str(v,["email","email_address","emailAddress"]);
  return {name,email};
}

export async function sync(env:Env){
  const events=arr(await get(env,"/signups/created/active/"));
  let slots=0;

  for(let i=0;i<events.length;i++){
    const e=rec(events[i]);
    const eid=str(e,["signupid","signupId","id","signup_id"])||`unknown-${i}`;
    const title=str(e,["title","name","signup_title","signupTitle"])||`SignUpGenius ${eid}`;

    await env.DB.prepare(`INSERT INTO events(signupgenius_id,title,event_date,location,raw_json,updated_at)
      VALUES(?,?,?,?,?,datetime('now'))
      ON CONFLICT(signupgenius_id) DO UPDATE SET
      title=excluded.title,event_date=excluded.event_date,location=excluded.location,
      raw_json=excluded.raw_json,updated_at=datetime('now')`)
      .bind(eid,title,str(e,["date","event_date","eventDate","start_date","startDate"]),
        str(e,["location","event_location","eventLocation"]),JSON.stringify(events[i])).run();

    const db=await env.DB.prepare("SELECT id FROM events WHERE signupgenius_id=?").bind(eid).first<{id:number}>();
    if(!db)continue;

    // Pull both filled and available reports. The previous release only pulled
    // report/all, which could not reliably tell us the open slots or their hours.
    const allRows=arr(await get(env,`/signups/report/all/${encodeURIComponent(eid)}/`));
    const availableRows=arr(await get(env,`/signups/report/available/${encodeURIComponent(eid)}/`));

    const availableIds=new Set<string>();
    for(let j=0;j<availableRows.length;j++){
      availableIds.add(slotId(rec(availableRows[j]),`${eid}-available-${j}`));
    }

    await env.DB.prepare("DELETE FROM volunteer_slots WHERE event_id=?").bind(db.id).run();

    const merged=new Map<string,Record<string,any>>();
    for(let j=0;j<allRows.length;j++){
      const row=rec(allRows[j]);
      merged.set(slotId(row,`${eid}-${j}`),row);
    }
    for(let j=0;j<availableRows.length;j++){
      const row=rec(availableRows[j]);
      const id=slotId(row,`${eid}-available-${j}`);
      if(!merged.has(id))merged.set(id,row);
    }

    for(const [sid,s] of merged){
      const {name,email}=volunteer(s);
      const status=(name||email)?"filled":(availableIds.has(sid)?"open":"unknown");
      const h=hours(s);

      await env.DB.prepare(`INSERT INTO volunteer_slots(
        event_id,signupgenius_slot_id,title,slot_date,start_time,end_time,hours,status,
        volunteer_name,volunteer_email,raw_json
      ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)
      ON CONFLICT(signupgenius_slot_id) DO UPDATE SET
        event_id=excluded.event_id,title=excluded.title,slot_date=excluded.slot_date,
        start_time=excluded.start_time,end_time=excluded.end_time,hours=excluded.hours,
        status=excluded.status,volunteer_name=excluded.volunteer_name,
        volunteer_email=excluded.volunteer_email,raw_json=excluded.raw_json,
        updated_at=datetime('now')`)
      .bind(
        db.id,sid,
        str(s,["title","slot_title","slotTitle","name","description"])||"Volunteer Slot",
        str(s,["date","event_date","eventDate"]),
        str(s,["start_time","startTime","start"]),
        str(s,["end_time","endTime","end"]),
        h,status,name,email,JSON.stringify(s)
      ).run();

      slots++;
    }
  }

  return{events:events.length,slots};
}