import type { Env } from "./types";

export type DashboardRange = { startEpoch?: number; endEpochExclusive?: number; startDate?: string; endDate?: string };

export async function getSettings(env:Env){
  const rows=await env.DB.prepare("SELECT key,value FROM settings").all<any>();
  const m=new Map((rows.results||[]).map((x:any)=>[x.key,x.value]));
  return{estimateUntimedEnabled:m.get("estimate_untimed_enabled")==="1",estimateUntimedHours:Number(m.get("estimate_untimed_hours")||6)};
}

function slotRange(alias:string, range:DashboardRange){
  const parts:string[]=[]; const binds:number[]=[];
  const epoch=`COALESCE(CAST(json_extract(${alias}.raw_json,'$.startdate') AS INTEGER),CASE WHEN ${alias}.slot_date GLOB '[0-9]*' THEN CAST(${alias}.slot_date AS INTEGER) END,0)`;
  if(range.startEpoch){parts.push(`${epoch}>=?`);binds.push(range.startEpoch)}
  if(range.endEpochExclusive){parts.push(`${epoch}<?`);binds.push(range.endEpochExclusive)}
  return{sql:parts.length?` AND ${parts.join(" AND ")}`:"",binds};
}
function stmt(env:Env,sql:string,binds:any[]){const q=env.DB.prepare(sql);return binds.length?q.bind(...binds):q}

