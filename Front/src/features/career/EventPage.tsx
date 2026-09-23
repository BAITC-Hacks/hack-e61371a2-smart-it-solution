import { useEffect, useState } from 'react';
import { Link } from 'wouter';
import { ArrowLeft, Pencil } from 'lucide-react';
import { api, type Session } from '../../api';
import { Badge, Button, EmptyState, Heading, Loading } from '../../components/ui';
import { label, useCareerCopy } from './copy';
import { canEdit, canManage, ConfirmDialog, contextQuery, EligibilityList, EmployeePicker, EventBadges, Notice, ReadOnly, ResourceError, SessionOptions, SessionTable, useDate, useEmployeeContext, useEventTranslation, useMutation, useRead } from './shared';
import { ParticipationControls } from './ParticipationControls';
import type { CareerEvent, CareerProfile, HistoryRecord, Skill } from './types';

function useEventHistory(employeeId: string, eventId: string) {
  const [version, setVersion] = useState(0); const [result, setResult] = useState<{ data?: HistoryRecord[]; loading: boolean; error?: Error }>({ loading: !!employeeId });
  useEffect(() => {
    const controller = new AbortController();
    if (!employeeId) { setResult({ data: [], loading: false }); return () => controller.abort(); }
    setResult({ loading: true });
    async function read() {
      const found: HistoryRecord[] = []; let page = 1; let total = Infinity;
      while ((page - 1) * 100 < total) {
        const response = await api<HistoryRecord[]>(`/employees/${encodeURIComponent(employeeId)}/history?page=${page}&limit=100`, { signal: controller.signal });
        if (controller.signal.aborted) return;
        found.push(...response.data.filter(item => item.eventId === eventId));
        total = response.meta?.total ?? response.data.length;
        if (!response.data.length) break;
        page++;
      }
      if (!controller.signal.aborted) setResult({ data: found, loading: false });
    }
    void read().catch(error => { if (!controller.signal.aborted) setResult({ loading: false, error }); });
    return () => controller.abort();
  }, [employeeId, eventId, version]);
  return { ...result, reload: () => setVersion(value => value + 1) };
}

