import { useEffect, useState } from 'react';
import { Link } from 'wouter';
import { ArrowRight, ChevronLeft, ChevronRight, Search, ShieldCheck, Users, X } from 'lucide-react';
import { api, type Employee, type User } from '../api';
import { useI18n } from '../i18n';
import { Avatar, Badge, Button, EmptyState, ErrorState, Heading, Loading } from '../components/ui';
import { peopleCopy } from './people.copy';
import './people.css';

const PAGE_SIZE = 12;
type Result = { employees: Employee[]; total: number };

export function PeoplePage({ user }: { user: User }) {
  const { locale } = useI18n();
  const c = peopleCopy[locale];
  const [search, setSearch] = useState('');
  const [query, setQuery] = useState('');
  const [page, setPage] = useState(1);
  const [attempt, setAttempt] = useState(0);
  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>('loading');
  const [result, setResult] = useState<Result>({ employees: [], total: 0 });

  useEffect(() => {
    if (search.trim() === query) return;
    const timer = window.setTimeout(() => {
      setQuery(search.trim());
      setPage(1);
    }, 300);
    return () => window.clearTimeout(timer);
  }, [search, query]);

  useEffect(() => {
    const controller = new AbortController();
    setStatus('loading');
    const params = new URLSearchParams({ q: query, page: String(page), limit: String(PAGE_SIZE) });
    api<Employee[]>(`/employees?${params}`, { signal: controller.signal }).then(response => {
      if (controller.signal.aborted) return;
      const total = response.meta?.total ?? response.data.length;
      const lastPage = Math.max(1, Math.ceil(total / PAGE_SIZE));
      // Imports can reduce a filtered result set while the list is open.
      if (page > lastPage) {
        setPage(lastPage);
        return;
      }
      setResult({ employees: response.data, total });
      setStatus('ready');
    }).catch(() => {
      if (!controller.signal.aborted) setStatus('error');
    });
    return () => controller.abort();
  }, [query, page, attempt, user.id]);

  const title = user.role === 'employee' ? c.own : user.role === 'manager' ? c.team : c.people;
  const subtitle = user.role === 'employee' ? c.ownSub : user.role === 'manager' ? c.teamSub : c.peopleSub;
  const pageCount = Math.max(1, Math.ceil(result.total / PAGE_SIZE));
  const pending = status === 'loading' || search.trim() !== query;
  const clearSearch = () => { setSearch(''); setQuery(''); setPage(1); };

  return <div className="cq-people-page">
    <Heading title={title} subtitle={subtitle} />
    <section className="cq-people-panel" aria-label={c.profiles}>
      <div className="cq-people-toolbar">
        <div className="cq-people-count"><span className="cq-people-icon"><Users size={19} aria-hidden="true" /></span><h2>{c.profiles}</h2>{status === 'ready' && <span className="cq-people-count-number">{result.total.toLocaleString(locale)}</span>}</div>
        <div className="cq-people-search">
          <Search size={18} aria-hidden="true" />
          <input data-testid="people-search" type="search" maxLength={100} aria-label={c.search} placeholder={c.search} value={search} onChange={event => setSearch(event.target.value)} autoComplete="off" />
          {search && <button type="button" className="cq-people-clear" onClick={clearSearch} aria-label={c.clear}><X size={16} aria-hidden="true" /></button>}
        </div>
      </div>

      <div data-testid="people-list" className="cq-people-results" aria-busy={pending}>
        {status === 'loading' && <Loading />}
        {status === 'error' && <ErrorState message={c.loadError} retry={() => setAttempt(value => value + 1)} />}
        {status === 'ready' && result.employees.length === 0 && <EmptyState title={query ? c.noResults : c.noPeople} description={query ? c.noResultsSub : c.noPeopleSub} action={query ? <Button variant="secondary" onClick={clearSearch}>{c.clear}</Button> : undefined} />}
        {status === 'ready' && result.employees.length > 0 && <>
          <div className="cq-people-table-scroll">
            <table className="cq-people-table">
              <thead><tr><th scope="col">{c.employee}</th><th scope="col">{c.position}</th><th scope="col">{c.department}</th><th scope="col"><span className="cq-people-sr-only">{c.open}</span></th></tr></thead>
              <tbody>{result.employees.map(employee => <tr key={employee.id}>
                <td><div className="cq-people-person"><Avatar name={employee.name} /><div><Link className="cq-people-name" href={employee.id === user.employeeId ? '/profile' : `/people/${encodeURIComponent(employee.id)}`}>{employee.name}</Link><div className="cq-people-id">{employee.id}{employee.id === user.employeeId && <span className="cq-people-you">{c.you}</span>}</div></div></div></td>
                <td><div className="cq-people-position"><span>{employee.role}</span><Badge>{employee.grade || c.notSet}</Badge></div></td>
                <td><span className="cq-people-mobile-label">{c.department}</span><span className="cq-people-department">{employee.department || c.notSet}</span></td>
                <td className="cq-people-open-cell"><Link className="cq-people-open" href={employee.id === user.employeeId ? '/profile' : `/people/${encodeURIComponent(employee.id)}`} aria-label={`${c.open}: ${employee.name}`}><span>{c.open}</span><ArrowRight size={17} aria-hidden="true" /></Link></td>
              </tr>)}</tbody>
            </table>
          </div>
          <div className="cq-people-pagination">
            <p aria-live="polite">{c.shown} <strong>{(page - 1) * PAGE_SIZE + 1}–{Math.min(page * PAGE_SIZE, result.total)}</strong> {c.of} <strong>{result.total.toLocaleString(locale)}</strong></p>
            <nav className="cq-people-page-controls" aria-label={`${c.page} ${page} ${c.of} ${pageCount}`}>
              <Button data-testid="people-previous" variant="secondary" size="small" disabled={page <= 1 || pending} onClick={() => setPage(value => value - 1)} aria-label={c.previous}><ChevronLeft size={16} aria-hidden="true" /></Button>
              <span>{c.page} <strong>{page}</strong> {c.of} {pageCount}</span>
              <Button data-testid="people-next" variant="secondary" size="small" disabled={page >= pageCount || pending} onClick={() => setPage(value => value + 1)} aria-label={c.next}><ChevronRight size={16} aria-hidden="true" /></Button>
            </nav>
          </div>
        </>}
      </div>
    </section>
    <p className="cq-people-access-note"><ShieldCheck size={16} aria-hidden="true" />{c.accessNote}</p>
  </div>;
}
