import { lazy, Suspense, useEffect, useRef, useState } from 'react';
import { Link, Redirect, Route, Switch, useLocation, useSearch } from 'wouter';
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
import { PageBoundary } from './components/PageBoundary';
import { safeInternalLink } from './features/platform/common';
import './features/platform/platform.css';
const DevelopmentPage = lazy(() => import('./features/career/DevelopmentPage').then(m => ({default:m.DevelopmentPage})));
const EventsPage = lazy(() => import('./features/career/EventsPage').then(m => ({default:m.EventsPage})));
const EventPage = lazy(() => import('./features/career/EventPage').then(m => ({default:m.EventPage})));
const EventsAdminPage = lazy(() => import('./features/career/EventsAdminPage').then(m => ({default:m.EventsAdminPage})));
const HistoryPage = lazy(() => import('./features/career/HistoryPage').then(m => ({default:m.HistoryPage})));
const GrowthPage = lazy(() => import('./features/growth/GrowthPage').then(m => ({default:m.GrowthPage})));
const GrowthAdminPage = lazy(() => import('./features/growth/GrowthAdminPage').then(m => ({default:m.GrowthAdminPage})));
const GuidePage = lazy(() => import('./features/guide/GuidePage').then(m => ({default:m.GuidePage})));
const GuideArticlePage = lazy(() => import('./features/guide/GuideArticlePage').then(m => ({default:m.GuideArticlePage})));
const GuideAdminPage = lazy(() => import('./features/guide/GuideAdminPage').then(m => ({default:m.GuideAdminPage})));
const AssistantPage = lazy(() => import('./features/guide/AssistantPage').then(m => ({default:m.AssistantPage})));
const SettingsPage = lazy(() => import('./features/administration/SettingsPage').then(m => ({default:m.SettingsPage})));
const HrPage = lazy(() => import('./features/platform/HrPage').then(m => ({default:m.HrPage})));
const NotificationsPage = lazy(() => import('./features/platform/NotificationsPage').then(m => ({default:m.NotificationsPage})));

