import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { useSearchParams } from 'wouter';
import { CheckCircle2, ChevronLeft, ChevronRight, Search, ShieldCheck } from 'lucide-react';
import { api, ApiError, type ApiResponse, type Employee, type PageMeta, type Session } from '../../api';
import { Avatar, Badge, Button, EmptyState, ErrorState, Loading } from '../../components/ui';
import { useI18n } from '../../i18n';
import { useCareerCopy, label, reasonText } from './copy';
import type { CareerEvent, Eligibility, EventSession, EventTranslation } from './types';
import './career.css';

export function useRead<T, M = PageMeta>(path: string | null) {
  const [version, setVersion] = useState(0);
  const [result, setResult] = useState<{ path: string | null; data?: T; meta?: M; error?: Error; loading: boolean }>({ path, loading: !!path });
  useEffect(() => {
    if (!path) { setResult({ path, loading: false }); return; }
    const controller = new AbortController();
    setResult({ path, loading: true });
    api<T, M>(path, { signal: controller.signal }).then(response => {
      if (!controller.signal.aborted) setResult({ path, ...response, loading: false });
    }).catch(error => { if (!controller.signal.aborted) setResult({ path, error, loading: false }); });
    return () => controller.abort();
  }, [path, version]);
  const current = result.path === path ? result : { path, loading: !!path };
  return { ...current, reload: () => setVersion(value => value + 1) };
}

