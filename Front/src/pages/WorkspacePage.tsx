import { useEffect, useState } from 'react';
import { Link } from 'wouter';
import { ArrowRight, ArrowUpRight, BookOpen, CalendarDays, CheckCircle2, Compass, Database, Layers3, ListChecks, RefreshCw, ShieldCheck, Sparkles, UploadCloud, UserRound, UsersRound } from 'lucide-react';
import { api, type User, type Workspace } from '../api';
import { appCopy } from '../app.copy';
import { navigationCopy } from '../navigation.copy';
import { useI18n } from '../i18n';
import { Badge, Button, ErrorState, Heading, Loading } from '../components/ui';

export function WorkspacePage({ user, revision }: { user: User; revision: number }) {
  const { locale, t } = useI18n(); const copy = appCopy[locale]; const nav = navigationCopy[locale];
  const [data, setData] = useState<Workspace | null>(null); const [error, setError] = useState(''); const [retry, setRetry] = useState(0);
  useEffect(() => {
    const controller = new AbortController(); setData(null); setError('');
    api<Workspace>('/workspace', { signal: controller.signal }).then(response => { if (!controller.signal.aborted) setData(response.data); }).catch(e => { if (!controller.signal.aborted) setError((e as Error).message); });
    return () => controller.abort();
  }, [user.id, revision, retry]);
  const hero = { employee: [copy.employeeHero, copy.employeeHeroText], manager: [copy.managerHero, copy.managerHeroText], hr: [copy.hrHero, copy.hrHeroText], admin: [copy.adminHero, copy.adminHeroText] }[user.role];
  const primaryLink = user.role === 'admin' ? '/admin/imports' : user.role === 'employee' ? '/development' : '/hr';
  const primaryLabel = user.role === 'admin' ? copy.importAction : user.role === 'employee' ? nav.development : user.role === 'manager' ? copy.teamAction : nav.hr;
  const date = (value: string) => new Intl.DateTimeFormat(locale === 'kk' ? 'kk-KZ' : locale === 'ru' ? 'ru-RU' : 'en-GB', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' }).format(new Date(value));
  const actions = [
    ...(user.employeeId ? [{ href: '/profile', icon: UserRound, title: copy.profileAction, text: copy.profileActionText }] : []),
    ...(user.role !== 'employee' ? [{ href: '/people', icon: UsersRound, title: user.role === 'manager' ? copy.teamAction : copy.peopleAction, text: copy.peopleActionText }] : []),
    ...(user.role === 'admin' ? [{ href: '/admin/imports', icon: UploadCloud, title: copy.importAction, text: copy.importActionText }] : []),
    { href: '/access', icon: ShieldCheck, title: copy.accessAction, text: copy.accessActionText },
  ];
  return <div data-testid="workspace-page"><Heading title={`${t.greeting}, ${user.displayName.split(' ')[0]}`} subtitle={t.overviewSub} action={<Button variant="secondary" size="small" onClick={() => setRetry(value => value + 1)} disabled={!data && !error} aria-label={copy.refresh}><RefreshCw size={16} />{copy.refresh}</Button>} />
    {error ? <ErrorState message={error} retry={() => setRetry(value => value + 1)} /> : !data ? <Loading /> : <>
      <section className="welcome-hero"><div className="hero-copy"><span className="hero-eyebrow">{copy.homeEyebrow}</span><h2>{hero[0]}</h2><p>{hero[1]}</p><Button asChild className="hero-button"><Link href={primaryLink}>{primaryLabel}<ArrowRight size={17} /></Link></Button></div><div className="hero-art" aria-hidden="true"><div className="hero-ring ring-one" /><div className="hero-ring ring-two" /><div className="hero-ring ring-three" /><div className="hero-growth"><ArrowUpRight size={90} strokeWidth={1.3} /></div><span className="hero-spark spark-one">✳</span><span className="hero-spark spark-two">✦</span></div></section>
      <section className="stats-grid" aria-label={copy.overview}>{[
        { label: t.visiblePeople, value: data.counts.employees, icon: UsersRound, kind: 'green', note: copy.scopedNote },
        { label: t.skills, value: data.counts.skills, icon: Layers3, kind: 'purple', note: copy.catalogNote },
        { label: t.events, value: data.counts.events, icon: BookOpen, kind: 'orange', note: copy.catalogNote },
        { label: t.history, value: data.counts.participations, icon: ListChecks, kind: 'blue', note: copy.scopedNote },
      ].map(({ label, value, icon: Icon, kind, note }) => <article className="stat-card" key={label}><div className="stat-top"><span className={`stat-icon stat-icon-${kind}`}><Icon size={20} aria-hidden="true" /></span><span>{label}</span></div><strong className="stat-value">{new Intl.NumberFormat(locale).format(value)}</strong><span className="stat-note">{note}</span></article>)}</section>
      <div className="dashboard-columns"><section className="card quick-actions"><div className="section-heading"><div><h2>{copy.quickActions}</h2><p>{copy.quickActionsSub}</p></div><Compass size={22} aria-hidden="true" /></div><div className="quick-action-list">{actions.map(({ href, icon: Icon, title, text }) => <Link href={href} className="quick-action" key={href}><span className="quick-action-icon"><Icon size={21} aria-hidden="true" /></span><span><strong>{title}</strong><small>{text}</small></span><ArrowUpRight size={19} aria-hidden="true" /></Link>)}</div></section>
      <section className="card dataset-card"><div className="section-heading"><h2>{copy.datasetTitle}</h2><Database size={21} aria-hidden="true" /></div>{data.dataset ? <><div className="dataset-status"><CheckCircle2 size={16} />{t.connected}</div><dl className="dataset-details"><div><dt>{copy.dataSnapshot}</dt><dd><CalendarDays size={15} />{date(data.dataset.asOfDate)}</dd></div><div><dt>{copy.datasetVersion}</dt><dd><code>{data.dataset.version}</code></dd></div><div><dt>{copy.updated}</dt><dd>{date(data.dataset.importedAt)}</dd></div></dl></> : <div className="dataset-empty"><p>{copy.datasetEmpty}</p><small>{copy.datasetEmptyHint}</small></div>}<div className="scope-note"><ShieldCheck size={19} /><span><small>{copy.scopeTitle}</small><strong>{data.scope === 'self' ? copy.scopeSelf : data.scope === 'team' ? copy.scopeTeam : copy.scopeOrganization}</strong></span></div></section></div>
      <section className="workspace-tools"><div className="section-heading"><div><h2>{nav.toolsTitle}</h2><p>{nav.toolsText}</p></div></div><div className="workspace-tools-grid">{[{href:'/events',title:nav.events,text:nav.eventsText,icon:BookOpen},{href:'/guide',title:nav.guide,text:nav.guideText,icon:Compass},{href:user.employeeId?'/growth':'/hr',title:user.employeeId?nav.growth:nav.hr,text:user.employeeId?nav.growthText:nav.hrText,icon:Sparkles}].map(({href,title,text,icon:Icon})=><Link href={href} className="workspace-tool" key={href}><Icon size={24}/><h3>{title}</h3><p>{text}</p></Link>)}</div></section>
    </>}
  </div>;
}