export function App() {
  const { locale, t, applyProfileLanguage } = useI18n(); const copy = appCopy[locale];
  const [session, setSession] = useState<Session | null | undefined>(undefined);
  const [bootError, setBootError] = useState(''); const [bootRetry, setBootRetry] = useState(0);
  const [notice, setNotice] = useState<'expired' | 'logout'>(); const [error, setError] = useState(''); const [busy, setBusy] = useState(false);
  const [revision, setRevision] = useState(0); const [location, navigate] = useLocation(); const search = useSearch();
  const currentPath = location + (search ? `?${search}` : '') + window.location.hash;
  const sessionRef = useRef(session); sessionRef.current = session;
  const returnTo = useRef(location !== '/login' ? currentPath : '/'); const logoutLock = useRef(false);
  useEffect(() => {
    const controller = new AbortController(); setBootError(''); setSession(undefined);
    api<Session>('/auth/me', { signal: controller.signal }).then(({ data }) => { if (!controller.signal.aborted) setSession(data); }).catch(e => {
      if (controller.signal.aborted) return;
      if (e instanceof ApiError && e.status === 401) setSession(null); else setBootError((e as Error).message);
    });
    return () => controller.abort();
  }, [bootRetry]);
  useEffect(() => {
    const expired = () => { if (sessionRef.current) { setNotice('expired'); returnTo.current = currentPath; } setSession(null); setError(''); };
    window.addEventListener('session-expired', expired);
    return () => window.removeEventListener('session-expired', expired);
  }, [currentPath]);
  useEffect(() => {
    if (session === null && location !== '/login') { returnTo.current = currentPath; navigate('/login', { replace: true }); }
    if (session && location === '/login') navigate('/', { replace: true });
  }, [session, location, currentPath, navigate]);
  useEffect(() => {
    if (!session?.user.employeeId) return;
    const controller = new AbortController();
    api<Profile>(`/employees/${encodeURIComponent(session.user.employeeId)}`, { signal: controller.signal }).then(({ data }) => { if (!controller.signal.aborted) applyProfileLanguage(data.language); }).catch(() => { /* The profile page reports its own errors; language keeps the current preference. */ });
    return () => controller.abort();
  }, [session?.user.id, session?.user.employeeId, applyProfileLanguage]);
  function login(next: Session) {
    setSession(next); setNotice(undefined); setError('');
    const path = safeInternalLink(returnTo.current);
    navigate(path.split(/[?#]/)[0] !== '/login' ? path : '/', { replace: true });
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
  const staff = user.role === 'hr' || user.role === 'admin';
  const denied = <div className="card denied-page"><ShieldX size={35} aria-hidden="true" /><EmptyState title={copy.noAccessTitle} description={copy.noAccessText} action={<Button asChild><Link href="/">{t.home}</Link></Button>} /></div>;
  return <Shell key={user.id} user={user} busy={busy} onLogout={() => void logout()}>{error && <ErrorState message={error} />}
    <PageBoundary key={location}><Suspense fallback={<Loading />}>
    <Switch>
      <Route path="/"><WorkspacePage user={user} revision={revision} /></Route>
      <Route path="/login"><Redirect to="/" /></Route>
      <Route path="/profile"><ProfilePage id={user.employeeId ?? ''} user={user} /></Route>
      <Route path="/people"><PeoplePage user={user} /></Route>
      <Route path="/people/:id/development">{params => <DevelopmentPage session={session} employeeId={params.id} />}</Route>
      <Route path="/people/:id">{params => <ProfilePage id={params.id} user={user} />}</Route>
      <Route path="/employees/:id/career">{params => <DevelopmentPage session={session} employeeId={params.id} />}</Route>
      <Route path="/employees/:id/skills">{params => <DevelopmentPage session={session} employeeId={params.id} />}</Route>
      <Route path="/employees/:id">{params => <ProfilePage id={params.id} user={user} />}</Route>
      {['/development','/employee','/employee/skills','/employee/roadmap'].map(path => <Route key={path} path={path}><DevelopmentPage session={session} /></Route>)}
      {['/history','/employee/history'].map(path => <Route key={path} path={path}><HistoryPage session={session} /></Route>)}
      <Route path="/events/manage">{staff ? <EventsPage session={session} /> : denied}</Route>
      <Route path="/events/new">{staff ? <EventsAdminPage session={session} /> : denied}</Route>
      <Route path="/events/:eventId/edit">{params => staff ? <EventsAdminPage session={session} eventId={params.eventId} /> : denied}</Route>
      <Route path="/events/:eventId">{params => <EventPage session={session} eventId={params.eventId} />}</Route>
      <Route path="/events"><EventsPage session={session} /></Route>
      <Route path="/growth"><GrowthPage session={session} /></Route>
      <Route path="/plans"><GrowthPage session={session} initialSection="plans" /></Route>
      <Route path="/mentorships"><GrowthPage session={session} initialSection="mentors" /></Route>
      <Route path="/recognitions"><GrowthPage session={session} initialSection="thanks" /></Route>
      <Route path="/team-challenges"><GrowthPage session={session} initialSection="team" /></Route>
      <Route path="/rewards"><GrowthPage session={session} initialSection="rewards" /></Route>
      <Route path="/admin/growth">{staff ? <GrowthAdminPage session={session} /> : denied}</Route>
      <Route path="/guide/manage">{staff ? <GuideAdminPage session={session} /> : denied}</Route>
      <Route path="/guide/articles/:articleId">{params => <GuideArticlePage session={session} articleId={params.articleId} />}</Route>
      <Route path="/guide"><GuidePage session={session} /></Route>
      <Route path="/assistant"><AssistantPage session={session} /></Route>
      <Route path="/hr">{staff || user.role === 'manager' ? <HrPage session={session} /> : denied}</Route>
      <Route path="/notifications"><NotificationsPage session={session} /></Route>
      <Route path="/access"><AccessPage session={session} /></Route>
      <Route path="/admin/settings">{user.role === 'admin' ? <SettingsPage session={session} /> : denied}</Route>
      <Route path="/admin/imports">{user.role === 'admin' ? <ImportsPage session={session} onDataChanged={() => setRevision(value => value + 1)} /> : denied}</Route>
      <Route><div className="card"><EmptyState title={t.notFound} description={copy.notFoundText} action={<Button asChild><Link href="/">{t.home}</Link></Button>} /></div></Route>
    </Switch>
    </Suspense></PageBoundary>
  </Shell>;
}
