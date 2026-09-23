import { useState, type FormEvent } from 'react';
import { Link, useSearch } from 'wouter';
import type { Session } from '../../api';
import { Button, EmptyState, Heading } from '../../components/ui';
import { useGrowthCopy } from './copy';
import { Field, MutationNotice, Panel, QueryState, Status, dateLabel, useMutation, useQuery } from './shared';
import type { MentorReview, Recognition, Skill } from './types';
import { Teams } from './Social';
import { RewardsAdmin } from './Rewards';
import './growth.css';

export type GrowthAdminSection = 'mentors' | 'thanks' | 'team' | 'rewards';
const sections: GrowthAdminSection[] = ['mentors','thanks','team','rewards'];
export function GrowthAdminPage({ session, initialSection = 'mentors' }: { session: Session; initialSection?: GrowthAdminSection }) {
  const { c } = useGrowthCopy(); const search = useSearch(); const chosen = new URLSearchParams(search).get('section'); const section = sections.includes(chosen as GrowthAdminSection) ? chosen as GrowthAdminSection : initialSection;
  if (!['hr','admin'].includes(session.user.role)) return <EmptyState title={c('noAccess')}/>;
  return <div className="growth-page"><Heading title={c('adminTitle')} subtitle={c('adminSub')}/><nav className="growth-nav" aria-label={c('adminTitle')}>{sections.map(item => <Link key={item} className={section === item ? 'is-selected' : ''} aria-current={section === item ? 'page' : undefined} href={`/admin/growth?section=${item}`}>{c(item)}</Link>)}</nav>{section === 'mentors' && <MentorModeration session={session}/>} {section === 'thanks' && <ThanksModeration session={session}/>} {section === 'team' && <Teams session={session}/>} {section === 'rewards' && <RewardsAdmin session={session}/>}</div>;
}

function MentorModeration({ session }: { session: Session }) {
  const { c } = useGrowthCopy(); const list = useQuery<MentorReview[]>('/admin/mentors'); const skills = useQuery<Skill[]>('/skills'); const mutation = useMutation(session);
  async function review(id: string, approved: boolean) { const result = await mutation.run(`/admin/mentors/${encodeURIComponent(id)}`,{approved},'PATCH'); if (result) list.refresh(); }
  return <Panel title={c('mentors')} action={<Button size="small" variant="ghost" onClick={list.refresh}>{c('refresh')}</Button>}><p className="growth-note">{c('mentorNote')}</p><MutationNotice mutation={mutation}/><QueryState query={list}>{items => <div className="growth-list">{items.map(item => <article className="growth-item" key={item.employee_id}><div className="growth-row"><strong>{item.full_name}</strong><span>{item.approved_at ? c('approved') : c('awaitingApproval')}</span></div><p>{item.headline}</p><p>{item.skill_ids.map(id => skills.data?.find(skill => skill.id === id)?.name ?? id).join(', ')}</p><p>{c('capacity')}: {item.capacity} · {c('publishConsent')}: {item.enabled ? '✓' : '—'}</p><div className="growth-actions"><Button size="small" disabled={mutation.busy || !item.enabled || !!item.approved_at} onClick={() => void review(item.employee_id,true)}>{c('accept')}</Button><Button size="small" variant="secondary" disabled={mutation.busy} onClick={() => void review(item.employee_id,false)}>{c('decline')}</Button></div></article>)}</div>}</QueryState></Panel>;
}

function ThanksModeration({ session }: { session: Session }) {
  const { c, locale } = useGrowthCopy(); const list = useQuery<Recognition[]>('/admin/recognitions'); const mutation = useMutation(session); const [selected,setSelected] = useState(''); const [note,setNote] = useState('');
  async function moderate(event: FormEvent) { event.preventDefault(); if (!selected) return; const result = await mutation.run(`/admin/recognitions/${encodeURIComponent(selected)}`,{note},'PATCH'); if (result) { setSelected(''); setNote(''); list.refresh(); } }
  return <Panel title={c('thanks')} action={<Button size="small" variant="ghost" onClick={list.refresh}>{c('refresh')}</Button>}><p className="growth-note">{c('reportNote')}</p><MutationNotice mutation={mutation}/><QueryState query={list}>{items => <div className="growth-list">{items.map(item => <article className="growth-item" key={item.id}><div className="growth-row"><strong>{item.senderName ?? item.senderId} → {item.recipientName ?? item.recipientId}</strong><Status value={item.status}/></div><p>{item.message}</p><small>{dateLabel(item.createdAt,locale)}</small><div className="growth-actions"><Button variant="secondary" size="small" onClick={() => { setSelected(item.id); setNote(''); }}>{c('hide')}</Button></div>{selected === item.id && <form className="growth-form growth-inline-confirm" onSubmit={event => void moderate(event)}><fieldset disabled={mutation.busy}><Field label={c('moderationNote')}><textarea required maxLength={1000} value={note} onChange={event => setNote(event.target.value)}/></Field><div className="growth-actions"><Button type="submit">{mutation.busy ? c('busy') : c('hide')}</Button><Button variant="ghost" onClick={() => setSelected('')}>{c('cancel')}</Button></div></fieldset></form>}</article>)}</div>}</QueryState></Panel>;
}
