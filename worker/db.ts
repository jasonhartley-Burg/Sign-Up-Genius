import type { Env } from "./types";

export type DashboardRange = { startEpoch?: number; endEpochExclusive?: number; startDate?: string; endDate?: string; asOfDate?: string };

export async function getSettings(env: Env) {
  const rows = await env.DB.prepare("SELECT key,value FROM settings WHERE key IN ('estimate_untimed_enabled','estimate_untimed_hours')").all<any>();
  const m = new Map((rows.results || []).map((x: any) => [x.key, x.value]));
  return { estimateUntimedEnabled: m.get("estimate_untimed_enabled") === "1", estimateUntimedHours: Number(m.get("estimate_untimed_hours") || 6) };
}

/**
 * v0.6.0: slot start time, slot day and the manual/SignUpGenius source are now
 * indexed columns. The previous build derived all three with json_extract() over
 * raw_json inside every WHERE clause, so SQLite had to scan and JSON-parse the
 * whole volunteer_slots table once per sub-query — around ten times per dashboard
 * load. That was the single largest consumer of the D1 rows-read budget.
 */
const EPOCH = (alias: string) => `${alias}.start_epoch`;

function slotRange(alias: string, range: DashboardRange) {
  const parts: string[] = []; const binds: number[] = [];
  if (range.startEpoch) { parts.push(`${EPOCH(alias)}>=?`); binds.push(range.startEpoch); }
  if (range.endEpochExclusive) { parts.push(`${EPOCH(alias)}<?`); binds.push(range.endEpochExclusive); }
  return { sql: parts.length ? ` AND ${parts.join(" AND ")}` : "", binds };
}

function stmt(env: Env, sql: string, binds: any[]) { const q = env.DB.prepare(sql); return binds.length ? q.bind(...binds) : q; }