export function EventPage({ session, eventId, employeeId: supplied }: { session: Session; eventId: string; employeeId?: string }) {
  const context = useEmployeeContext(session, supplied);
  return <EventContent key={`${eventId}:${context.employeeId}`} session={session} eventId={eventId} employeeId={context.employeeId} onChoose={context.choose} />;
}
function EventContent({ session, eventId, employeeId, onChoose }: { session: Session; eventId: string; employeeId: string; onChoose: (id: string) => void }) {
  const c = useCareerCopy(); const date = useDate(); const event = useRead<CareerEvent>(`/events/${encodeURIComponent(eventId)}${contextQuery(employeeId)}`); const profile = useRead<CareerProfile>(employeeId ? `/employees/${encodeURIComponent(employeeId)}` : null); const skills = useRead<Skill[]>('/skills'); const history = useEventHistory(employeeId, eventId); const mutation = useMutation(session);
  const [selectedSession, setSelectedSession] = useState(''); const [enrollment, setEnrollment] = useState<'enroll' | 'waitlist' | null>(null); const [saved, setSaved] = useState(false); const [choosePerson, setChoosePerson] = useState(false);
  const translated = useEventTranslation(eventId);
  useEffect(() => { const item = event.data; if (!item) return; setSelectedSession(current => item.sessions.some(session => session.id === current && session.future) ? current : item.eligibility?.sessionId ?? item.waitlistEligibility?.sessionId ?? ''); }, [event.data]);
  const refresh = () => { event.reload(); history.reload(); profile.reload(); setSaved(true); };
  const names = Object.fromEntries((skills.data ?? []).map(skill => [skill.id, skill.name])); const editable = canEdit(session, employeeId);
  if (event.loading) return <Loading />;
  if (event.error) return <ResourceError error={event.error} retry={event.reload} />;
  if (!event.data) return <EmptyState title={c.empty} />;
  const item = { ...event.data, title: translated.translation?.title ?? event.data.title, description: translated.translation?.description ?? event.data.description }; const chosen = item.sessions.find(session => session.id === selectedSession); const hasSession = item.format === 'self_paced' || (chosen?.future ?? false); const hasCapacity = item.format === 'self_paced' || chosen?.available === null || (chosen?.available ?? 0) > 0;
  const canEnroll = editable && item.eligibility?.eligible && hasSession && hasCapacity && !history.loading && !history.error;
  const canWait = editable && item.format !== 'self_paced' && item.waitlistEligibility?.eligible && hasSession && !hasCapacity && !history.loading && !history.error;
  return <div className="career-page"><Button asChild variant="ghost" size="small"><Link href={`/events${contextQuery(employeeId)}`}><ArrowLeft size={16} />{c.catalog}</Link></Button><Heading title={item.title} subtitle={`${item.eventId} · ${item.durationHours} ${c.hours}`} action={canManage(session) && <Button variant="secondary" asChild><Link href={`/events/${encodeURIComponent(eventId)}/edit${contextQuery(employeeId)}`}><Pencil size={16} />{c.editEvent}</Link></Button>} /><EventBadges event={item} />{!translated.loading && !translated.translation && <small className="career-muted">{c.sourceText}</small>}{saved && <Notice success>{c.saved}</Notice>}
    <div className="career-event-detail"><div className="career-stack"><section className="career-card"><p className="career-description">{item.description}</p><h2>{c.audience}</h2><div className="career-tags">{item.targetRoles.map(role => <Badge key={role}>{role}</Badge>)}{item.targetGrades.map(grade => <Badge key={grade}>{grade}</Badge>)}</div></section><section className="career-card"><h2>{c.effects}</h2>{skills.error && <ResourceError error={skills.error} retry={skills.reload} />}{item.effects.length ? <ul className="career-fact-list">{item.effects.map(effect => <li key={effect.skillId}><strong>{names[effect.skillId] ?? effect.skillId}</strong><span>+{effect.gain} · {c.maxLevel} {effect.maxLevel}</span></li>)}</ul> : <p className="career-muted">{c.noEffects}</p>}<h2>{c.prerequisites}</h2>{item.prerequisites.length ? <ul className="career-fact-list">{item.prerequisites.map(prerequisite => <li key={prerequisite.skillId}><strong>{names[prerequisite.skillId] ?? prerequisite.skillId}</strong><span>{c.minLevel} {prerequisite.minLevel}</span></li>)}</ul> : <p className="career-muted">{c.noPrerequisites}</p>}</section>{item.format !== 'self_paced' && <section className="career-card"><h2>{c.sessions}</h2><p className="career-muted">{c.snapshotHelp}</p>{item.sessions.length ? <SessionTable sessions={item.sessions} /> : <EmptyState title={c.NO_FUTURE_SESSION} />}</section>}</div>
    <aside className="career-stack"><section className="career-card career-enrollment"><h2>{c.participation}</h2>{profile.data && <div className="career-person-context"><div><strong>{profile.data.name}</strong><small>{c.asOf}: {date(profile.data.asOfDate)}</small></div></div>}{profile.error && <ResourceError error={profile.error} retry={profile.reload} />}{!employeeId ? <><p>{c.chooseEmployee}</p><EmployeePicker onChoose={onChoose} /></> : <>{!editable && <ReadOnly />}<EligibilityList eligibility={item.eligibility} names={names} />{editable && item.format !== 'self_paced' && <SessionOptions event={item} value={selectedSession} onChange={setSelectedSession} allowFull />}{editable && <div className="career-actions"><Button disabled={!canEnroll || mutation.busy} onClick={() => { mutation.clear(); setEnrollment('enroll'); }}>{c.enroll}</Button>{canWait && <Button variant="secondary" disabled={mutation.busy} onClick={() => { mutation.clear(); setEnrollment('waitlist'); }}>{c.waitlist}</Button>}</div>}{session.user.role !== 'employee' && <Button variant="ghost" size="small" onClick={() => setChoosePerson(value => !value)}>{c.changeEmployee}</Button>}{choosePerson && <EmployeePicker onChoose={id => { onChoose(id); setChoosePerson(false); }} />}</>}</section>
    {employeeId && <section className="career-card"><h2>{c.history}</h2>{history.loading ? <Loading /> : history.error ? <ResourceError error={history.error} retry={history.reload} /> : !history.data?.length ? <p className="career-muted">{c.noHistory}</p> : <div className="career-history-list">{history.data.map(record => <article key={record.id} className="career-event-participation"><div className="career-card-heading"><Badge tone={record.status === 'completed' ? 'green' : 'neutral'}>{label(c, record.status)}</Badge><small>{date(record.date)}</small></div><p className="career-muted">{c.completionPct}: {record.completionPct}%</p><ParticipationControls session={session} employeeId={employeeId} participation={record} event={item} asOfDate={profile.data?.asOfDate} onChanged={refresh} /></article>)}</div>}<Link className="career-text-link" href={`/development${contextQuery(employeeId)}`}>{c.development} →</Link></section>}</aside></div>
    <ConfirmDialog open={enrollment !== null} title={enrollment === 'waitlist' ? c.waitlist : c.enroll} busy={mutation.busy} error={mutation.error} onClose={() => setEnrollment(null)} onConfirm={async () => { const response = await mutation.run('POST', '/participations', { employeeId, eventId, ...(item.format !== 'self_paced' ? { sessionId: selectedSession } : {}), joinWaitlist: enrollment === 'waitlist' }); if (response) { setEnrollment(null); refresh(); } }}><p><strong>{item.title}</strong></p>{chosen && <p>{date(chosen.date)}</p>}<p>{enrollment === 'waitlist' ? c.waitlistConfirm : c.enrollConfirm}</p></ConfirmDialog>
  </div>;
}
