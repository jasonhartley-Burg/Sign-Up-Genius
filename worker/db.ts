import type { Env } from "./types";

export type DashboardRange = { startEpoch?: number; endEpochExclusive?: number; startDate?: string; endDate?: string; asOfDate?: string };

export async function getSettings(env:Env){
  const rows=await env.DB.prepare("SELECT key,value FROM settings").all<any>();
  const m=new Map((rows.results||[]).map((x:any)=>[x.key,x.value]));
  return{estimateUntimedEnabled:m.get("estimate_untimed_enabled")==="1",estimateUntimedHours:Number(m.get("estimate_untimed_hours")||6)};
}

const SLOT_EPOCH=(alias:string)=>`COALESCE(CAST(json_extract(${alias}.raw_json,'$.startdate') AS INTEGER),CASE WHEN ${alias}.slot_date GLOB '[0-9][0-9][0-9][0-9]-*' THEN CAST(strftime('%s',${alias}.slot_date) AS INTEGER) WHEN ${alias}.slot_date GLOB '[0-9]*' THEN CAST(${alias}.slot_date AS INTEGER) END,0)`;
const SLOT_DAY=(alias:string)=>`COALESCE(date(CAST(json_extract(${alias}.raw_json,'$.startdate') AS INTEGER),'unixepoch'),date(${alias}.slot_date))`;
function slotRange(alias:string, range:DashboardRange){
  const parts:string[]=[]; const binds:number[]=[]; const epoch=SLOT_EPOCH(alias);
  if(range.startEpoch){parts.push(`${epoch}>=?`);binds.push(range.startEpoch)}
  if(range.endEpochExclusive){parts.push(`${epoch}<?`);binds.push(range.endEpochExclusive)}
  return{sql:parts.length?` AND ${parts.join(" AND ")}`:"",binds};
}
function stmt(env:Env,sql:string,binds:any[]){const q=env.DB.prepare(sql);return binds.length?q.bind(...binds):q}

const CURRENT_CTE=`
  override_emails AS (SELECT DISTINCT LOWER(email) email FROM volunteer_program_overrides),
  current_cm AS (
    SELECT LOWER(email) email, program, 'manual' source FROM volunteer_program_overrides
    UNION ALL
    SELECT LOWER(c.email) email, c.program, 'roster' source FROM contact_mappings c
    WHERE LOWER(c.email) NOT IN (SELECT email FROM override_emails)
  ),
  history_emails AS (SELECT DISTINCT LOWER(email) email FROM volunteer_affiliation_history),
  affiliation_rows AS (
    SELECT LOWER(email) email, program, effective_from, effective_to, 'history' source FROM volunteer_affiliation_history
    UNION ALL
    SELECT c.email,c.program,NULL effective_from,NULL effective_to,c.source FROM current_cm c
    WHERE c.email NOT IN (SELECT email FROM history_emails)
  )`;