export function useMutation(session: Session) {
  const busyRef = useRef(false);
  const pending = useRef<{ signature: string; key: string } | null>(null);
  const mounted = useRef(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<Error>();
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  async function run<T = unknown>(method: string, path: string, body: unknown = {}, options: { timeoutMs?: number } = {}): Promise<ApiResponse<T> | undefined> {
    if (busyRef.current) return;
    busyRef.current = true; setBusy(true); setError(undefined);
    const signature = JSON.stringify([session.user.id, method, path, body]);
    const key = pending.current?.signature === signature ? pending.current.key : crypto.randomUUID();
    pending.current = { signature, key };
    try {
      const response = await api<T>(path, { method, body, csrf: session.csrfToken, idempotencyKey: key, timeoutMs: options.timeoutMs });
      pending.current = null;
      return response;
    } catch (caught) { if (mounted.current) setError(caught instanceof Error ? caught : new Error(String(caught))); }
    finally { busyRef.current = false; if (mounted.current) setBusy(false); }
  }
  return { busy, error, run, clear: () => setError(undefined) };
}

export function useEmployeeContext(session: Session, supplied?: string) {
  const [params, setParams] = useSearchParams();
  const employeeId = supplied ?? params.get('employeeId') ?? session.user.employeeId ?? '';
  return { employeeId, choose: (id: string) => setParams(previous => { const next = new URLSearchParams(previous); next.set('employeeId', id); return next; }) };
}
export function canEdit(session: Session, employeeId: string) { return Boolean(employeeId) && (session.user.employeeId === employeeId || session.user.role === 'hr' || session.user.role === 'admin'); }
export function canManage(session: Session) { return session.user.role === 'hr' || session.user.role === 'admin'; }
export function contextQuery(employeeId?: string) { return employeeId ? `?employeeId=${encodeURIComponent(employeeId)}` : ''; }
export function useDate() { const { locale } = useI18n(); return (value: string) => { const date = new Date(value.length === 10 ? `${value}T00:00:00` : value); return Number.isNaN(date.getTime()) ? '—' : new Intl.DateTimeFormat(locale === 'en' ? 'en-GB' : locale, { day: 'numeric', month: 'short', year: 'numeric' }).format(date); }; }
export function useDebounce(value: string, delay = 300) { const [debounced, setDebounced] = useState(value); useEffect(() => { const timer = window.setTimeout(() => setDebounced(value), delay); return () => clearTimeout(timer); }, [value, delay]); return debounced; }

export function ResourceError({ error, retry }: { error: Error; retry?: () => void }) {
  const c = useCareerCopy();
  return error instanceof ApiError && error.status === 404 ? <EmptyState title={c.unavailable} description={c.unavailableText} action={retry && <Button variant="secondary" onClick={retry}>{c.retry}</Button>} /> : <ErrorState message={error.message} retry={retry} />;
}
export function Notice({ children, success = false }: { children: ReactNode; success?: boolean }) { return <div className={`career-notice${success ? ' career-notice-success' : ''}`} role={success ? 'status' : undefined}>{success ? <CheckCircle2 size={17} aria-hidden="true" /> : <ShieldCheck size={17} aria-hidden="true" />}<div>{children}</div></div>; }
export function ReadOnly() { const c = useCareerCopy(); return <Notice>{c.readOnly}</Notice>; }
export function Pager({ page, total, limit, busy, onChange }: { page: number; total: number; limit: number; busy?: boolean; onChange: (page: number) => void }) {
  const c = useCareerCopy(); const pages = Math.max(1, Math.ceil(total / limit));
  return <div className="career-pager"><span aria-live="polite">{c.total}: {total}</span><nav aria-label={c.page}><Button size="small" variant="secondary" disabled={busy || page <= 1} onClick={() => onChange(page - 1)} aria-label={c.previous}><ChevronLeft size={16} /></Button><span>{c.page} {page} / {pages}</span><Button size="small" variant="secondary" disabled={busy || page >= pages} onClick={() => onChange(page + 1)} aria-label={c.next}><ChevronRight size={16} /></Button></nav></div>;
}
export function ConfirmDialog({ open, title, children, busy, error, onClose, onConfirm, confirmLabel, disabled }: { open: boolean; title: string; children?: ReactNode; busy?: boolean; error?: Error; onClose: () => void; onConfirm: () => void | Promise<void>; confirmLabel?: string; disabled?: boolean }) {
  const c = useCareerCopy(); const ref = useRef<HTMLDialogElement>(null); const titleId = useId();
  useEffect(() => { const dialog = ref.current; if (!dialog) return; if (open && !dialog.open) dialog.showModal(); else if (!open && dialog.open) dialog.close(); }, [open]);
  return <dialog ref={ref} className="career-dialog" aria-labelledby={titleId} onCancel={event => { event.preventDefault(); if (!busy) onClose(); }}><form onSubmit={event => { event.preventDefault(); if (!busy && !disabled) void onConfirm(); }}><h2 id={titleId}>{title}</h2><div className="career-dialog-body">{children}</div>{error && <ResourceError error={error} />}<div className="career-actions"><Button variant="secondary" disabled={busy} onClick={onClose} autoFocus>{c.cancel}</Button><Button type="submit" disabled={busy || disabled}>{busy ? c.saving : confirmLabel ?? c.confirm}</Button></div></form></dialog>;
}
export function EmployeePicker({ onChoose }: { onChoose: (id: string) => void }) {
  const c = useCareerCopy(); const [search, setSearch] = useState(''); const query = useDebounce(search.trim()); const [page, setPage] = useState(1);
  useEffect(() => setPage(1), [query]);
  const result = useRead<Employee[]>(`/employees?q=${encodeURIComponent(query)}&page=${page}&limit=8`);
  return <section className="career-card"><h2>{c.chooseEmployee}</h2><label className="career-search"><Search size={17} aria-hidden="true" /><input type="search" maxLength={100} value={search} onChange={event => setSearch(event.target.value)} aria-label={c.employeeSearch} placeholder={c.employeeSearch} /></label>{result.loading ? <Loading /> : result.error ? <ResourceError error={result.error} retry={result.reload} /> : !result.data?.length ? <EmptyState title={c.empty} /> : <><div className="career-employee-list">{result.data.map(employee => <button type="button" key={employee.id} onClick={() => onChoose(employee.id)}><Avatar name={employee.name} /><span><strong>{employee.name}</strong><small>{employee.role} · {employee.grade}</small></span></button>)}</div><Pager page={page} total={result.meta?.total ?? 0} limit={8} onChange={setPage} /></>}</section>;
}
export function EligibilityList({ eligibility, names }: { eligibility?: Eligibility; names?: Record<string, string> }) { const c = useCareerCopy(); if (!eligibility) return null; return eligibility.eligible ? <Badge tone="green">{c.available}</Badge> : <div className="career-reasons"><strong>{c.unavailableEvent}</strong><ul>{eligibility.reasons.map(reason => <li key={reason}>{reasonText(c, reason, names)}</li>)}</ul></div>; }
export function SessionOptions({ event, value, onChange, allowFull = false, excludeId }: { event: CareerEvent; value: string; onChange: (value: string) => void; allowFull?: boolean; excludeId?: string | null }) {
  const c = useCareerCopy(); const date = useDate(); const items = event.sessions.filter(item => item.future && item.id !== excludeId && (allowFull || item.available === null || item.available > 0));
  return <label className="career-field">{c.selectSession}<select value={value} onChange={e => onChange(e.target.value)} required><option value="">—</option>{items.map(item => <option key={item.id} value={item.id}>{date(item.date)} · {c.seats}: {item.available ?? c.unlimited}</option>)}</select></label>;
}
export function SessionTable({ sessions }: { sessions: EventSession[] }) { const c = useCareerCopy(); const date = useDate(); return <div className="career-table-wrap"><table className="career-table"><thead><tr><th>{c.date}</th><th>{c.seats}</th></tr></thead><tbody>{sessions.map(item => <tr key={item.id}><td>{date(item.date)}{!item.future && <small className="career-muted">{c.pastSession}</small>}</td><td>{item.available ?? c.unlimited}</td></tr>)}</tbody></table></div>; }
export function EventBadges({ event }: { event: CareerEvent }) { const c = useCareerCopy(); return <div className="career-tags"><Badge>{label(c, event.type)}</Badge><Badge>{label(c, event.format)}</Badge><Badge tone={event.mandatory ? 'amber' : 'green'}>{event.mandatory ? c.mandatory : c.voluntary}</Badge>{!event.isActive && <Badge>{c.archived}</Badge>}</div>; }
export function useEventTranslation(eventId: string) { const { locale } = useI18n(); const resource = useRead<EventTranslation[]>(`/events/${encodeURIComponent(eventId)}/translations`); return { ...resource, translation: resource.data?.find(item => item.locale === locale) }; }
