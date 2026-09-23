import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Link } from 'wouter';
import { api, ApiError, type Session } from '../../api';
import { Badge, Button, EmptyState, ErrorState, Loading } from '../../components/ui';
import { statusLabel, useGrowthCopy, type Copy } from './copy';
import type { EventItem, Forecast, Goal, RoleProfile, Skill } from './types';

export function message(error: unknown, c: Copy) {
  if (!(error instanceof ApiError)) return c('error');
  if (error.code === 'GOAL_REQUIRED') return c('goalRequired');
  if (error.code === 'EVENT_NOT_ELIGIBLE') return c('ineligible');
  if (error.code === 'EMPLOYEE_REQUIRED') return c('noEmployee');
  if (error.status === 409) return c('conflict');
  if (error.status === 400 || error.status === 422) return c('invalid');
  if (error.status === 429) return c('limited');
  return error.message;
}
export function useQuery<T>(path: string | null) {
  const [data, setData] = useState<T>(); const [error, setError] = useState<unknown>();
  const [loading, setLoading] = useState(Boolean(path)); const [revision, setRevision] = useState(0);
  const [total, setTotal] = useState(0);
  useEffect(() => {
    const controller = new AbortController(); setError(undefined); setData(undefined); setLoading(Boolean(path));
    if (path) void api<T>(path, { signal: controller.signal }).then(response => {
      if (!controller.signal.aborted) { setData(response.data); setTotal(Number(response.meta?.total ?? 0)); }
    }).catch(error => { if (!controller.signal.aborted) setError(error); }).finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [path, revision]);
  return { data, error, loading, total, refresh: () => setRevision(value => value + 1) };
}
export function useMutation(session: Session) {
  const { c } = useGrowthCopy(); const [busy, setBusy] = useState(false); const [error, setError] = useState(''); const [success, setSuccess] = useState(false);
  const lock = useRef(false); const mounted = useRef(true); const controllers = useRef(new Set<AbortController>()); const keys = useRef(new Map<string, string>());
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; controllers.current.forEach(controller => controller.abort()); }; }, []);
  async function run<T>(path: string, body: unknown = {}, method = 'POST', idempotent = false): Promise<T | undefined> {
    if (lock.current) return undefined;
    lock.current = true; setBusy(true); setError(''); setSuccess(false);
    const signature = `${method}:${path}:${JSON.stringify(body)}`;
    const key = keys.current.get(signature) ?? crypto.randomUUID(); if (idempotent) keys.current.set(signature, key);
    const controller = new AbortController(); controllers.current.add(controller);
    try {
      const result = await api<T>(path, { method, body, csrf: session.csrfToken, signal: controller.signal, ...(idempotent ? { idempotencyKey: key } : {}) });
      keys.current.delete(signature); if (!mounted.current || controller.signal.aborted) return undefined;
      setSuccess(true); return result.data;
    } catch (e) { if (mounted.current && !controller.signal.aborted) setError(message(e, c)); return undefined; }
    finally { controllers.current.delete(controller); lock.current = false; if (mounted.current) setBusy(false); }
  }
  return { run, busy, error, success, clear: () => { setError(''); setSuccess(false); } };
}
export type Mutation = ReturnType<typeof useMutation>;
export function MutationNotice({ mutation }: { mutation: Mutation }) { const { c } = useGrowthCopy(); return <>{mutation.error && <ErrorState message={mutation.error}/>} {mutation.success && <p className="growth-success" role="status">{c('saved')}</p>}</>; }
export function QueryState<T>({ query, children, empty }: { query: ReturnType<typeof useQuery<T>>; children: (data: T) => ReactNode; empty?: string }) {
  const { c } = useGrowthCopy();
  return query.loading ? <Loading/> : query.error ? <ErrorState message={message(query.error, c)} retry={query.refresh}/> : query.data === undefined ? null : Array.isArray(query.data) && !query.data.length ? <EmptyState title={empty ?? c('empty')}/> : <>{children(query.data)}</>;
}
export function Panel({ title, children, action }: { title: string; children: ReactNode; action?: ReactNode }) { return <section className="card growth-panel"><div className="growth-section-heading"><h2>{title}</h2>{action}</div>{children}</section>; }
export function Field({ label, children }: { label: string; children: ReactNode }) { return <label className="growth-field"><span>{label}</span>{children}</label>; }
export function Status({ value }: { value: string }) { const { c } = useGrowthCopy(); return <Badge tone={['active','accepted','completed','fulfilled'].includes(value) ? 'green' : 'neutral'}>{statusLabel(c, value)}</Badge>; }
export function dateLabel(value: string | null | undefined, locale: string) { if (!value) return '—'; const date = new Date(value.length === 10 ? `${value}T12:00:00` : value); return Number.isNaN(date.getTime()) ? value : new Intl.DateTimeFormat(locale, { dateStyle: 'medium' }).format(date); }
export function GoalSelect({ profiles, value, onChange, allowCurrent = false }: { profiles: RoleProfile[]; value: string; onChange: (value: string) => void; allowCurrent?: boolean }) {
  const { c } = useGrowthCopy(); return <select aria-label={c('goal')} value={value} onChange={event => onChange(event.target.value)} required={!allowCurrent}><option value="">{allowCurrent ? c('currentGoal') : c('chooseGoal')}</option>{profiles.map(profile => <option key={`${profile.role}/${profile.grade}`} value={JSON.stringify({ targetRole: profile.role, targetGrade: profile.grade })}>{profile.role} · {profile.grade}</option>)}</select>;
}
export const goalValue = (value: string): Goal | undefined => value ? JSON.parse(value) as Goal : undefined;
export function SkillOptions({ skills, selected, onChange, max = 15 }: { skills: Skill[]; selected: string[]; onChange: (values: string[]) => void; max?: number }) {
  const { c } = useGrowthCopy(); return <div className="growth-checkboxes growth-skill-options" role="group" aria-label={c('skill')}>{skills.map(skill => <label key={skill.id}><input type="checkbox" checked={selected.includes(skill.id)} disabled={selected.length >= max && !selected.includes(skill.id)} onChange={() => onChange(selected.includes(skill.id) ? selected.filter(id => id !== skill.id) : [...selected, skill.id])}/><span>{skill.name}</span></label>)}</div>;
}
export function EventPicker({ value, onChange, max = 30, ordered = false }: { value: string[]; onChange: (ids: string[]) => void; max?: number; ordered?: boolean }) {
  const { c } = useGrowthCopy(); const [search, setSearch] = useState(''); const [query, setQuery] = useState(''); const [page, setPage] = useState(1); const known = useRef(new Map<string, EventItem>());
  useEffect(() => { const timer = setTimeout(() => { setQuery(search.trim()); setPage(1); }, 300); return () => clearTimeout(timer); }, [search]);
  const events = useQuery<EventItem[]>(`/events?mandatory=false&q=${encodeURIComponent(query)}&page=${page}&limit=12`);
  useEffect(() => { events.data?.forEach(event => known.current.set(event.eventId, event)); }, [events.data]);
  function move(index: number, delta: number) { const next = [...value]; const other = index + delta; if (other < 0 || other >= next.length) return; [next[index], next[other]] = [next[other]!, next[index]!]; onChange(next); }
  return <div className="growth-event-picker"><Field label={c('eventSearch')}><input type="search" value={search} maxLength={100} onChange={event => setSearch(event.target.value)}/></Field>
    <QueryState query={events} empty={c('catalogEmpty')}>{items => <div className="growth-event-options">{items.filter(event => event.isActive && !event.mandatory).map(event => <label key={event.eventId}><input type="checkbox" checked={value.includes(event.eventId)} disabled={!value.includes(event.eventId) && value.length >= max} onChange={() => onChange(value.includes(event.eventId) ? value.filter(id => id !== event.eventId) : [...value, event.eventId])}/><span><strong>{event.title}</strong><small>{event.durationHours} {c('hours')} · {statusLabel(c, event.format)}</small></span></label>)}</div>}</QueryState>
    <div className="growth-actions"><Button size="small" variant="secondary" disabled={page === 1 || events.loading} onClick={() => setPage(page - 1)}>{c('previous')}</Button><span>{c('page')} {page}</span><Button size="small" variant="secondary" disabled={events.loading || (events.total ? page * 12 >= events.total : (events.data?.length ?? 0) < 12)} onClick={() => setPage(page + 1)}>{c('next')}</Button><span>{c('chosen')}: {value.length}/{max}</span></div>
    {value.length > 0 && <ol className="growth-selection">{value.map((id, index) => <li key={id}><span>{known.current.get(id)?.title ?? id}</span><div className="growth-actions">{ordered && <><Button variant="ghost" size="small" disabled={index === 0} onClick={() => move(index, -1)} aria-label={`${c('up')}: ${known.current.get(id)?.title ?? id}`}>↑</Button><Button variant="ghost" size="small" disabled={index === value.length - 1} onClick={() => move(index, 1)} aria-label={`${c('down')}: ${known.current.get(id)?.title ?? id}`}>↓</Button></>}<Button variant="ghost" size="small" onClick={() => onChange(value.filter(item => item !== id))}>{c('remove')}</Button></div></li>)}</ol>}
  </div>;
}
export function ForecastView({ data, skills }: { data: Forecast; skills: Skill[] }) {
  const { c, locale } = useGrowthCopy(); const name = (id: string) => skills.find(skill => skill.id === id)?.name ?? id;
  const levels = Object.keys({ ...data.baselineLevels, ...data.projectedLevels }).filter(id => data.baselineLevels[id] !== data.projectedLevels[id]);
  return <div className="growth-forecast"><p className="growth-note">{c('planNote')}</p><div className="growth-metrics">{data.totalHours !== undefined && <span>{c('hours')}: <strong>{data.totalHours}</strong></span>}{data.budgetHours !== undefined && <span>{c('budget')}: <strong>{data.budgetHours} {c('hours')}</strong></span>}</div>
    <h3>{c('steps')}</h3>{data.steps.length ? <ol className="growth-steps">{data.steps.map((step, index) => <li key={`${step.eventId}-${index}`}><div className="growth-row"><Link href={`/events/${encodeURIComponent(step.eventId)}`}>{step.title ?? step.eventId}</Link>{step.completed && <Status value="completed"/>}</div><p>{step.scheduledDate && dateLabel(step.scheduledDate, locale)} {step.durationHours !== undefined && `· ${step.durationHours} ${c('hours')}`}</p><ul>{step.gains.map(gain => <li key={gain.skillId}>{name(gain.skillId)}: {gain.from} → {gain.to}</li>)}</ul>{!!step.prerequisites?.length && <p>{c('prerequisites')}: {step.prerequisites.map(item => `${name(item.skillId)} ${item.minLevel}`).join(', ')}</p>}{!!step.alternatives?.length && <p>{c('alternatives')}: {step.alternatives.map((id, i) => <span key={id}>{i > 0 && ', '}<Link href={`/events/${encodeURIComponent(id)}`}>{id}</Link></span>)}</p>}</li>)}</ol> : <p className="growth-note">{c('noSteps')}</p>}
    {levels.length > 0 && <><h3>{c('projected')}</h3><div className="growth-table-wrap"><table><thead><tr><th>{c('skill')}</th><th>{c('before')}</th><th>{c('after')}</th></tr></thead><tbody>{levels.map(id => <tr key={id}><td>{name(id)}</td><td>{data.baselineLevels[id] ?? 0}</td><td>{data.projectedLevels[id] ?? 0}</td></tr>)}</tbody></table></div></>}
    <h3>{c('gaps')}</h3>{data.unmetRequirements.length ? <ul className="growth-gaps">{data.unmetRequirements.map(gap => <li key={gap.skillId}><span>{name(gap.skillId)}</span><strong>{gap.currentLevel}/{gap.requiredLevel}</strong>{gap.isCritical && <Badge>{c('critical')}</Badge>}</li>)}</ul> : <p className="growth-success">{c('noGaps')}</p>}
  </div>;
}
