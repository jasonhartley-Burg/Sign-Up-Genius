import type { Env } from "./types";

const DEFAULT_SHEET_ID = "1bbRVZGY-gr6WFcgzayD8eQX22LuGGJIqWQqipF4PB90";
const PROGRAM_TABS = ["A Guard", "Elementary Fall Guard", "Fall Guard", "Marching Band", "World"];
const KNOWN_TAB = "Known Table";

function clean(v: unknown) { return String(v ?? "").trim(); }
function norm(v: unknown) { return clean(v).toLowerCase().replace(/[^a-z0-9]+/g, " ").trim(); }
function emailList(v: unknown) {
  const matches = clean(v).match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi) || [];
  return [...new Set(matches.map(x => x.toLowerCase()))];
}
function parseCsv(text: string) {
  const rows: string[][] = []; let row: string[] = [], cell = "", quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') { cell += '"'; i++; }
      else if (c === '"') quoted = false;
      else cell += c;
    } else {
      if (c === '"') quoted = true;
      else if (c === ',') { row.push(cell); cell = ""; }
      else if (c === '\n') { row.push(cell.replace(/\r$/, "")); rows.push(row); row = []; cell = ""; }
      else cell += c;
    }
  }
  row.push(cell.replace(/\r$/, "")); if (row.some(x => x !== "")) rows.push(row);
  return rows;
}
async function fetchTab(env: Env, tab: string) {
  const id = env.PROGRAM_CONTACTS_SHEET_ID || DEFAULT_SHEET_ID;
  const url = `https://docs.google.com/spreadsheets/d/${encodeURIComponent(id)}/gviz/tq?tqx=out:csv&sheet=${encodeURIComponent(tab)}`;
  const r = await fetch(url, { headers: { Accept: "text/csv,text/plain,*/*" } });
  const t = await r.text();
  if (!r.ok) throw new Error(`Google Sheet ${tab}: HTTP ${r.status}`);
  if (/^\s*</.test(t) || /accounts\.google\.com|ServiceLogin/i.test(t)) throw new Error(`Google Sheet ${tab} is not publicly readable by the Worker. Share it as Anyone with the link → Viewer.`);
  return parseCsv(t);
}
function findIndex(headers: string[], tests: RegExp[]) {
  const n = headers.map(norm); return n.findIndex(h => tests.some(r => r.test(h)));
}
function inferColumns(headers: string[]) {
  const studentFirst = findIndex(headers, [/student first name/, /^first name$/]);
  const studentLast = findIndex(headers, [/student last name/, /^last name$/]);
  const studentFull = findIndex(headers, [/^student s name/, /^student name/]);
  const parent = findIndex(headers, [/parent guardian name/, /caregiver name/, /^parent name$/]);
  const emailCols = headers.map((h, i) => ({ i, h: norm(h) })).filter(x => x.h.includes("email") && !x.h.includes("student email")).map(x => x.i);
  return { studentFirst, studentLast, studentFull, parent, emailCols };
}
function studentName(row: string[], c: ReturnType<typeof inferColumns>) {
  if (c.studentFirst >= 0 || c.studentLast >= 0) return [clean(row[c.studentFirst]), clean(row[c.studentLast])].filter(Boolean).join(" ");
  return c.studentFull >= 0 ? clean(row[c.studentFull]) : "";
}
function rowsForProgram(rows: string[][], tab: string) {
  if (!rows.length) return [] as {email:string;parentName:string;studentName:string;program:string;sourceTab:string;sourceType:string}[];
  const headers = rows[0], c = inferColumns(headers), out: any[] = [];
  for (const row of rows.slice(1)) {
    const student = studentName(row, c); const parentName = c.parent >= 0 ? clean(row[c.parent]) : "";
    const emails = c.emailCols.flatMap(i => emailList(row[i]));
    for (const email of [...new Set(emails)]) out.push({ email, parentName, studentName: student, program: tab, sourceTab: tab, sourceType: "program_roster" });
  }
  return out;
}
function rowsForKnown(rows: string[][]) {
  if (!rows.length) return [] as any[];
  const h = rows[0].map(norm), ix = (s:string)=>h.findIndex(x=>x===s || x.includes(s));
  const si=ix("student name"), pi=ix("parent name"), ei=ix("email"), gi=ix("program"); const out:any[]=[];
  for(const r of rows.slice(1)) for(const email of emailList(r[ei])) out.push({email,parentName:clean(r[pi]),studentName:clean(r[si]),program:clean(r[gi]),sourceTab:KNOWN_TAB,sourceType:"known_table"});
  return out;
}
export async function syncContacts(env: Env) {
  const all:any[]=[]; const sourceCounts:Record<string,number>={}; const errors:string[]=[];
  for(const tab of PROGRAM_TABS){try{const rs=rowsForProgram(await fetchTab(env,tab),tab); sourceCounts[tab]=rs.length; all.push(...rs)}catch(e){errors.push(e instanceof Error?e.message:String(e)); sourceCounts[tab]=0}}
  try{const rs=rowsForKnown(await fetchTab(env,KNOWN_TAB)); sourceCounts[KNOWN_TAB]=rs.length; all.push(...rs)}catch(e){errors.push(e instanceof Error?e.message:String(e)); sourceCounts[KNOWN_TAB]=0}
  if(!all.length && errors.length) throw new Error(errors.join(" | "));
  await env.DB.prepare("DELETE FROM contact_mappings").run();
  const seen=new Set<string>(); let inserted=0;
  for(const x of all){if(!x.email||!x.program)continue;const key=[x.email,x.studentName,x.program,x.sourceType].map((v:string)=>v.toLowerCase()).join("|");if(seen.has(key))continue;seen.add(key);await env.DB.prepare(`INSERT INTO contact_mappings(email,parent_name,student_name,program,source_tab,source_type,updated_at) VALUES(?,?,?,?,?,?,datetime('now'))`).bind(x.email,x.parentName||null,x.studentName||null,x.program,x.sourceTab,x.sourceType).run();inserted++}
  const uniqueEmails=await env.DB.prepare("SELECT COUNT(DISTINCT LOWER(email)) n FROM contact_mappings").first<any>();
  const multi=await env.DB.prepare("SELECT COUNT(*) n FROM (SELECT LOWER(email) e FROM contact_mappings GROUP BY LOWER(email) HAVING COUNT(DISTINCT program)>1)").first<any>();
  await env.DB.prepare("INSERT INTO contact_sync_log(sync_time,records,status,message) VALUES(datetime('now'),?,'success',?)").bind(inserted,errors.length?errors.join(" | "):"OK").run();
  return {rows:inserted,uniqueEmails:Number(uniqueEmails?.n||0),multiProgramEmails:Number(multi?.n||0),sourceCounts,errors};
}