export async function dashboard(env:Env, range:DashboardRange={}){
  const cfg=await getSettings(env), est=cfg.estimateUntimedEnabled?cfg.estimateUntimedHours:0;
  const rf=slotRange("v",range), asOf=range.asOfDate||range.endDate||new Date().toISOString().slice(0,10);
  const s=await stmt(env,`SELECT
    COALESCE(SUM(CASE WHEN COALESCE(json_extract(v.raw_json,'$.source'),'')<>'manual' THEN quantity ELSE 0 END),0) totalAssignments,
    COALESCE(SUM(CASE WHEN COALESCE(json_extract(v.raw_json,'$.source'),'')<>'manual' AND status='open' THEN quantity ELSE 0 END),0) openSlots,
    COALESCE(SUM(CASE WHEN COALESCE(json_extract(v.raw_json,'$.source'),'')<>'manual' AND status='filled' THEN quantity ELSE 0 END),0) assignedSlots,
    COALESCE(SUM(CASE WHEN COALESCE(json_extract(v.raw_json,'$.source'),'')<>'manual' AND hours_known=0 THEN quantity ELSE 0 END),0) tbdAssignments,
    COALESCE(SUM(CASE WHEN COALESCE(json_extract(v.raw_json,'$.source'),'')<>'manual' AND hours_known=1 THEN hours*quantity ELSE 0 END),0) knownNeeded,
    COALESCE(SUM(CASE WHEN COALESCE(json_extract(v.raw_json,'$.source'),'')<>'manual' AND status='filled' AND hours_known=1 THEN hours*quantity ELSE 0 END),0) knownFilled,
    COALESCE(SUM(CASE WHEN COALESCE(json_extract(v.raw_json,'$.source'),'')='manual' AND status='filled' AND hours_known=1 THEN hours*quantity ELSE 0 END),0) manualFilled,
    COALESCE(SUM(CASE WHEN COALESCE(json_extract(v.raw_json,'$.source'),'')<>'manual' AND hours_known=0 THEN quantity ELSE 0 END),0) tbdNeededQty,
    COALESCE(SUM(CASE WHEN COALESCE(json_extract(v.raw_json,'$.source'),'')<>'manual' AND status='filled' AND hours_known=0 THEN quantity ELSE 0 END),0) tbdFilledQty
    FROM volunteer_slots v WHERE 1=1${rf.sql}`,rf.binds).first<any>();
  const knownNeeded=Number(s?.knownNeeded||0),knownFilled=Number(s?.knownFilled||0),manualFilled=Number(s?.manualFilled||0),needed=knownNeeded+Number(s?.tbdNeededQty||0)*est,filled=knownFilled+Number(s?.tbdFilledQty||0)*est;

  const e=await stmt(env,`SELECT e.id,e.signupgenius_id signupgeniusId,e.title,e.event_date eventDate,e.location,COALESCE(SUM(CASE WHEN v.hours_known=1 THEN v.hours*v.quantity ELSE 0 END),0) knownNeeded,COALESCE(SUM(CASE WHEN v.status='filled' AND v.hours_known=1 THEN v.hours*v.quantity ELSE 0 END),0) knownFilled,COALESCE(SUM(CASE WHEN v.hours_known=0 THEN v.quantity ELSE 0 END),0) tbdQty,COALESCE(SUM(CASE WHEN v.status='filled' AND v.hours_known=0 THEN v.quantity ELSE 0 END),0) tbdFilledQty,COALESCE(SUM(CASE WHEN v.status='open' THEN v.quantity ELSE 0 END),0) openSlots,COALESCE(SUM(CASE WHEN v.status='filled' THEN v.quantity ELSE 0 END),0) assignedSlots,MIN(${SLOT_EPOCH("v")}) firstEpoch FROM events e JOIN volunteer_slots v ON v.event_id=e.id WHERE COALESCE(json_extract(v.raw_json,'$.source'),'')<>'manual'${rf.sql} GROUP BY e.id ORDER BY firstEpoch,e.event_date`,rf.binds).all<any>();
  const l=await env.DB.prepare("SELECT sync_time syncTime,status FROM sync_log ORDER BY id DESC LIMIT 1").first<any>();
  const cl=await env.DB.prepare("SELECT sync_time syncTime,status,message FROM contact_sync_log ORDER BY id DESC LIMIT 1").first<any>();

  const volunteers=await stmt(env,`
    WITH ${CURRENT_CTE},
    slot_base AS (
      SELECT v.*,LOWER(v.volunteer_email) email_key,${SLOT_DAY("v")} slot_day
      FROM volunteer_slots v WHERE v.status='filled'${rf.sql}
    ),
    slot_programs AS (
      SELECT sb.id slot_id,sb.email_key,a.program
      FROM slot_base sb JOIN affiliation_rows a ON a.email=sb.email_key
      WHERE (a.effective_from IS NULL OR sb.slot_day>=a.effective_from) AND (a.effective_to IS NULL OR sb.slot_day<=a.effective_to)
      GROUP BY sb.id,a.program
    ),
    slot_counts AS (SELECT slot_id,COUNT(*) pc FROM slot_programs GROUP BY slot_id),
    alloc AS (
      SELECT sb.email_key,sp.program,
        SUM(CASE WHEN sb.hours_known=1 THEN sb.hours*sb.quantity*1.0/sc.pc ELSE 0 END) credited_hours
      FROM slot_base sb JOIN slot_programs sp ON sp.slot_id=sb.id JOIN slot_counts sc ON sc.slot_id=sb.id
      GROUP BY sb.email_key,sp.program
    ),
    alloc_roll AS (
      SELECT email_key,GROUP_CONCAT(program) programs,COUNT(*) program_count,
        GROUP_CONCAT(program||'|'||printf('%.6f',credited_hours),';;') allocation
      FROM alloc GROUP BY email_key
    )
    SELECT COALESCE(NULLIF(MAX(sb.volunteer_name),''),MAX(sb.volunteer_email),'Unknown') name,MAX(sb.volunteer_email) email,
      COALESCE(SUM(CASE WHEN sb.hours_known=1 THEN sb.hours*sb.quantity ELSE 0 END),0) knownHours,
      COALESCE(SUM(CASE WHEN sb.hours_known=0 THEN sb.quantity ELSE 0 END),0) tbdAssignments,
      COALESCE(SUM(sb.quantity),0) assignments,
      COALESCE(ar.programs,'Unmatched') attribution,COALESCE(ar.program_count,0) programCount,
      COALESCE(ar.allocation,'') allocation,
      CASE WHEN EXISTS(SELECT 1 FROM volunteer_program_overrides o WHERE LOWER(o.email)=sb.email_key) THEN 1 ELSE 0 END manualOverride,
      CASE WHEN EXISTS(SELECT 1 FROM history_emails h WHERE h.email=sb.email_key) THEN 1 ELSE 0 END datedAffiliation
    FROM slot_base sb LEFT JOIN alloc_roll ar ON ar.email_key=sb.email_key
    GROUP BY sb.email_key ORDER BY knownHours DESC,name LIMIT 250`,rf.binds).all<any>();

  const programs=await stmt(env,`
    WITH ${CURRENT_CTE},
    slot_base AS (
      SELECT v.*,LOWER(v.volunteer_email) email_key,${SLOT_DAY("v")} slot_day
      FROM volunteer_slots v WHERE v.status='filled' AND v.volunteer_email IS NOT NULL${rf.sql}
    ),
    slot_programs AS (
      SELECT sb.id slot_id,sb.email_key,a.program
      FROM slot_base sb JOIN affiliation_rows a ON a.email=sb.email_key
      WHERE (a.effective_from IS NULL OR sb.slot_day>=a.effective_from) AND (a.effective_to IS NULL OR sb.slot_day<=a.effective_to)
      GROUP BY sb.id,a.program
    ),
    slot_counts AS (SELECT slot_id,COUNT(*) pc FROM slot_programs GROUP BY slot_id),
    allocated AS (
      SELECT sp.program,sb.email_key,
        SUM(CASE WHEN sb.hours_known=1 THEN sb.hours*sb.quantity*1.0/sc.pc ELSE 0 END) known_hours,
        SUM(CASE WHEN sb.hours_known=0 THEN sb.quantity*1.0/sc.pc ELSE 0 END) tbd_assignments,
        MAX(1.0/sc.pc) volunteer_credit
      FROM slot_base sb JOIN slot_programs sp ON sp.slot_id=sb.id JOIN slot_counts sc ON sc.slot_id=sb.id
      GROUP BY sp.program,sb.email_key
    ),
    asof_links AS (
      SELECT a.email,a.program FROM affiliation_rows a
      WHERE (a.effective_from IS NULL OR a.effective_from<=?) AND (a.effective_to IS NULL OR a.effective_to>=?)
      GROUP BY a.email,a.program
    ),
    asof_counts AS (SELECT email,COUNT(*) pc FROM asof_links GROUP BY email),
    eligible AS (SELECT l.program,SUM(1.0/c.pc) eligible_credits FROM asof_links l JOIN asof_counts c ON c.email=l.email GROUP BY l.program),
    participants AS (
      SELECT l.program,SUM(CASE WHEN x.email_key IS NOT NULL THEN 1.0/c.pc ELSE 0 END) participating_credits
      FROM asof_links l JOIN asof_counts c ON c.email=l.email
      LEFT JOIN (SELECT DISTINCT email_key,program FROM allocated) x ON x.email_key=l.email AND x.program=l.program
      GROUP BY l.program
    ),
    names AS (SELECT DISTINCT program FROM affiliation_rows)
    SELECT n.program name,
      COALESCE((SELECT COUNT(DISTINCT a.email_key) FROM allocated a WHERE a.program=n.program),0) volunteers,
      COALESCE((SELECT SUM(a.volunteer_credit) FROM allocated a WHERE a.program=n.program),0) volunteerCredits,
      COALESCE((SELECT SUM(a.known_hours) FROM allocated a WHERE a.program=n.program),0) knownHours,
      COALESCE((SELECT SUM(a.tbd_assignments) FROM allocated a WHERE a.program=n.program),0) tbdAssignments,
      COALESCE(el.eligible_credits,0) eligibleCredits,COALESCE(pa.participating_credits,0) participatingCredits,
      CASE WHEN COALESCE(el.eligible_credits,0)>0 THEN COALESCE(pa.participating_credits,0)*100.0/el.eligible_credits ELSE 0 END participationRate
    FROM names n LEFT JOIN eligible el ON el.program=n.program LEFT JOIN participants pa ON pa.program=n.program
    ORDER BY knownHours DESC,name`,[...rf.binds,asOf,asOf]).all<any>();

  const match=await stmt(env,`
    WITH ${CURRENT_CTE},slot_base AS (SELECT v.id,LOWER(v.volunteer_email) email_key,${SLOT_DAY("v")} slot_day FROM volunteer_slots v WHERE v.status='filled' AND v.volunteer_email IS NOT NULL${rf.sql}),
    matches AS (SELECT sb.email_key,COUNT(DISTINCT a.program) pc FROM slot_base sb LEFT JOIN affiliation_rows a ON a.email=sb.email_key AND (a.effective_from IS NULL OR sb.slot_day>=a.effective_from) AND (a.effective_to IS NULL OR sb.slot_day<=a.effective_to) GROUP BY sb.email_key)
    SELECT COUNT(*) total,COALESCE(SUM(CASE WHEN pc>=1 THEN 1 ELSE 0 END),0) matched,COALESCE(SUM(CASE WHEN pc>1 THEN 1 ELSE 0 END),0) ambiguous,COALESCE(SUM(CASE WHEN pc=0 THEN 1 ELSE 0 END),0) unmatched FROM matches`,rf.binds).first<any>();

  const contacts=await env.DB.prepare("SELECT COUNT(*) mappings,COUNT(DISTINCT LOWER(email)) uniqueEmails FROM contact_mappings").first<any>();
  const overrides=await env.DB.prepare("SELECT COUNT(DISTINCT LOWER(email)) emails,COUNT(*) mappings FROM volunteer_program_overrides").first<any>();
  const history=await env.DB.prepare("SELECT COUNT(DISTINCT LOWER(email)) emails,COUNT(*) mappings FROM volunteer_affiliation_history").first<any>();
  const unmatched=await stmt(env,`
    WITH ${CURRENT_CTE},slot_base AS (SELECT v.*,LOWER(v.volunteer_email) email_key,${SLOT_DAY("v")} slot_day FROM volunteer_slots v WHERE v.status='filled'${rf.sql}),
    has_program AS (SELECT DISTINCT sb.id FROM slot_base sb JOIN affiliation_rows a ON a.email=sb.email_key WHERE (a.effective_from IS NULL OR sb.slot_day>=a.effective_from) AND (a.effective_to IS NULL OR sb.slot_day<=a.effective_to))
    SELECT COALESCE(NULLIF(MAX(sb.volunteer_name),''),MAX(sb.volunteer_email),'Unknown') name,MAX(sb.volunteer_email) email,SUM(CASE WHEN sb.hours_known=1 THEN sb.hours*sb.quantity ELSE 0 END) knownHours,SUM(CASE WHEN sb.hours_known=0 THEN sb.quantity ELSE 0 END) tbdAssignments
    FROM slot_base sb WHERE sb.id NOT IN (SELECT id FROM has_program)
    GROUP BY sb.email_key ORDER BY knownHours DESC,name LIMIT 100`,rf.binds).all<any>();

  const availablePrograms=await env.DB.prepare("SELECT program name FROM (SELECT DISTINCT program FROM contact_mappings UNION SELECT DISTINCT program FROM volunteer_program_overrides UNION SELECT DISTINCT program FROM volunteer_affiliation_history) WHERE program IS NOT NULL AND TRIM(program)<>'' ORDER BY name").all<any>();
  return {range:{startDate:range.startDate||null,endDate:range.endDate||null,resolvedEndDate:range.asOfDate||range.endDate||null},settings:cfg,summary:{volunteerHoursContributed:filled+manualFilled,hoursNeeded:needed,hoursFilled:filled,hoursRemaining:Math.max(0,needed-filled),knownHoursNeeded:knownNeeded,knownHoursFilled:knownFilled,estimatedHoursNeeded:Number(s?.tbdNeededQty||0)*est,estimatedHoursFilled:Number(s?.tbdFilledQty||0)*est,fillRate:needed?filled/needed*100:0,activeEvents:e.results.length,totalAssignments:Number(s?.totalAssignments||0),openSlots:Number(s?.openSlots||0),assignedSlots:Number(s?.assignedSlots||0),tbdAssignments:Number(s?.tbdAssignments||0),lastSyncAt:l?.syncTime||null,lastSyncStatus:l?.status||null,contactSyncAt:cl?.syncTime||null,contactSyncStatus:cl?.status||null,contactMappings:Number(contacts?.mappings||0),uniqueContactEmails:Number(contacts?.uniqueEmails||0),manualOverrideEmails:Number(overrides?.emails||0),manualOverrideMappings:Number(overrides?.mappings||0),datedAffiliationEmails:Number(history?.emails||0),datedAffiliationMappings:Number(history?.mappings||0),matchedVolunteers:Number(match?.matched||0),ambiguousVolunteers:Number(match?.ambiguous||0),unmatchedVolunteers:Number(match?.unmatched||0),volunteerEmails:Number(match?.total||0)},programs:(programs.results||[]).map((x:any)=>Object.fromEntries(Object.entries(x).map(([k,v])=>[k,typeof v==='number'?v:(['knownHours','tbdAssignments','volunteers','volunteerCredits','eligibleCredits','participatingCredits','participationRate'].includes(k)?Number(v||0):v)]))),events:(e.results||[]).map((x:any)=>({...x,eventDate:x.eventDate||(x.firstEpoch?new Date(Number(x.firstEpoch)*1000).toISOString():null),hoursNeeded:Number(x.knownNeeded||0)+Number(x.tbdQty||0)*est,hoursFilled:Number(x.knownFilled||0)+Number(x.tbdFilledQty||0)*est})),volunteers:volunteers.results,unmatched:unmatched.results,availablePrograms:(availablePrograms.results||[]).map((x:any)=>x.name)};
}
