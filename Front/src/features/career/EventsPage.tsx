import { useEffect, useState } from 'react';
import { Link } from 'wouter';
import { ArrowRight, Plus, Search } from 'lucide-react';
import type { PageMeta, Session } from '../../api';
import { Badge, Button, EmptyState, Heading, Loading } from '../../components/ui';
import { label, useCareerCopy } from './copy';
import { canManage, contextQuery, EligibilityList, EmployeePicker, EventBadges, Pager, ResourceError, useDebounce, useEmployeeContext, useEventTranslation, useRead } from './shared';
import { eventTypes, formats, grades, type CareerEvent, type RoleProfile, type Skill } from './types';

const initialFilters = { role: '', grade: '', skillId: '', type: '', format: '', maxHours: '', mandatory: '', available: false, includeInactive: false };
export function EventsPage({ session, employeeId: supplied }: { session: Session; employeeId?: string }) {
  const c = useCareerCopy(); const { employeeId, choose } = useEmployeeContext(session, supplied); const [search, setSearch] = useState(''); const query = useDebounce(search.trim()); const [filters, setFilters] = useState(initialFilters); const [page, setPage] = useState(1); const [choosePerson, setChoosePerson] = useState(false);
  const skills = useRead<Skill[]>('/skills'); const roles = useRead<RoleProfile[]>('/role-profiles');
  useEffect(() => setPage(1), [query, employeeId]);
  const params = new URLSearchParams({ q: query, page: String(page), limit: '12' });
  if (employeeId) params.set('employeeId', employeeId);
  for (const key of ['role', 'grade', 'skillId', 'type', 'format', 'maxHours', 'mandatory'] as const) if (filters[key]) params.set(key, filters[key]);
  if (filters.available && employeeId) params.set('available', 'true');
  if (filters.includeInactive && canManage(session)) params.set('includeInactive', 'true');
  const events = useRead<CareerEvent[], PageMeta & { asOfDate: string }>(`/events?${params}`);
  useEffect(() => { if (!events.loading && !events.error && events.meta) { const last = Math.max(1, Math.ceil(events.meta.total / 12)); if (page > last) setPage(last); } }, [events.loading, events.error, events.meta, page]);
  const names = Object.fromEntries((skills.data ?? []).map(skill => [skill.id, skill.name]));
  const change = <K extends keyof typeof filters>(key: K, value: (typeof filters)[K]) => { setFilters(previous => ({ ...previous, [key]: value })); setPage(1); };
  return <div className="career-page"><Heading title={c.catalog} subtitle={c.catalogSub} action={canManage(session) && <Button asChild><Link href={`/events/new${contextQuery(employeeId)}`}><Plus size={16} />{c.createEvent}</Link></Button>} />
    {session.user.role !== 'employee' && !supplied && <div className="career-context-control"><span>{c.selectedEmployee}: <strong>{employeeId || '—'}</strong></span><Button variant="ghost" size="small" onClick={() => setChoosePerson(value => !value)}>{c.chooseEmployee}</Button></div>}
    {choosePerson && <EmployeePicker onChoose={id => { choose(id); setChoosePerson(false); setPage(1); }} />}
    <section className="career-card career-filter-panel"><label className="career-search"><Search size={18} aria-hidden="true" /><input type="search" maxLength={150} value={search} onChange={event => setSearch(event.target.value)} placeholder={c.search} aria-label={c.search} /></label><details><summary>{c.filters}</summary><div className="career-filter-grid">
      <label className="career-field">{c.role}<select value={filters.role} onChange={event => change('role', event.target.value)}><option value="">{c.all}</option>{[...new Set(roles.data?.map(role => role.role))].map(role => <option key={role}>{role}</option>)}</select></label>
      <label className="career-field">{c.grade}<select value={filters.grade} onChange={event => change('grade', event.target.value)}><option value="">{c.all}</option>{grades.map(grade => <option key={grade}>{grade}</option>)}</select></label>
      <label className="career-field">{c.skill}<select value={filters.skillId} onChange={event => change('skillId', event.target.value)}><option value="">{c.all}</option>{skills.data?.map(skill => <option key={skill.id} value={skill.id}>{skill.name}</option>)}</select></label>
      <label className="career-field">{c.type}<select value={filters.type} onChange={event => change('type', event.target.value)}><option value="">{c.all}</option>{eventTypes.map(type => <option key={type} value={type}>{label(c, type)}</option>)}</select></label>
      <label className="career-field">{c.format}<select value={filters.format} onChange={event => change('format', event.target.value)}><option value="">{c.all}</option>{formats.map(format => <option key={format} value={format}>{label(c, format)}</option>)}</select></label>
      <label className="career-field">{c.maxHours}<input type="number" min="0.1" max="1000" step="0.1" value={filters.maxHours} onChange={event => { const value = event.target.value; if (!value || Number(value) > 0) change('maxHours', value); }} /></label>
      <label className="career-field">{c.mandatory}<select value={filters.mandatory} onChange={event => change('mandatory', event.target.value)}><option value="">{c.all}</option><option value="true">{c.mandatory}</option><option value="false">{c.voluntary}</option></select></label>
    </div><div className="career-filter-checks"><label className="career-check"><input type="checkbox" checked={filters.available} disabled={!employeeId} onChange={event => change('available', event.target.checked)} />{c.availableOnly}</label>{canManage(session) && <label className="career-check"><input type="checkbox" checked={filters.includeInactive} onChange={event => change('includeInactive', event.target.checked)} />{c.includeInactive}</label>}<Button variant="ghost" size="small" onClick={() => { setFilters(initialFilters); setSearch(''); setPage(1); }}>{c.reset}</Button></div>{!employeeId && <p className="career-muted">{c.chooseEmployee}: {c.availableOnly}</p>}{skills.error && <ResourceError error={skills.error} retry={skills.reload} />}{roles.error && <ResourceError error={roles.error} retry={roles.reload} />}</details></section>
    {events.loading ? <Loading /> : events.error ? <ResourceError error={events.error} retry={events.reload} /> : !events.data?.length ? <EmptyState title={c.noEvents} action={<Button variant="secondary" onClick={() => { setFilters(initialFilters); setSearch(''); setPage(1); }}>{c.reset}</Button>} /> : <><div className="career-event-grid">{events.data.map(event => <CatalogCard key={event.eventId} event={event} employeeId={employeeId} names={names} />)}</div><Pager page={page} total={events.meta?.total ?? events.data.length} limit={12} onChange={setPage} /></>}
  </div>;
}

function CatalogCard({ event, employeeId, names }: { event: CareerEvent; employeeId: string; names: Record<string, string> }) {
  const c = useCareerCopy(); const translated = useEventTranslation(event.eventId);
  return <article className="career-card career-event-card"><EventBadges event={event} /><h2>{translated.translation?.title ?? event.title}</h2><p className="career-event-excerpt">{translated.translation?.description ?? event.description}</p>{!translated.loading && !translated.translation && <small className="career-muted">{c.sourceText}</small>}<div className="career-event-facts"><Badge>{event.durationHours} {c.hours}</Badge><span>{event.effects.length} · {c.skills.toLocaleLowerCase()}</span></div><EligibilityList eligibility={event.eligibility} names={names} /><Button variant="secondary" asChild><Link href={`/events/${encodeURIComponent(event.eventId)}${contextQuery(employeeId)}`}>{c.openEvent}<ArrowRight size={16} /></Link></Button></article>;
}
