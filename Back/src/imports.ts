import { z } from 'zod';
import { parse } from 'csv-parse/sync';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Pool, PoolClient } from 'pg';

const id = z.string().trim().min(1).max(120);
const text = z.string().min(1).max(2000);
const date = z.iso.date();
const grade = z.enum(['Junior','Middle','Senior','Lead']);
const level = z.number().int().min(0).max(5);
const levels = z.record(id, level);
const meta = z.object({ dataset: text, version: text, as_of_date: date });
const skill = z.object({skill_id:id,name:text,type:z.enum(['hard','soft']),category:text,description:text});
const profile = z.object({role:text,grade,required_skills:levels,critical_skills:z.array(id)});
const employee = z.object({employee_id:id,full_name:text,department:text,role:text,grade,manager_id:id.nullable(),hire_date:date,tenure_months:z.number().int().nonnegative(),work_format:z.enum(['office','hybrid','remote']),preferred_language:z.enum(['ru','kk','en']),last_review_date:date,skills:levels,career_goal:z.object({target_role:text,target_grade:grade}).nullable()});
const event = z.object({event_id:id,title:text,description:text,type:z.enum(['compliance','onboarding','course','workshop','mentoring','certification','meetup']),format:z.enum(['online','offline','self_paced']),duration_hours:z.number().positive(),mandatory:z.boolean(),target_roles:z.array(text).min(1),target_grades:z.array(grade).min(1),develops_skills:z.array(z.object({skill_id:id,gain:z.number().int().positive().max(5),max_level:level})),prerequisites:levels,upcoming_sessions:z.array(date)});
const history = z.object({record_id:id,employee_id:id,event_id:id,date,due_date:date.nullable(),status:z.enum(['completed','in_progress','dropped','no_show','declined','overdue']),completion_pct:z.number().int().min(0).max(100),score:z.number().int().min(0).max(100).nullable(),feedback_rating:z.number().int().min(1).max(5).nullable(),assigned_by:z.enum(['self','manager','hr'])}).refine(v=>v.status!=='completed'||v.completion_pct===100,{path:['completion_pct'],message:'completed requires 100'});
const bundle = z.object({
  skills:z.object({meta,skills:z.array(skill).max(10000),role_profiles:z.array(profile).max(10000)}).optional(),
  employees:z.object({meta,employees:z.array(employee).max(10000)}).optional(),
  events:z.object({meta,events:z.array(event).max(10000)}).optional(),
  history:z.array(history).max(100000).optional(),
}).refine(v=>Boolean(v.skills||v.employees||v.events||v.history?.length),{message:'Empty dataset'});
export type Bundle = z.infer<typeof bundle>;
export class ImportError extends Error {
  constructor(public details: {file:string;field:string;message:string}[]) {super('Данные не прошли проверку');}
}
export function parseBundle(input: unknown): Bundle {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new ImportError([{file:'dataset',field:'',message:'Expected an object'}]);
  const raw = { ...input } as Record<string,unknown>;
  if ('historyCsv' in raw) {
    try {
      if (typeof raw.historyCsv !== 'string') throw new Error('Expected CSV text');
      const rows = parse(raw.historyCsv,{columns:true,bom:true,skip_empty_lines:true,max_record_size:10000}) as Record<string,string>[];
      raw.history = rows.map(r=>({...r,due_date:r.due_date||null,completion_pct:r.completion_pct?.trim()?Number(r.completion_pct):NaN,score:r.score?.trim()?Number(r.score):null,feedback_rating:r.feedback_rating?.trim()?Number(r.feedback_rating):null}));
      delete raw.historyCsv;
    } catch {throw new ImportError([{file:'activity_history.csv',field:'CSV',message:'Malformed CSV'}]);}
  }
  const result = bundle.strict().safeParse(raw);
  if (!result.success) throw new ImportError(result.error.issues.slice(0,100).map(i=>({file:String(i.path[0]??'dataset'),field:i.path.slice(1).join('.'),message:i.message})));
  return result.data;
}
export async function readBundle(path: string) {
  const [skills,employees,events,historyCsv] = await Promise.all(['skills.json','employees.json','events.json','activity_history.csv'].map(n=>readFile(join(path,n),'utf8')));
  return parseBundle({skills:JSON.parse(skills!),employees:JSON.parse(employees!),events:JSON.parse(events!),historyCsv});
}
function canonical(value: unknown): string {
  if (Array.isArray(value)) return '['+value.map(canonical).join(',')+']';
  if (value && typeof value==='object') return '{'+Object.entries(value).sort(([a],[b])=>a.localeCompare(b)).map(([k,v])=>JSON.stringify(k)+':'+canonical(v)).join(',')+'}';
  return JSON.stringify(value);
}
const hashBundle = (b: Bundle) => createHash('sha256').update(canonical(b)).digest('hex');
async function validateReferences(c:PoolClient,b:Bundle) {
  const errors: ImportError['details'] = [];
  const issue = (file:string,field:string,message:string) => {if(errors.length<100)errors.push({file,field,message});};
  const unique = (items:string[],file:string,field:string) => {const s=new Set<string>(); for(const x of items) {if(s.has(x))issue(file,field,`Duplicate: ${x}`);s.add(x);}};
  unique(b.skills?.skills.map(x=>x.skill_id)??[],'skills','skill_id');
  unique(b.skills?.role_profiles.map(x=>`${x.role}/${x.grade}`)??[],'skills','role_profiles');
  unique(b.employees?.employees.map(x=>x.employee_id)??[],'employees','employee_id');
  unique(b.events?.events.map(x=>x.event_id)??[],'events','event_id');
  unique(b.history?.map(x=>x.record_id)??[],'history','record_id');
  const skillIds=new Set((await c.query('SELECT skill_id FROM skills')).rows.map(x=>x.skill_id as string));
  const profiles=new Set((await c.query('SELECT role,grade FROM role_profiles')).rows.map(x=>`${x.role}/${x.grade}`));
  const employeeRows=new Map((await c.query('SELECT employee_id,manager_id,department,grade FROM employees')).rows.map(x=>[x.employee_id,x]));
  const events=new Map((await c.query('SELECT event_id,mandatory,format FROM events')).rows.map(x=>[x.event_id,x]));
  const roles=new Set((await c.query('SELECT role FROM roles')).rows.map(x=>x.role as string));
  b.skills?.skills.forEach(x=>skillIds.add(x.skill_id));
  b.skills?.role_profiles.forEach(x=>{profiles.add(`${x.role}/${x.grade}`);roles.add(x.role);});
  b.employees?.employees.forEach(x=>employeeRows.set(x.employee_id,x));
  b.events?.events.forEach(x=>events.set(x.event_id,x));
  const checkSkills=(keys:string[],file:string,field:string)=>keys.forEach(k=>{if(!skillIds.has(k))issue(file,field,`Unknown skill: ${k}`);});
  const metas=[b.skills?.meta,b.employees?.meta,b.events?.meta].filter(x=>x!==undefined);
  if(new Set(metas.map(x=>x.as_of_date)).size>1)issue('dataset','meta.as_of_date','Snapshot dates differ');
  for(const p of b.skills?.role_profiles??[]) {
    checkSkills(Object.keys(p.required_skills),'skills',`${p.role}/${p.grade}`);
    unique(p.critical_skills,'skills',`${p.role}/${p.grade}.critical_skills`);
    for(const k of p.critical_skills)if(!(k in p.required_skills))issue('skills','critical_skills',`Missing requirement: ${k}`);
  }
  for(const e of b.employees?.employees??[]) {
    if(!profiles.has(`${e.role}/${e.grade}`))issue('employees',e.employee_id,'Unknown role/grade');
    if(e.career_goal&&!profiles.has(`${e.career_goal.target_role}/${e.career_goal.target_grade}`))issue('employees',e.employee_id,'Unknown career goal');
    checkSkills(Object.keys(e.skills),'employees',`${e.employee_id}.skills`);
    if(e.hire_date>b.employees!.meta.as_of_date||e.last_review_date>b.employees!.meta.as_of_date)issue('employees',e.employee_id,'Employee date is after snapshot');
  }
  // Validate the whole resulting graph, including existing employees affected by an update.
  for(const [key,e] of employeeRows)if(e.manager_id) {
    const manager=employeeRows.get(e.manager_id);
    if(!manager||manager.grade!=='Lead'||manager.department!==e.department||key===e.manager_id)issue('employees',key,'Manager must exist, be Lead and belong to the same department');
    const seen=new Set([key]);let current=e.manager_id;
    while(current) {if(seen.has(current)){issue('employees',key,'Manager cycle');break;}seen.add(current);current=employeeRows.get(current)?.manager_id;}
  }
  for(const e of b.events?.events??[]) {
    checkSkills([...e.develops_skills.map(s=>s.skill_id),...Object.keys(e.prerequisites)],'events',e.event_id);
    for(const r of e.target_roles)if(!roles.has(r))issue('events',e.event_id,`Unknown role: ${r}`);
    unique(e.target_roles,'events',`${e.event_id}.target_roles`);unique(e.target_grades,'events',`${e.event_id}.target_grades`);
    unique(e.develops_skills.map(s=>s.skill_id),'events',`${e.event_id}.develops_skills`);unique(e.upcoming_sessions,'events',`${e.event_id}.upcoming_sessions`);
  }
  for(const h of b.history??[]) {
    if(!employeeRows.has(h.employee_id))issue('history',h.record_id,'Unknown employee');
    if(!events.has(h.event_id))issue('history',h.record_id,'Unknown event');
    if(h.status==='no_show'&&events.get(h.event_id)?.format==='self_paced')issue('history',h.record_id,'Self-paced event cannot have no_show');
  }
  if(errors.length)throw new ImportError(errors);
}
export async function importBundle(pool:Pool,b:Bundle,options:{commit:boolean;actor?:string;requestId?:string}) {
  const c=await pool.connect();
  try {
    await c.query('BEGIN');await c.query('SELECT pg_advisory_xact_lock(2401902)');
    await validateReferences(c,b);
    const hash=hashBundle(b);
    const duplicate=await c.query('SELECT id FROM dataset_batches WHERE source_sha256=$1',[hash]);
    const counts={skills:b.skills?.skills.length??0,roleProfiles:b.skills?.role_profiles.length??0,employees:b.employees?.employees.length??0,events:b.events?.events.length??0,history:b.history?.length??0};
    if(duplicate.rowCount){await c.query('ROLLBACK');return{hash,counts,duplicate:true,committed:false,batchId:duplicate.rows[0].id as string};}
    // Existing record IDs are immutable; only identical replays may be skipped.
    const recordIds=b.history?.map(x=>x.record_id)??[];
    if(recordIds.length){
      const previous=await c.query('SELECT source_record_id AS record_id, employee_id,event_id,date::text,due_date::text,status,completion_pct,score,feedback_rating,assigned_by FROM participations WHERE source_record_id=ANY($1::text[])',[recordIds]);
      const byId=new Map(previous.rows.map(x=>[x.record_id,canonical(x)]));
      for(const h of b.history??[])if(byId.has(h.record_id)&&byId.get(h.record_id)!==canonical(h))throw new ImportError([{file:'history',field:h.record_id,message:'Existing record differs; corrections require a separate audited operation'}]);
    }
    const last=(await c.query('SELECT as_of_date::text,version FROM dataset_batches ORDER BY imported_at DESC LIMIT 1')).rows[0];
    const m=b.employees?.meta??b.skills?.meta??b.events?.meta??last;
    if(!m)throw new ImportError([{file:'dataset',field:'meta',message:'Initial import requires metadata'}]);
    if(last&&last.as_of_date!==m.as_of_date)throw new ImportError([{file:'dataset',field:'meta.as_of_date',message:'Snapshot changes require a dedicated migration'}]);
    if(!options.commit){await c.query('ROLLBACK');return{hash,counts,duplicate:false,committed:false};}
    const batchId=(await c.query('INSERT INTO dataset_batches(version,as_of_date,source_sha256,counts) VALUES($1,$2,$3,$4) RETURNING id',[m.version,m.as_of_date,hash,counts])).rows[0].id as string;
    for(const s of b.skills?.skills??[])await c.query('INSERT INTO skills VALUES($1,$2,$3,$4,$5) ON CONFLICT(skill_id) DO UPDATE SET name=EXCLUDED.name,type=EXCLUDED.type,category=EXCLUDED.category,description=EXCLUDED.description',[s.skill_id,s.name,s.type,s.category,s.description]);
    for(const p of b.skills?.role_profiles??[]) {
      await c.query('INSERT INTO roles VALUES($1) ON CONFLICT DO NOTHING',[p.role]);
      await c.query('INSERT INTO role_profiles VALUES($1,$2) ON CONFLICT DO NOTHING',[p.role,p.grade]);
      await c.query('DELETE FROM role_requirements WHERE role=$1 AND grade=$2',[p.role,p.grade]);
      for(const [k,v]of Object.entries(p.required_skills))await c.query('INSERT INTO role_requirements VALUES($1,$2,$3,$4,$5)',[p.role,p.grade,k,v,p.critical_skills.includes(k)]);
    }
    for(const e of b.employees?.employees??[]) {
      await c.query(`INSERT INTO employees VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) ON CONFLICT(employee_id) DO UPDATE SET full_name=EXCLUDED.full_name,department=EXCLUDED.department,role=EXCLUDED.role,grade=EXCLUDED.grade,manager_id=EXCLUDED.manager_id,hire_date=EXCLUDED.hire_date,tenure_months=EXCLUDED.tenure_months,work_format=EXCLUDED.work_format,preferred_language=EXCLUDED.preferred_language,last_review_date=EXCLUDED.last_review_date,dataset_batch_id=EXCLUDED.dataset_batch_id`,[e.employee_id,e.full_name,e.department,e.role,e.grade,e.manager_id,e.hire_date,e.tenure_months,e.work_format,e.preferred_language,e.last_review_date,batchId]);
      await c.query('DELETE FROM employee_skill_baselines WHERE employee_id=$1',[e.employee_id]);
      for(const [k,v]of Object.entries(e.skills))await c.query('INSERT INTO employee_skill_baselines VALUES($1,$2,$3)',[e.employee_id,k,v]);
      const goal=(await c.query("SELECT target_role,target_grade FROM career_goals WHERE employee_id=$1 AND status='active'",[e.employee_id])).rows[0];
      if(goal?.target_role!==e.career_goal?.target_role||goal?.target_grade!==e.career_goal?.target_grade){
        await c.query("UPDATE career_goals SET status='archived' WHERE employee_id=$1 AND status='active'",[e.employee_id]);
        if(e.career_goal)await c.query('INSERT INTO career_goals(employee_id,target_role,target_grade) VALUES($1,$2,$3)',[e.employee_id,e.career_goal.target_role,e.career_goal.target_grade]);
      }
    }
    for(const e of b.events?.events??[]) {
      await c.query('INSERT INTO events(event_id,title,description,type,format,duration_hours,mandatory) VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT(event_id) DO UPDATE SET title=EXCLUDED.title,description=EXCLUDED.description,type=EXCLUDED.type,format=EXCLUDED.format,duration_hours=EXCLUDED.duration_hours,mandatory=EXCLUDED.mandatory',[e.event_id,e.title,e.description,e.type,e.format,e.duration_hours,e.mandatory]);
      for(const table of ['event_target_roles','event_target_grades','event_skill_effects','event_prerequisites','event_sessions'])await c.query(`DELETE FROM ${table} WHERE event_id=$1`,[e.event_id]);
      for(const r of e.target_roles)await c.query('INSERT INTO event_target_roles VALUES($1,$2)',[e.event_id,r]);
      for(const g of e.target_grades)await c.query('INSERT INTO event_target_grades VALUES($1,$2)',[e.event_id,g]);
      for(const s of e.develops_skills)await c.query('INSERT INTO event_skill_effects VALUES($1,$2,$3,$4)',[e.event_id,s.skill_id,s.gain,s.max_level]);
      for(const [k,v]of Object.entries(e.prerequisites))await c.query('INSERT INTO event_prerequisites VALUES($1,$2,$3)',[e.event_id,k,v]);
      for(const d of e.upcoming_sessions)await c.query('INSERT INTO event_sessions(event_id,session_date) VALUES($1,$2)',[e.event_id,d]);
    }
    for(const h of b.history??[])await c.query('INSERT INTO participations(source_record_id,employee_id,event_id,date,due_date,status,completion_pct,score,feedback_rating,assigned_by) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) ON CONFLICT(source_record_id) DO NOTHING',[h.record_id,h.employee_id,h.event_id,h.date,h.due_date,h.status,h.completion_pct,h.score,h.feedback_rating,h.assigned_by]);
    await c.query("INSERT INTO audit_log(actor,action,entity,entity_id,details,request_id) VALUES($1,'dataset.import','dataset_batches',$2,$3,$4)",[options.actor??null,batchId,{hash,counts},options.requestId??null]);
    await c.query('COMMIT');return{hash,counts,duplicate:false,committed:true,batchId};
  }catch(e){await c.query('ROLLBACK');throw e;}finally{c.release();}
}
