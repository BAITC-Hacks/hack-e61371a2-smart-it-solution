import { useState } from 'react';
import type { Session } from '../../api';
import { Button, Loading } from '../../components/ui';
import { label, useCareerCopy } from './copy';
import { canEdit, canManage, ConfirmDialog, contextQuery, Notice, ResourceError, SessionOptions, useMutation, useRead } from './shared';
import type { CareerEvent, Participation, ParticipationStatus } from './types';

type Action = 'start' | 'complete' | 'drop' | 'reschedule' | 'correct';
const correctionStatuses: ParticipationStatus[] = ['completed', 'in_progress', 'dropped', 'no_show', 'declined', 'overdue'];
export function ParticipationControls({ session, employeeId, participation, event: suppliedEvent, asOfDate, onChanged }: { session: Session; employeeId: string; participation: Participation; event?: CareerEvent; asOfDate?: string; onChanged: () => void }) {
  const c = useCareerCopy(); const mutation = useMutation(session); const [action, setAction] = useState<Action | null>(null);
  const [sessionId, setSessionId] = useState(''); const [score, setScore] = useState(''); const [rating, setRating] = useState(''); const [status, setStatus] = useState<ParticipationStatus>('completed'); const [reason, setReason] = useState(''); const [date, setDate] = useState(''); const [pct, setPct] = useState('0');
  const eventResult = useRead<CareerEvent>(action && !suppliedEvent ? `/events/${encodeURIComponent(participation.eventId)}${contextQuery(employeeId)}` : null);
  const event = suppliedEvent ?? eventResult.data; const selectedSession = event?.sessions.find(item => item.id === participation.sessionId);
  const future = participation.sessionId ? selectedSession?.future !== false : false;
  const allowed = canEdit(session, employeeId); const active = ['registered', 'in_progress', 'waitlisted'].includes(participation.status);
  const open = (next: Action) => { mutation.clear(); setAction(next); setSessionId(''); setScore(participation.score === null ? '' : String(participation.score)); setRating(participation.feedbackRating === null ? '' : String(participation.feedbackRating)); setStatus(correctionStatuses.includes(participation.status) ? participation.status : 'completed'); setReason(''); setDate(participation.date); setPct(String(participation.completionPct)); };
  if (!allowed) return null;
  const title = action ? label(c, action) : '';
  const blocked = (action === 'start' || action === 'complete') && future;
  return <><div className="career-actions career-participation-controls">
    {participation.status === 'registered' && <Button size="small" variant="secondary" disabled={suppliedEvent ? future : false} onClick={() => open('start')}>{c.start}</Button>}
    {['registered', 'in_progress'].includes(participation.status) && <Button size="small" disabled={suppliedEvent ? future : false} onClick={() => open('complete')}>{c.complete}</Button>}
    {active && <Button size="small" variant="ghost" onClick={() => open('drop')}>{c.drop}</Button>}
    {participation.sessionId && ['registered', 'waitlisted'].includes(participation.status) && <Button size="small" variant="secondary" onClick={() => open('reschedule')}>{c.reschedule}</Button>}
    {canManage(session) && <Button size="small" variant="ghost" onClick={() => open('correct')}>{c.correct}</Button>}
  </div>{suppliedEvent && future && ['registered', 'in_progress'].includes(participation.status) && <p className="career-muted">{c.cannotStart}</p>}
  <ConfirmDialog open={action !== null} title={title} busy={mutation.busy} error={mutation.error} disabled={eventResult.loading || !!eventResult.error || blocked || (action === 'reschedule' && !sessionId)} onClose={() => setAction(null)} onConfirm={async () => {
    if (!action) return;
    const body = action === 'reschedule' ? { sessionId } : action === 'correct' ? { status, reason: reason.trim(), ...(date ? { date } : {}), completionPct: Number(pct), ...(score !== '' ? { score: Number(score) } : {}), ...(rating !== '' ? { feedbackRating: Number(rating) } : {}) } : action === 'complete' ? { ...(score !== '' ? { score: Number(score) } : {}), ...(rating !== '' ? { feedbackRating: Number(rating) } : {}) } : {};
    const response = await mutation.run(action === 'correct' ? 'PATCH' : 'POST', `/participations/${participation.id}${action === 'correct' ? '' : `/${action}`}`, body);
    if (response) { setAction(null); onChanged(); }
  }}>
    <p>{action === 'correct' ? c.correctionHelp : action === 'complete' ? c.completeHelp : c.confirmStatus}</p>
    {eventResult.loading && <Loading />}{eventResult.error && <ResourceError error={eventResult.error} retry={eventResult.reload} />}{blocked && <Notice>{c.cannotStart}</Notice>}
    {action === 'reschedule' && event && <SessionOptions event={event} value={sessionId} onChange={setSessionId} excludeId={participation.sessionId} />}
    {action === 'correct' && <><label className="career-field">{c.status}<select value={status} onChange={e => setStatus(e.target.value as ParticipationStatus)}>{correctionStatuses.map(value => <option key={value} value={value}>{label(c, value)}</option>)}</select></label><label className="career-field">{c.correctionReason}<textarea aria-label={c.correctionReason} required minLength={5} maxLength={1000} value={reason} onChange={event => setReason(event.target.value)} /></label><label className="career-field">{c.date}<input type="date" max={asOfDate} value={date} onChange={event => setDate(event.target.value)} /></label><label className="career-field">{c.completionPct}<input type="number" required min={0} max={100} step={1} value={pct} onChange={event => setPct(event.target.value)} /></label></>}
    {(action === 'complete' || action === 'correct') && <div className="career-form-grid"><label className="career-field">{c.score}<input type="number" min={0} max={100} step={1} value={score} onChange={event => setScore(event.target.value)} /></label><label className="career-field">{c.rating}<input type="number" min={1} max={5} step={1} value={rating} onChange={event => setRating(event.target.value)} /></label></div>}
  </ConfirmDialog></>;
}