export async function dashboard(env:Env, range:DashboardRange={}){
  const cfg=await getSettings(env), est=cfg.estimateUntimedEnabled?cfg.estimateUntimedHours:0;
  const rf=slotRange("v",range);
  const s=await stmt(env,`SELECT COALESCE(SUM(quantity),0) totalAssignments,COALESCE(SUM(CASE WHEN status='open' THEN quantity ELSE 0 END),0) openSlots,COALESCE(SUM(CASE WHEN status='filled' THEN quantity ELSE 0 END),0) assignedSlots,COALESCE(SUM(CASE WHEN hours_known=0 THEN quantity ELSE 0 END),0) tbdAssignments,COALESCE(SUM(CASE WHEN hours_known=1 THEN hours*quantity ELSE 0 END),0) knownNeeded,COALESCE(SUM(CASE WHEN status='filled' AND hours_known=1 THEN hours*quantity ELSE 0 END),0) knownFilled,COALESCE(SUM(CASE WHEN hours_known=0 THEN quantity ELSE 0 END),0) tbdNeededQty,COALESCE(SUM(CASE WHEN status='filled' AND hours_known=0 THEN quantity ELSE 0 END),0) tbdFilledQty FROM volunteer_slots v WHERE 1=1${rf.sql}`,rf.binds).first<any>();
  const knownNeeded=Number(s?.knownNeeded||0),knownFilled=Number(s?.knownFilled||0),needed=knownNeeded+Number(s?.tbdNeededQty||0)*est,filled=knownFilled+Number(s?.tbdFilledQty||0)*est;

  const e=await stmt(env,`SELECT e.id,e.signupgenius_id signupgeniusId,e.title,e.event_date eventDate,e.location,COALESCE(SUM(CASE WHEN v.hours_known=1 THEN v.hours*v.quantity ELSE 0 END),0) knownNeeded,COALESCE(SUM(CASE WHEN v.status='filled' AND v.hours_known=1 THEN v.hours*v.quantity ELSE 0 END),0) knownFilled,COALESCE(SUM(CASE WHEN v.hours_known=0 THEN v.quantity ELSE 0 END),0) tbdQty,COALESCE(SUM(CASE WHEN v.status='filled' AND v.hours_known=0 THEN v.quantity ELSE 0 END),0) tbdFilledQty,COALESCE(SUM(CASE WHEN v.status='open' THEN v.quantity ELSE 0 END),0) openSlots,COALESCE(SUM(CASE WHEN v.status='filled' THEN v.quantity ELSE 0 END),0) assignedSlots,MIN(CAST(json_extract(v.raw_json,'$.startdate') AS INTEGER)) firstEpoch FROM events e JOIN volunteer_slots v ON v.event_id=e.id WHERE 1=1${rf.sql} GROUP BY e.id ORDER BY firstEpoch,e.event_date`,rf.binds).all<any>();
  const l=await env.DB.prepare("SELECT sync_time syncTime,status FROM sync_log ORDER BY id DESC LIMIT 1").first<any>();
  const cl=await env.DB.prepare("SELECT sync_time syncTime,status,message FROM contact_sync_log ORDER BY id DESC LIMIT 1").first<any>();

  const volunteers=await stmt(env,`
    WITH cm AS (SELECT LOWER(email) email,COUNT(DISTINCT program) program_count,GROUP_CONCAT(DISTINCT program) programs,MIN(program) single_program FROM contact_mappings GROUP BY LOWER(email))
    SELECT COALESCE(NULLIF(v.volunteer_name,''),v.volunteer_email,'Unknown') name,v.volunteer_email email,
      COALESCE(SUM(CASE WHEN v.hours_known=1 THEN v.hours*v.quantity ELSE 0 END),0) knownHours,
      COALESCE(SUM(CASE WHEN v.hours_known=0 THEN v.quantity ELSE 0 END),0) tbdAssignments,
      COALESCE(SUM(v.quantity),0) assignments,
      CASE WHEN cm.program_count=1 THEN cm.single_program WHEN cm.program_count>1 THEN cm.programs ELSE 'Unmatched' END attribution,
      COALESCE(cm.program_count,0) programCount
    FROM volunteer_slots v LEFT JOIN cm ON LOWER(v.volunteer_email)=cm.email
    WHERE v.status='filled'${rf.sql}
    GROUP BY LOWER(COALESCE(v.volunteer_email,v.volunteer_name)) ORDER BY knownHours DESC,name LIMIT 250`,rf.binds).all<any>();

  const programs=await stmt(env,`
    WITH distinct_cm AS (SELECT DISTINCT LOWER(email) email, program FROM contact_mappings),
    counts AS (SELECT email,COUNT(*) program_count FROM distinct_cm GROUP BY email),
    vh AS (SELECT LOWER(v.volunteer_email) email,SUM(CASE WHEN v.hours_known=1 THEN v.hours*v.quantity ELSE 0 END) known_hours,SUM(CASE WHEN v.hours_known=0 THEN v.quantity ELSE 0 END) tbd_assignments FROM volunteer_slots v WHERE v.status='filled' AND v.volunteer_email IS NOT NULL${rf.sql} GROUP BY LOWER(v.volunteer_email))
    SELECT d.program name,COUNT(DISTINCT d.email) volunteers,COALESCE(SUM(vh.known_hours/counts.program_count),0) knownHours,COALESCE(SUM(vh.tbd_assignments*1.0/counts.program_count),0) tbdAssignments
    FROM distinct_cm d JOIN counts ON counts.email=d.email JOIN vh ON vh.email=d.email GROUP BY d.program ORDER BY knownHours DESC,name`,rf.binds).all<any>();

  const match=await stmt(env,`
    WITH cm AS (SELECT LOWER(email) email,COUNT(DISTINCT program) pc FROM contact_mappings GROUP BY LOWER(email)),
    vset AS (SELECT DISTINCT LOWER(v.volunteer_email) email FROM volunteer_slots v WHERE v.status='filled' AND v.volunteer_email IS NOT NULL${rf.sql})
    SELECT COUNT(*) total,COALESCE(SUM(CASE WHEN cm.pc>=1 THEN 1 ELSE 0 END),0) matched,COALESCE(SUM(CASE WHEN cm.pc>1 THEN 1 ELSE 0 END),0) ambiguous,COALESCE(SUM(CASE WHEN cm.pc IS NULL THEN 1 ELSE 0 END),0) unmatched FROM vset LEFT JOIN cm ON cm.email=vset.email`,rf.binds).first<any>();

  const contacts=await env.DB.prepare("SELECT COUNT(*) mappings,COUNT(DISTINCT LOWER(email)) uniqueEmails FROM contact_mappings").first<any>();
  const unmatched=await stmt(env,`
    WITH cm AS (SELECT LOWER(email) email,COUNT(DISTINCT program) pc,GROUP_CONCAT(DISTINCT program) programs FROM contact_mappings GROUP BY LOWER(email))
    SELECT COALESCE(NULLIF(v.volunteer_name,''),v.volunteer_email,'Unknown') name,v.volunteer_email email,COALESCE(cm.programs,'') programs,COALESCE(cm.pc,0) programCount,SUM(CASE WHEN v.hours_known=1 THEN v.hours*v.quantity ELSE 0 END) knownHours,SUM(CASE WHEN v.hours_known=0 THEN v.quantity ELSE 0 END) tbdAssignments
    FROM volunteer_slots v LEFT JOIN cm ON LOWER(v.volunteer_email)=cm.email WHERE v.status='filled' AND cm.pc IS NULL${rf.sql}
    GROUP BY LOWER(COALESCE(v.volunteer_email,v.volunteer_name)) ORDER BY knownHours DESC,name LIMIT 100`,rf.binds).all<any>();

  return {range:{startDate:range.startDate||null,endDate:range.endDate||null},settings:cfg,summary:{hoursNeeded:needed,hoursFilled:filled,hoursRemaining:Math.max(0,needed-filled),knownHoursNeeded:knownNeeded,knownHoursFilled:knownFilled,estimatedHoursNeeded:Number(s?.tbdNeededQty||0)*est,estimatedHoursFilled:Number(s?.tbdFilledQty||0)*est,fillRate:needed?filled/needed*100:0,activeEvents:e.results.length,totalAssignments:Number(s?.totalAssignments||0),openSlots:Number(s?.openSlots||0),assignedSlots:Number(s?.assignedSlots||0),tbdAssignments:Number(s?.tbdAssignments||0),lastSyncAt:l?.syncTime||null,lastSyncStatus:l?.status||null,contactSyncAt:cl?.syncTime||null,contactSyncStatus:cl?.status||null,contactMappings:Number(contacts?.mappings||0),uniqueContactEmails:Number(contacts?.uniqueEmails||0),matchedVolunteers:Number(match?.matched||0),ambiguousVolunteers:Number(match?.ambiguous||0),unmatchedVolunteers:Number(match?.unmatched||0),volunteerEmails:Number(match?.total||0)},programs:(programs.results||[]).map((x:any)=>({...x,knownHours:Number(x.knownHours||0),tbdAssignments:Number(x.tbdAssignments||0),volunteers:Number(x.volunteers||0)})),events:(e.results||[]).map((x:any)=>({...x,eventDate:x.eventDate||(x.firstEpoch?new Date(Number(x.firstEpoch)*1000).toISOString():null),hoursNeeded:Number(x.knownNeeded||0)+Number(x.tbdQty||0)*est,hoursFilled:Number(x.knownFilled||0)+Number(x.tbdFilledQty||0)*est})),volunteers:volunteers.results,unmatched:unmatched.results};
}
