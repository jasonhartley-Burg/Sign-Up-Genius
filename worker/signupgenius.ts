import type{Env}from"./types";
const rec=(x:unknown):Record<string,any>=>x&&typeof x==="object"&&!Array.isArray(x)?x as Record<string,any>:{};
const str=(o:Record<string,any>,keys:string[])=>{for(const k of keys){if(typeof o[k]==="string"&&o[k].trim())return o[k].trim();if(typeof o[k]==="number")return String(o[k])}return null};
const arr=(x:unknown):unknown[]=>{
  if(Array.isArray(x))return x;
  const o=rec(x);
  for(const k of["data","results","signups","signup","items","slots","reports","report","rows","records"]){
    if(Array.isArray(o[k]))return o[k];
    if(o[k]&&typeof o[k]==="object"){const a=arr(o[k]);if(a.length)return a}
  }
  return[]
};
const norm=(s:string)=>s.toLowerCase().replace(/[^a-z0-9]/g,"");
function findValue(x:unknown,names:string[],depth=0):any{
  if(depth>5||x==null)return null;
  const targets=new Set(names.map(norm));
  if(Array.isArray(x)){for(const v of x){const r=findValue(v,names,depth+1);if(r!==null&&r!==undefined&&r!=="")return r}return null}
  const o=rec(x);
  for(const [k,v] of Object.entries(o)){
    if(targets.has(norm(k)) && v!==null && v!==undefined && v!=="")return v;
  }
  for(const v of Object.values(o)){
    if(v&&typeof v==="object"){const r=findValue(v,names,depth+1);if(r!==null&&r!==undefined&&r!=="")return r}
  }
  return null;
}
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
    const s=value.trim();
    const h=s.match(/(\d+(?:\.\d+)?)\s*(?:hours?|hrs?)/i);
    if(h)return Number(h[1]);
    const m=s.match(/^(\d+(?:\.\d+)?)$/);
    if(m)return Number(m[1]);
  }
  return null;
}
function timeMinutes(value:any){
  if(value==null)return null;
  const s=String(value).trim();
  if(!s)return null;
  const d=new Date(s);
  if(/\d{4}-\d{2}-\d{2}/.test(s)&&!Number.isNaN(d.getTime()))return d.getHours()*60+d.getMinutes();
  const m=s.match(/(\d{1,2}):(\d{2})(?::\d{2})?\s*(AM|PM)?/i);
  if(!m)return null;
  let h=Number(m[1]),min=Number(m[2]);const ap=(m[3]||"").toUpperCase();
  if(ap==="PM"&&h<12)h+=12;if(ap==="AM"&&h===12)h=0;
  return h<=23&&min<=59?h*60+min:null;
}
function hours(o:Record<string,any>){
  const direct=findValue(o,["hours","duration_hours","slothours","slot_hours","length_hours","duration","volunteer_hours","volunteerhours"]);
  const n=numericHours(direct);if(n!==null)return n;
  const start=findValue(o,["start_time","starttime","start","time_start","begintime","startdate"]);
  const end=findValue(o,["end_time","endtime","end","time_end","endtime","finishtime","enddate"]);
  const a=timeMinutes(start),b=timeMinutes(end);
  if(a!==null&&b!==null){let diff=b-a;if(diff<0)diff+=1440;if(diff>0)return diff/60}
  return 0;
}
function valueString(o:Record<string,any>,keys:string[]){
  const v=findValue(o,keys);
  return v===null||v===undefined?"":String(v).trim();
}
function slotTitle(o:Record<string,any>){return valueString(o,["slot_title","slottitle","title","name","description"])||"Volunteer Slot"}
function slotDate(o:Record<string,any>){return valueString(o,["slot_date","slotdate","date","event_date","eventdate","start_date","startdate"])}
function slotStart(o:Record<string,any>){return valueString(o,["start_time","starttime","time_start","start"])}
function slotEnd(o:Record<string,any>){return valueString(o,["end_time","endtime","time_end","end"])}
function slotId(o:Record<string,any>,fallback:string){
  const v=valueString(o,["slotid","slot_id","signupslotid","signup_slot_id","id"]);
  if(v)return v;
  return `${fallback}|${slotTitle(o)}|${slotDate(o)}|${slotStart(o)}|${slotEnd(o)}`;
}
function volunteer(o:Record<string,any>){
  const v=rec(o.volunteer||o.member||o.signedup||o.signUp||o.participant||o.user||{});
  const name=valueString(o,["volunteer_name","volunteername","signedup_name","signedupname","member_name","membername","participant_name","participantname","full_name","fullname","name"])||valueString(v,["name","full_name","fullname","volunteer_name","volunteername"]);
  const email=valueString(o,["volunteer_email","volunteeremail","signedup_email","signedupemail","member_email","memberemail","participant_email","participantemail","email","email_address","emailaddress"])||valueString(v,["email","email_address","emailaddress"]);
  return{name,email};
}
function looksFilled(o:Record<string,any>){
  const {name,email}=volunteer(o);if(name||email)return true;
  const count=findValue(o,["number_signed_up","numbersignedup","signed_up_count","signedupcount","quantity_filled","quantityfilled","filled_count","filledcount"]);
  if(typeof count==="number"&&count>0)return true;
  if(typeof count==="string"&&Number(count)>0)return true;
  const flag=findValue(o,["filled","is_filled","isfilled","signed_up","signedup"]);
  return flag===true||flag==="true"||flag===1||flag==="1";
}
export async function sync(env:Env){
  const events=arr(await get(env,"/signups/created/active/"));let slots=0;
  for(let i=0;i<events.length;i++){
    const e=rec(events[i]);
    const eid=str(e,["signupid","signupId","id","signup_id"])||`unknown-${i}`;
    const title=str(e,["title","name","signup_title","signupTitle"])||`SignUpGenius ${eid}`;
    await env.DB.prepare(`INSERT INTO events(signupgenius_id,title,event_date,location,raw_json,updated_at)
      VALUES(?,?,?,?,?,datetime('now')) ON CONFLICT(signupgenius_id) DO UPDATE SET
      title=excluded.title,event_date=excluded.event_date,location=excluded.location,
      raw_json=excluded.raw_json,updated_at=datetime('now')`)
      .bind(eid,title,str(e,["date","event_date","eventDate","start_date","startDate"]),
        str(e,["location","event_location","eventLocation"]),JSON.stringify(events[i])).run();
    const db=await env.DB.prepare("SELECT id FROM events WHERE signupgenius_id=?").bind(eid).first<{id:number}>();
    if(!db)continue;

    const allRows=arr(await get(env,`/signups/report/all/${encodeURIComponent(eid)}/`));
    const availableRows=arr(await get(env,`/signups/report/available/${encodeURIComponent(eid)}/`));
    const availableIds=new Set<string>();
    for(let j=0;j<availableRows.length;j++){const row=rec(availableRows[j]);availableIds.add(slotId(row,`${eid}-available-${j}`))}
    await env.DB.prepare("DELETE FROM volunteer_slots WHERE event_id=?").bind(db.id).run();

    const merged=new Map<string,Record<string,any>>();
    for(let j=0;j<allRows.length;j++){const row=rec(allRows[j]);merged.set(slotId(row,`${eid}-${j}`),row)}
    for(let j=0;j<availableRows.length;j++){const row=rec(availableRows[j]);const id=slotId(row,`${eid}-available-${j}`);if(!merged.has(id))merged.set(id,row)}

    for(const[sid,s]of merged){
      const {name,email}=volunteer(s);
      // SignUpGenius' available report is the authoritative source for open slots.
      // When the ID is not in that report, the slot is filled unless the row itself
      // explicitly says otherwise.
      const status=availableIds.size>0?(availableIds.has(sid)?"open":"filled"):(looksFilled(s)?"filled":"open");
      const h=hours(s);
      await env.DB.prepare(`INSERT INTO volunteer_slots(
        event_id,signupgenius_slot_id,title,slot_date,start_time,end_time,hours,status,
        volunteer_name,volunteer_email,raw_json
      ) VALUES(?,?,?,?,?,?,?,?,?,?,?)
      ON CONFLICT(signupgenius_slot_id) DO UPDATE SET
        event_id=excluded.event_id,title=excluded.title,slot_date=excluded.slot_date,
        start_time=excluded.start_time,end_time=excluded.end_time,hours=excluded.hours,
        status=excluded.status,volunteer_name=excluded.volunteer_name,
        volunteer_email=excluded.volunteer_email,raw_json=excluded.raw_json,
        updated_at=datetime('now')`)
      .bind(db.id,sid,slotTitle(s),slotDate(s),slotStart(s),slotEnd(s),h,status,name||null,email||null,JSON.stringify(s)).run();
      slots++;
    }
  }
  return{events:events.length,slots};
}
