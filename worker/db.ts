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

const EFFECTIVE_CTE=`
  override_emails AS (SELECT DISTINCT LOWER(email) email FROM volunteer_program_overrides),
  effective_cm AS (
    SELECT LOWER(email) email, program, 'manual' source FROM volunteer_program_overrides
    UNION ALL
    SELECT LOWER(c.email) email, c.program, 'roster' source FROM contact_mappings c
    WHERE LOWER(c.email) NOT IN (SELECT email FROM override_emails)
  )`;

export async function dashboard(env:Env, range:DashboardRange={}){
  const cfg=await getSettings(env), est=cfg.estimateUntimedEnabled?cfg.estimateUntimedHours:0;
  const rf=slotRange("v",range);
  const s=await stmt(env,`SELECT COALESCE(SUM(quantity),0) totalAssignments,COALESCE(SUM(CASE WHEN status='open' THEN quantity ELSE 0 END),0) openSlots,COALESCE(SUM(CASE WHEN status='filled' THEN quantity ELSE 0 END),0) assignedSlots,COALESCE(SUM(CASE WHEN hours_known=0 THEN quantity ELSE 0 END),0) tbdAssignments,COALESCE(SUM(CASE WHEN hours_known=1 THEN hours*quantity ELSE 0 END),0) knownNeeded,COALESCE(SUM(CASE WHEN status='filled' AND hours_known=1 THEN hours*quantity ELSE 0 END),0) knownFilled,COALESCE(SUM(CASE WHEN hours_known=0 THEN quantity ELSE 0 END),0) tbdNeededQty,COALESCE(SUM(CASE WHEN status='filled' AND hours_known=0 THEN quantity ELSE 0 END),0) tbdFilledQty FROM volunteer_slots v WHERE 1=1${rf.sql}`,rf.binds).first<any>();
  const knownNeeded=Number(s?.knownNeeded||0),knownFilled=Number(s?.knownFilled||0),needed=knownNeeded+Number(s?.tbdNeededQty||0)*est,filled=knownFilled+Number(s?.tbdFilledQty||0)*est;

  const e=await stmt(env,`SELECT e.id,e.signupgenius_id signupgeniusId,e.title,e.event_date eventDate,e.location,e.affiliation,COALESCE(SUM(CASE WHEN v.hours_known=1 THEN v.hours*v.quantity ELSE 0 END),0) knownNeeded,COALESCE(SUM(CASE WHEN v.status='filled' AND v.hours_known=1 THEN v.hours*v.quantity ELSE 0 END),0) knownFilled,COALESCE(SUM(CASE WHEN v.hours_known=0 THEN v.quantity ELSE 0 END),0) tbdQty,COALESCE(SUM(CASE WHEN v.status='filled' AND v.hours_known=0 THEN v.quantity ELSE 0 END),0) tbdFilledQty,COALESCE(SUM(CASE WHEN v.status='open' THEN v.quantity ELSE 0 END),0) openSlots,COALESCE(SUM(CASE WHEN v.status='filled' THEN v.quantity ELSE 0 END),0) assignedSlots,MIN(CAST(json_extract(v.raw_json,'$.startdate') AS INTEGER)) firstEpoch FROM events e JOIN volunteer_slots v ON v.event_id=e.id WHERE 1=1${rf.sql} GROUP BY e.id ORDER BY firstEpoch,e.event_date`,rf.binds).all<any>();
  const l=await env.DB.prepare("SELECT sync_time syncTime,status FROM sync_log ORDER BY id DESC LIMIT 1").first<any>();
  const cl=await env.DB.prepare("SELECT sync_time syncTime,status,message FROM contact_sync_log ORDER BY id DESC LIMIT 1").first<any>();

  const volunteers=await stmt(env,`
    WITH ${EFFECTIVE_CTE}, cm AS (SELECT email,COUNT(DISTINCT program) program_count,GROUP_CONCAT(DISTINCT program) programs,MIN(program) single_program,MAX(CASE WHEN source='manual' THEN 1 ELSE 0 END) manual FROM effective_cm GROUP BY email)
    SELECT COALESCE(NULLIF(v.volunteer_name,''),v.volunteer_email,'Unknown') name,v.volunteer_email email,
      COALESCE(SUM(CASE WHEN v.hours_known=1 THEN v.hours*v.quantity ELSE 0 END),0) knownHours,
      COALESCE(SUM(CASE WHEN v.hours_known=0 THEN v.quantity ELSE 0 END),0) tbdAssignments,
      COALESCE(SUM(v.quantity),0) assignments,
      CASE WHEN cm.program_count=1 THEN cm.single_program WHEN cm.program_count>1 THEN cm.programs ELSE 'Unmatched' END attribution,
      COALESCE(cm.program_count,0) programCount, COALESCE(cm.manual,0) manualOverride
    FROM volunteer_slots v LEFT JOIN cm ON LOWER(v.volunteer_email)=cm.email
    WHERE v.status='filled'${rf.sql}
    GROUP BY LOWER(COALESCE(v.volunteer_email,v.volunteer_name)) ORDER BY knownHours DESC,name LIMIT 250`,rf.binds).all<any>();

  const programs=await stmt(env,`
    WITH ${EFFECTIVE_CTE},
    distinct_cm AS (SELECT DISTINCT email, program FROM effective_cm),
    counts AS (SELECT email,COUNT(*) program_count FROM distinct_cm GROUP BY email),
    eligible AS (SELECT d.program,SUM(1.0/c.program_count) eligible_credits FROM distinct_cm d JOIN counts c ON c.email=d.email GROUP BY d.program),
    vh AS (
      SELECT LOWER(v.volunteer_email) email,
        SUM(CASE WHEN v.hours_known=1 THEN v.hours*v.quantity ELSE 0 END) known_hours,
        SUM(CASE WHEN v.hours_known=0 THEN v.quantity ELSE 0 END) tbd_assignments
      FROM volunteer_slots v WHERE v.status='filled' AND v.volunteer_email IS NOT NULL${rf.sql}
      GROUP BY LOWER(v.volunteer_email)
    ),
    active AS (SELECT DISTINCT email FROM vh),
    participation AS (
      SELECT d.program,SUM(CASE WHEN a.email IS NOT NULL THEN 1.0/c.program_count ELSE 0 END) participating_credits
      FROM distinct_cm d JOIN counts c ON c.email=d.email LEFT JOIN active a ON a.email=d.email GROUP BY d.program
    ),
    support AS (
      SELECT d.program,
        SUM(CASE WHEN v.hours_known=1 THEN (v.hours*v.quantity)/c.program_count ELSE 0 END) total_hours,
        SUM(CASE WHEN v.hours_known=1 AND (e.affiliation='Booster-Wide' OR (e.affiliation IS NOT NULL AND TRIM(e.affiliation)<>'' AND e.affiliation<>d.program)) THEN (v.hours*v.quantity)/c.program_count ELSE 0 END) cross_hours,
        SUM(CASE WHEN v.hours_known=1 AND (e.affiliation IS NULL OR TRIM(e.affiliation)='') THEN (v.hours*v.quantity)/c.program_count ELSE 0 END) unclassified_hours
      FROM volunteer_slots v
      JOIN events e ON e.id=v.event_id
      JOIN distinct_cm d ON d.email=LOWER(v.volunteer_email)
      JOIN counts c ON c.email=d.email
      WHERE v.status='filled' AND v.volunteer_email IS NOT NULL${rf.sql}
      GROUP BY d.program
    )
    SELECT d.program name,
      COUNT(DISTINCT d.email) volunteers,
      COALESCE(SUM(CASE WHEN vh.email IS NOT NULL THEN 1.0/counts.program_count ELSE 0 END),0) volunteerCredits,
      COALESCE(SUM(vh.known_hours/counts.program_count),0) knownHours,
      COALESCE(SUM(vh.tbd_assignments*1.0/counts.program_count),0) tbdAssignments,
      COALESCE(el.eligible_credits,0) eligibleCredits,
      COALESCE(pa.participating_credits,0) participatingCredits,
      CASE WHEN COALESCE(el.eligible_credits,0)>0 THEN COALESCE(pa.participating_credits,0)*100.0/el.eligible_credits ELSE 0 END participationRate,
      COALESCE(su.cross_hours,0) crossSupportHours,
      CASE WHEN COALESCE(su.total_hours,0)>0 THEN COALESCE(su.cross_hours,0)*100.0/su.total_hours ELSE 0 END crossSupportRate,
      COALESCE(su.unclassified_hours,0) unclassifiedHours
    FROM distinct_cm d JOIN counts ON counts.email=d.email LEFT JOIN vh ON vh.email=d.email
    LEFT JOIN eligible el ON el.program=d.program LEFT JOIN participation pa ON pa.program=d.program LEFT JOIN support su ON su.program=d.program
    GROUP BY d.program ORDER BY knownHours DESC,name`,rf.binds).all<any>();

  const match=await stmt(env,`
    WITH ${EFFECTIVE_CTE}, cm AS (SELECT email,COUNT(DISTINCT program) pc FROM effective_cm GROUP BY email),
    vset AS (SELECT DISTINCT LOWER(v.volunteer_email) email FROM volunteer_slots v WHERE v.status='filled' AND v.volunteer_email IS NOT NULL${rf.sql})
    SELECT COUNT(*) total,COALESCE(SUM(CASE WHEN cm.pc>=1 THEN 1 ELSE 0 END),0) matched,COALESCE(SUM(CASE WHEN cm.pc>1 THEN 1 ELSE 0 END),0) ambiguous,COALESCE(SUM(CASE WHEN cm.pc IS NULL THEN 1 ELSE 0 END),0) unmatched FROM vset LEFT JOIN cm ON cm.email=vset.email`,rf.binds).first<any>();

  const contacts=await env.DB.prepare("SELECT COUNT(*) mappings,COUNT(DISTINCT LOWER(email)) uniqueEmails FROM contact_mappings").first<any>();
  const overrides=await env.DB.prepare("SELECT COUNT(DISTINCT LOWER(email)) emails,COUNT(*) mappings FROM volunteer_program_overrides").first<any>();
  const unmatched=await stmt(env,`
    WITH ${EFFECTIVE_CTE}, cm AS (SELECT email,COUNT(DISTINCT program) pc,GROUP_CONCAT(DISTINCT program) programs FROM effective_cm GROUP BY email)
    SELECT COALESCE(NULLIF(v.volunteer_name,''),v.volunteer_email,'Unknown') name,v.volunteer_email email,COALESCE(cm.programs,'') programs,COALESCE(cm.pc,0) programCount,SUM(CASE WHEN v.hours_known=1 THEN v.hours*v.quantity ELSE 0 END) knownHours,SUM(CASE WHEN v.hours_known=0 THEN v.quantity ELSE 0 END) tbdAssignments
    FROM volunteer_slots v LEFT JOIN cm ON LOWER(v.volunteer_email)=cm.email WHERE v.status='filled' AND cm.pc IS NULL${rf.sql}
    GROUP BY LOWER(COALESCE(v.volunteer_email,v.volunteer_name)) ORDER BY knownHours DESC,name LIMIT 100`,rf.binds).all<any>();

  const availablePrograms=await env.DB.prepare("SELECT program name FROM (SELECT DISTINCT program FROM contact_mappings UNION SELECT DISTINCT program FROM volunteer_program_overrides) WHERE program IS NOT NULL AND TRIM(program)<>'' ORDER BY name").all<any>();
  const classified=await stmt(env,`SELECT COALESCE(SUM(CASE WHEN e.affiliation IS NOT NULL AND TRIM(e.affiliation)<>'' THEN CASE WHEN v.hours_known=1 THEN v.hours*v.quantity ELSE 0 END ELSE 0 END),0) classifiedHours,COALESCE(SUM(CASE WHEN v.hours_known=1 THEN v.hours*v.quantity ELSE 0 END),0) totalHours FROM volunteer_slots v JOIN events e ON e.id=v.event_id WHERE v.status='filled'${rf.sql}`,rf.binds).first<any>();

  return {range:{startDate:range.startDate||null,endDate:range.endDate||null},settings:cfg,summary:{hoursNeeded:needed,hoursFilled:filled,hoursRemaining:Math.max(0,needed-filled),knownHoursNeeded:knownNeeded,knownHoursFilled:knownFilled,estimatedHoursNeeded:Number(s?.tbdNeededQty||0)*est,estimatedHoursFilled:Number(s?.tbdFilledQty||0)*est,fillRate:needed?filled/needed*100:0,activeEvents:e.results.length,totalAssignments:Number(s?.totalAssignments||0),openSlots:Number(s?.openSlots||0),assignedSlots:Number(s?.assignedSlots||0),tbdAssignments:Number(s?.tbdAssignments||0),lastSyncAt:l?.syncTime||null,lastSyncStatus:l?.status||null,contactSyncAt:cl?.syncTime||null,contactSyncStatus:cl?.status||null,contactMappings:Number(contacts?.mappings||0),uniqueContactEmails:Number(contacts?.uniqueEmails||0),manualOverrideEmails:Number(overrides?.emails||0),manualOverrideMappings:Number(overrides?.mappings||0),matchedVolunteers:Number(match?.matched||0),ambiguousVolunteers:Number(match?.ambiguous||0),unmatchedVolunteers:Number(match?.unmatched||0),volunteerEmails:Number(match?.total||0),classifiedHours:Number(classified?.classifiedHours||0),classificationRate:Number(classified?.totalHours||0)?Number(classified?.classifiedHours||0)*100/Number(classified?.totalHours||0):0},programs:(programs.results||[]).map((x:any)=>Object.fromEntries(Object.entries(x).map(([k,v])=>[k,typeof v==='number'?v:(['knownHours','tbdAssignments','volunteers','volunteerCredits','eligibleCredits','participatingCredits','participationRate','crossSupportHours','crossSupportRate','unclassifiedHours'].includes(k)?Number(v||0):v)]))),events:(e.results||[]).map((x:any)=>({...x,eventDate:x.eventDate||(x.firstEpoch?new Date(Number(x.firstEpoch)*1000).toISOString():null),hoursNeeded:Number(x.knownNeeded||0)+Number(x.tbdQty||0)*est,hoursFilled:Number(x.knownFilled||0)+Number(x.tbdFilledQty||0)*est})),volunteers:volunteers.results,unmatched:unmatched.results,availablePrograms:(availablePrograms.results||[]).map((x:any)=>x.name)};
}