export async function dashboard(env: Env, range: DashboardRange = {}) {
  const cfg = await getSettings(env), est = cfg.estimateUntimedEnabled ? cfg.estimateUntimedHours : 0;
  const rf = slotRange("v", range), asOf = range.asOfDate || range.endDate || new Date().toISOString().slice(0, 10);

  const s = await stmt(env, `SELECT
    COALESCE(SUM(CASE WHEN v.source<>'manual' THEN quantity ELSE 0 END),0) totalAssignments,
    COALESCE(SUM(CASE WHEN v.source<>'manual' AND status='open' THEN quantity ELSE 0 END),0) openSlots,
    COALESCE(SUM(CASE WHEN v.source<>'manual' AND status='filled' THEN quantity ELSE 0 END),0) assignedSlots,
    COALESCE(SUM(CASE WHEN v.source<>'manual' AND hours_known=0 THEN quantity ELSE 0 END),0) tbdAssignments,
    COALESCE(SUM(CASE WHEN v.source<>'manual' AND hours_known=1 THEN hours*quantity ELSE 0 END),0) knownNeeded,
    COALESCE(SUM(CASE WHEN v.source<>'manual' AND status='filled' AND hours_known=1 THEN hours*quantity ELSE 0 END),0) knownFilled,
    COALESCE(SUM(CASE WHEN v.source='manual' AND status='filled' AND hours_known=1 THEN hours*quantity ELSE 0 END),0) manualFilled,
    COALESCE(SUM(CASE WHEN v.source<>'manual' AND hours_known=0 THEN quantity ELSE 0 END),0) tbdNeededQty,
    COALESCE(SUM(CASE WHEN v.source<>'manual' AND status='filled' AND hours_known=0 THEN quantity ELSE 0 END),0) tbdFilledQty
    FROM volunteer_slots v WHERE 1=1${rf.sql}`, rf.binds).first<any>();

  const knownNeeded = Number(s?.knownNeeded || 0), knownFilled = Number(s?.knownFilled || 0), manualFilled = Number(s?.manualFilled || 0);
  const needed = knownNeeded + Number(s?.tbdNeededQty || 0) * est, filled = knownFilled + Number(s?.tbdFilledQty || 0) * est;

  const e = await stmt(env, `SELECT e.id,e.signupgenius_id signupgeniusId,e.title,e.event_date eventDate,e.location,
    COALESCE(SUM(CASE WHEN v.hours_known=1 THEN v.hours*v.quantity ELSE 0 END),0) knownNeeded,
    COALESCE(SUM(CASE WHEN v.status='filled' AND v.hours_known=1 THEN v.hours*v.quantity ELSE 0 END),0) knownFilled,
    COALESCE(SUM(CASE WHEN v.hours_known=0 THEN v.quantity ELSE 0 END),0) tbdQty,
    COALESCE(SUM(CASE WHEN v.status='filled' AND v.hours_known=0 THEN v.quantity ELSE 0 END),0) tbdFilledQty,
    COALESCE(SUM(CASE WHEN v.status='open' THEN v.quantity ELSE 0 END),0) openSlots,
    COALESCE(SUM(CASE WHEN v.status='filled' THEN v.quantity ELSE 0 END),0) assignedSlots,
    MIN(${EPOCH("v")}) firstEpoch
    FROM events e JOIN volunteer_slots v ON v.event_id=e.id
    WHERE v.source<>'manual'${rf.sql} GROUP BY e.id ORDER BY firstEpoch,e.event_date`, rf.binds).all<any>();

  // Both "last sync" lookups folded into a single round trip.
  const logs = await env.DB.prepare(`SELECT
    (SELECT sync_time FROM sync_log ORDER BY id DESC LIMIT 1) syncTime,
    (SELECT status FROM sync_log ORDER BY id DESC LIMIT 1) syncStatus,
    (SELECT sync_time FROM contact_sync_log ORDER BY id DESC LIMIT 1) contactSyncTime,
    (SELECT status FROM contact_sync_log ORDER BY id DESC LIMIT 1) contactSyncStatus`).first<any>();

  // Resolve affiliations and allocations in application code. This avoids SQLite's
  // parser limit on nested views/CTEs while preserving historical and override rules.
  const [overrideResult, mappingResult, historyResult] = await Promise.all([
    env.DB.prepare("SELECT LOWER(email) email,program FROM volunteer_program_overrides").all<any>(),
    env.DB.prepare("SELECT LOWER(email) email,program FROM contact_mappings").all<any>(),
    env.DB.prepare("SELECT LOWER(email) email,program,effective_from,effective_to FROM volunteer_affiliation_history").all<any>()
  ]);
  const overrides = overrideResult.results || [], mappings = mappingResult.results || [], history = historyResult.results || [];
  const overrideEmails = new Set(overrides.map(x => x.email));
  const historyEmails = new Set(history.map(x => x.email));
  const affiliations = [
    ...history,
    ...overrides.filter(x => !historyEmails.has(x.email)).map(x => ({ ...x, effective_from: null, effective_to: null })),
    ...mappings.filter(x => !overrideEmails.has(x.email) && !historyEmails.has(x.email)).map(x => ({ ...x, effective_from: null, effective_to: null }))
  ];
  const byEmail = new Map<string, any[]>();
  for (const row of affiliations) {
    const list = byEmail.get(row.email) || []; list.push(row); byEmail.set(row.email, list);
  }
  // Pagination bounds the size of individual D1 results, including on large rosters.
  const slots: any[] = [];
  let lastId = 0;
  for (;;) {
    const page = await stmt(env, `SELECT v.id,v.volunteer_name,v.volunteer_email,v.hours,v.quantity,v.hours_known,v.slot_day
      FROM volunteer_slots v WHERE v.status='filled' AND v.id>?${rf.sql} ORDER BY v.id LIMIT 500`, [lastId, ...rf.binds]).all<any>();
    const rows = page.results || [];
    slots.push(...rows);
    if (rows.length < 500) break;
    lastId = rows[rows.length - 1].id;
  }
  const volunteerMap = new Map<string, any>();
  const programMap = new Map<string, any>();
  const allocatedEmails = new Map<string, Set<string>>();
  const unmatchedMap = new Map<string, any>();
  const matchedEmails = new Map<string, Set<string>>();
  const getProgram = (name: string) => {
    let p = programMap.get(name);
    if (!p) { p = { name, volunteers: 0, volunteerCredits: 0, knownHours: 0, tbdAssignments: 0, eligibleCredits: 0, participatingCredits: 0, participationRate: 0 }; programMap.set(name, p); }
    return p;
  };
  for (const row of affiliations) if (row.program) getProgram(row.program);
  for (const slot of slots) {
    const email = String(slot.volunteer_email || '').toLowerCase();
    const day = slot.slot_day;
    const programsForSlot = [...new Set((byEmail.get(email) || [])
      .filter(a => (a.effective_from == null || day >= a.effective_from) && (a.effective_to == null || day <= a.effective_to))
      .map(a => a.program))];
    const known = Number(slot.hours_known) === 1 ? Number(slot.hours || 0) * Number(slot.quantity || 0) : 0;
    const tbd = Number(slot.hours_known) === 0 ? Number(slot.quantity || 0) : 0;
    let v = volunteerMap.get(email);
    if (!v) {
      v = { name: '', email: '', knownHours: 0, tbdAssignments: 0, assignments: 0, attribution: 'Unmatched', programCount: 0, allocation: '', manualOverride: overrideEmails.has(email) ? 1 : 0, datedAffiliation: historyEmails.has(email) ? 1 : 0, allocations: new Map<string, number>() };
      volunteerMap.set(email, v);
    }
    if (slot.volunteer_name && (!v.name || slot.volunteer_name > v.name)) v.name = slot.volunteer_name;
    if (slot.volunteer_email && (!v.email || slot.volunteer_email > v.email)) v.email = slot.volunteer_email;
    v.knownHours += known; v.tbdAssignments += tbd; v.assignments += Number(slot.quantity || 0);
    if (!matchedEmails.has(email)) matchedEmails.set(email, new Set());
    for (const program of programsForSlot) matchedEmails.get(email)!.add(program);
    if (!programsForSlot.length) {
      let u = unmatchedMap.get(email);
      if (!u) { u = { name: '', email: '', knownHours: 0, tbdAssignments: 0 }; unmatchedMap.set(email, u); }
      if (slot.volunteer_name && (!u.name || slot.volunteer_name > u.name)) u.name = slot.volunteer_name;
      if (slot.volunteer_email && (!u.email || slot.volunteer_email > u.email)) u.email = slot.volunteer_email;
      u.knownHours += known; u.tbdAssignments += tbd;
    }
    for (const program of programsForSlot) {
      const p = getProgram(program), credit = 1 / programsForSlot.length;
      p.knownHours += known * credit; p.tbdAssignments += tbd * credit;
      v.allocations.set(program, (v.allocations.get(program) || 0) + known * credit);
      const key = `${email}\u0000${program}`;
      if (!allocatedEmails.has(key)) { allocatedEmails.set(key, new Set([email])); p.volunteers += 1; p.volunteerCredits += credit; }
      // The legacy SQL uses MAX(1 / per-slot program count) for volunteer credit.
      const creditKey = `${email}\u0000${program}`;
      const credits = (p as any)._credits || ((p as any)._credits = new Map<string, number>());
      credits.set(creditKey, Math.max(credits.get(creditKey) || 0, credit));
    }
  }
  for (const p of programMap.values()) {
    const credits: Map<string, number> = p._credits || new Map();
    p.volunteerCredits = [...credits.values()].reduce((a, b) => a + b, 0);
    delete p._credits;
  }
  const eligibleByEmail = new Map<string, Set<string>>();
  for (const a of affiliations) {
    if (!a.program || (a.effective_from != null && a.effective_from > asOf) || (a.effective_to != null && a.effective_to < asOf)) continue;
    const set = eligibleByEmail.get(a.email) || new Set<string>(); set.add(a.program); eligibleByEmail.set(a.email, set);
  }
  for (const [email, names] of eligibleByEmail) for (const name of names) {
    const p = getProgram(name), credit = 1 / names.size;
    p.eligibleCredits += credit;
    if (allocatedEmails.has(`${email}\u0000${name}`)) p.participatingCredits += credit;
  }
  for (const p of programMap.values()) p.participationRate = p.eligibleCredits ? p.participatingCredits * 100 / p.eligibleCredits : 0;
  const volunteers = { results: [...volunteerMap.values()].map(v => {
    const allocations = [...v.allocations.entries()];
    const { allocations: ignored, ...rest } = v;
    return { ...rest, name: v.name || v.email || 'Unknown', attribution: allocations.map(x => x[0]).join(',') || 'Unmatched', programCount: allocations.length, allocation: allocations.map(([name, hours]) => `${name}|${hours.toFixed(6)}`).join(';;') };
  }).sort((a, b) => b.knownHours - a.knownHours || a.name.localeCompare(b.name)).slice(0, 250) };
  const programs = { results: [...programMap.values()].sort((a, b) => b.knownHours - a.knownHours || a.name.localeCompare(b.name)) };
  const match = { total: matchedEmails.size, matched: [...matchedEmails.values()].filter(s => s.size >= 1).length, ambiguous: [...matchedEmails.values()].filter(s => s.size > 1).length, unmatched: [...matchedEmails.values()].filter(s => s.size === 0).length };
  const unmatched = { results: [...unmatchedMap.values()].map(u => ({ ...u, name: u.name || u.email || 'Unknown' })).sort((a, b) => b.knownHours - a.knownHours || a.name.localeCompare(b.name)).slice(0, 100) };

  // Six small aggregates that used to be three separate round trips.
  const counts = await env.DB.prepare(`SELECT
    (SELECT COUNT(*) FROM contact_mappings) mappings,
    (SELECT COUNT(DISTINCT LOWER(email)) FROM contact_mappings) uniqueEmails,
    (SELECT COUNT(DISTINCT LOWER(email)) FROM volunteer_program_overrides) overrideEmails,
    (SELECT COUNT(*) FROM volunteer_program_overrides) overrideMappings,
    (SELECT COUNT(DISTINCT LOWER(email)) FROM volunteer_affiliation_history) historyEmails,
    (SELECT COUNT(*) FROM volunteer_affiliation_history) historyMappings`).first<any>();

  const availablePrograms = await env.DB.prepare("SELECT program name FROM (SELECT DISTINCT program FROM contact_mappings UNION SELECT DISTINCT program FROM volunteer_program_overrides UNION SELECT DISTINCT program FROM volunteer_affiliation_history) WHERE program IS NOT NULL AND TRIM(program)<>'' ORDER BY name").all<any>();

  return {
    range: { startDate: range.startDate || null, endDate: range.endDate || null, resolvedEndDate: range.asOfDate || range.endDate || null },
    settings: cfg,
    summary: {
      volunteerHoursContributed: filled + manualFilled,
      hoursNeeded: needed, hoursFilled: filled, hoursRemaining: Math.max(0, needed - filled),
      knownHoursNeeded: knownNeeded, knownHoursFilled: knownFilled,
      estimatedHoursNeeded: Number(s?.tbdNeededQty || 0) * est,
      estimatedHoursFilled: Number(s?.tbdFilledQty || 0) * est,
      fillRate: needed ? filled / needed * 100 : 0,
      activeEvents: (e.results || []).length,
      totalAssignments: Number(s?.totalAssignments || 0),
      openSlots: Number(s?.openSlots || 0),
      assignedSlots: Number(s?.assignedSlots || 0),
      tbdAssignments: Number(s?.tbdAssignments || 0),
      lastSyncAt: logs?.syncTime || null,
      lastSyncStatus: logs?.syncStatus || null,
      contactSyncAt: logs?.contactSyncTime || null,
      contactSyncStatus: logs?.contactSyncStatus || null,
      contactMappings: Number(counts?.mappings || 0),
      uniqueContactEmails: Number(counts?.uniqueEmails || 0),
      manualOverrideEmails: Number(counts?.overrideEmails || 0),
      manualOverrideMappings: Number(counts?.overrideMappings || 0),
      datedAffiliationEmails: Number(counts?.historyEmails || 0),
      datedAffiliationMappings: Number(counts?.historyMappings || 0),
      matchedVolunteers: Number(match?.matched || 0),
      ambiguousVolunteers: Number(match?.ambiguous || 0),
      unmatchedVolunteers: Number(match?.unmatched || 0),
      volunteerEmails: Number(match?.total || 0)
    },
    programs: (programs.results || []).map((x: any) => Object.fromEntries(Object.entries(x).map(([k, v]) => [k, typeof v === 'number' ? v : (['knownHours', 'tbdAssignments', 'volunteers', 'volunteerCredits', 'eligibleCredits', 'participatingCredits', 'participationRate'].includes(k) ? Number(v || 0) : v)]))),
    events: (e.results || []).map((x: any) => ({ ...x, eventDate: x.eventDate || (x.firstEpoch ? new Date(Number(x.firstEpoch) * 1000).toISOString() : null), hoursNeeded: Number(x.knownNeeded || 0) + Number(x.tbdQty || 0) * est, hoursFilled: Number(x.knownFilled || 0) + Number(x.tbdFilledQty || 0) * est })),
    volunteers: volunteers.results || [],
    unmatched: unmatched.results || [],
    availablePrograms: (availablePrograms.results || []).map((x: any) => x.name)
  };
}
