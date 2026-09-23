import { useEffect, useRef, useState } from 'react';
import { Link, Redirect, Route, Switch, useLocation } from 'wouter';
import { ShieldX } from 'lucide-react';
import { api, ApiError, type Profile, type Session } from './api';
import { appCopy } from './app.copy';
import { useI18n } from './i18n';
import { Brand, Button, EmptyState, ErrorState, Loading } from './components/ui';
import { Shell } from './components/Shell';
import { LoginPage } from './pages/LoginPage';
import { WorkspacePage } from './pages/WorkspacePage';
import { PeoplePage } from './pages/PeoplePage';
import { ProfilePage } from './pages/ProfilePage';
import { AccessPage } from './pages/AccessPage';
import { ImportsPage } from './pages/ImportsPage';

export function App() {
  const { locale, t, applyProfileLanguage } = useI18n(); const copy = appCopy[locale];
  const [session, setSession] = useState<Session | null | undefined>(undefined);
  const [bootError, setBootError] = useState(''); const [bootRetry, setBootRetry] = useState(0);
  const [notice, setNotice] = useState<'expired' | 'logout'>(); const [error, setError] = useState(''); const [busy, setBusy] = useState(false);
  const [revision, setRevision] = useState(0); const [location, navigate] = useLocation();
  const sessionRef = useRef(session); sessionRef.current = session;
  const returnTo = useRef(location !== '/login' ? location : '/'); const logoutLock = useRef(false);
  useEffect(() => {
    const controller = new AbortController(); setBootError(''); setSession(undefined);
    api<Session>('/auth/me', { signal: controller.signal }).then(({ data }) => { if (!controller.signal.aborted) setSession(data); }).catch(e => {
      if (controller.signal.aborted) return;
      if (e instanceof ApiError && e.status === 401) setSession(null); else setBootError((e as Error).message);
    });
    return () => controller.abort();
  }, [bootRetry]);
  useEffect(() => {
    const expired = () => { if (sessionRef.current) { setNotice('expired'); returnTo.current = location; } setSession(null); setError(''); };
    window.addEventListener('session-expired', expired);
    return () => window.removeEventListener('session-expired', expired);
  }, [location]);
  useEffect(() => {
    if (session === null && location !== '/login') { returnTo.current = location; navigate('/login', { replace: true }); }
    if (session && location === '/login') navigate('/', { replace: true });
  }, [session, location, navigate]);
  useEffect(() => {
    if (!session?.user.employeeId) return;
    const controller = new AbortController();
    api<Profile>(`/employees/${encodeURIComponent(session.user.employeeId)}`, { signal: controller.signal }).then(({ data }) => { if (!controller.signal.aborted) applyProfileLanguage(data.language); }).catch(() => { /* The profile page reports its own errors; language keeps the current preference. */ });
    return () => controller.abort();
  }, [session?.user.id, session?.user.employeeId, applyProfileLanguage]);
  function login(next: Session) {
    setSession(next); setNotice(undefined); setError('');
    const path = returnTo.current;
    navigate(path.startsWith('/') && !path.startsWith('//') && path !== '/login' ? path : '/', { replace: true });
  }
  async function logout() {
    if (!session || logoutLock.current) return; logoutLock.current = true; setBusy(true); setError('');
    try { await api('/auth/logout', { method: 'POST', csrf: session.csrfToken }); setSession(null); setNotice('logout'); returnTo.current = '/'; navigate('/login', { replace: true }); }
    catch (e) { if (!(e instanceof ApiError && e.status === 401)) setError((e as Error).message); }
    finally { setBusy(false); logoutLock.current = false; }
  }
  if (session === undefined) return <div className="boot-screen"><Brand />{bootError ? <div className="boot-error"><h1>{copy.sessionFailure}</h1><p>{copy.sessionFailureHint}</p><ErrorState message={bootError} retry={() => setBootRetry(value => value + 1)} /></div> : <Loading />}</div>;
  if (!session) return <LoginPage onLogin={login} notice={notice} />;
  const { user } = session;
  return <Shell key={user.id} user={user} busy={busy} onLogout={() => void logout()}>{error && <ErrorState message={error} />}
    <Switch>
      <Route path="/"><WorkspacePage user={user} revision={revision} /></Route>
      <Route path="/login"><Redirect to="/" /></Route>
      <Route path="/profile"><ProfilePage id={user.employeeId ?? ''} user={user} /></Route>
      <Route path="/people"><PeoplePage user={user} /></Route>
      <Route path="/people/:id">{params => <ProfilePage id={params.id} user={user} />}</Route>
      <Route path="/access"><AccessPage user={user} /></Route>
      <Route path="/admin/imports">{user.role === 'admin' ? <ImportsPage session={session} onDataChanged={() => setRevision(value => value + 1)} /> : <div className="card denied-page"><ShieldX size={35} aria-hidden="true" /><EmptyState title={copy.noAccessTitle} description={copy.noAccessText} action={<Button asChild><Link href="/">{t.home}</Link></Button>} /></div>}</Route>
      <Route><div className="card"><EmptyState title={t.notFound} description={copy.notFoundText} action={<Button asChild><Link href="/">{t.home}</Link></Button>} /></div></Route>
    </Switch>
  </Shell>;
}
