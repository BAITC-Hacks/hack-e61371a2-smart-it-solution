import { useEffect, useState } from 'react';
import { Link } from 'wouter';
import type { Session } from '../../api';
import { Badge, EmptyState, Heading, Loading } from '../../components/ui';
import { label, useCareerCopy } from './copy';
import { canEdit, contextQuery, EmployeePicker, Pager, ReadOnly, ResourceError, useDate, useEmployeeContext, useRead } from './shared';
import { ParticipationControls } from './ParticipationControls';
import { statuses, type CareerProfile, type HistoryRecord } from './types';

export function HistoryPage({ session, employeeId: supplied }: { session: Session; employeeId?: string }) {
  const c = useCareerCopy(); const context = useEmployeeContext(session, supplied);
  return <div className="career-page"><Heading title={c.history} subtitle={c.historySub} />{context.employeeId ? <HistoryContent key={context.employeeId} session={session} employeeId={context.employeeId} /> : <EmployeePicker onChoose={context.choose} />}</div>;
}
function HistoryContent({ session, employeeId }: { session: Session; employeeId: string }) {
  const c = useCareerCopy(); const date = useDate(); const [mandatory, setMandatory] = useState(false); const [status, setStatus] = useState(''); const [page, setPage] = useState(1);
  const profile = useRead<CareerProfile>(`/employees/${encodeURIComponent(employeeId)}`);
  const params = new URLSearchParams({ mandatory: String(mandatory), page: String(page), limit: '12' }); if (status) params.set('status', status);
  const history = useRead<HistoryRecord[]>(`/employees/${encodeURIComponent(employeeId)}/history?${params}`);
  useEffect(() => { const pages = Math.max(1, Math.ceil((history.meta?.total ?? 0) / 12)); if (!history.loading && !history.error && page > pages) setPage(pages); }, [history.meta?.total, history.loading, history.error, page]);
  const refresh = () => { history.reload(); profile.reload(); };
  return <>{profile.data && <div className="career-person-context"><div><small>{c.selectedEmployee}</small><strong>{profile.data.name}</strong></div><Link href={`/development${contextQuery(employeeId)}`}>{c.development}</Link></div>}{profile.error && <ResourceError error={profile.error} retry={profile.reload} />}{!canEdit(session, employeeId) && <ReadOnly />}
    <section className="career-card"><div className="career-card-heading"><div className="career-tabs" role="group" aria-label={c.history}><button aria-pressed={!mandatory} onClick={() => { setMandatory(false); setPage(1); }}>{c.voluntary}</button><button aria-pressed={mandatory} onClick={() => { setMandatory(true); setPage(1); }}>{c.mandatory}</button></div><label className="career-field">{c.status}<select value={status} onChange={event => { setStatus(event.target.value); setPage(1); }}><option value="">{c.all}</option>{statuses.map(value => <option key={value} value={value}>{label(c, value)}</option>)}</select></label></div>
    {history.loading ? <Loading /> : history.error ? <ResourceError error={history.error} retry={history.reload} /> : !history.data?.length ? <EmptyState title={c.empty} description={c.noHistory} /> : <div className="career-history-list">{history.data.map(record => <article key={record.id} className="career-history-record"><div className="career-card-heading"><div><Badge tone={record.mandatory ? 'amber' : 'green'}>{record.mandatory ? c.mandatory : c.voluntary}</Badge><h3><Link href={`/events/${encodeURIComponent(record.eventId)}${contextQuery(employeeId)}`}>{record.title}</Link></h3></div><Badge tone={record.status === 'completed' ? 'green' : 'neutral'}>{label(c, record.status)}</Badge></div><dl className="career-inline-details"><div><dt>{c.date}</dt><dd>{date(record.date)}</dd></div><div><dt>{c.completionPct}</dt><dd>{record.completionPct}%</dd></div>{record.score !== null && <div><dt>{c.score.replace(/\s*\(.*\)/, '')}</dt><dd>{record.score}</dd></div>}{record.feedbackRating !== null && <div><dt>{c.rating.replace(/\s*\(.*\)/, '')}</dt><dd>{record.feedbackRating} / 5</dd></div>}</dl><ParticipationControls session={session} employeeId={employeeId} participation={record} asOfDate={profile.data?.asOfDate} onChanged={refresh} /></article>)}</div>}
    <Pager page={page} total={history.meta?.total ?? 0} limit={12} busy={history.loading} onChange={setPage} /></section>
  </>;
}
