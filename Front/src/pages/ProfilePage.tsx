import { useEffect, useState } from 'react';
import { Link } from 'wouter';
import { ArrowLeft, ArrowUpRight, BriefcaseBusiness, CalendarDays, Flag, Globe2, MapPin } from 'lucide-react';
import { ApiError, api, type Profile, type User } from '../api';
import { useI18n } from '../i18n';
import { Avatar, Badge, Button, EmptyState, ErrorState, Heading, Loading } from '../components/ui';
import { dateLocales, peopleCopy } from './people.copy';
import './people.css';

export function ProfilePage({ id, user }: { id: string; user: User }) {
  const { locale } = useI18n();
  const c = peopleCopy[locale];
  const [profile, setProfile] = useState<Profile | null>(null);
  const [status, setStatus] = useState<'loading' | 'ready' | 'error' | 'inaccessible'>('loading');
  const [attempt, setAttempt] = useState(0);
  const own = id === user.employeeId || !id;

  useEffect(() => {
    if (!id) return;
    const controller = new AbortController();
    setStatus('loading');
    setProfile(null);
    api<Profile>(`/employees/${encodeURIComponent(id)}`, { signal: controller.signal }).then(response => {
      if (controller.signal.aborted) return;
      setProfile(response.data);
      setStatus('ready');
    }).catch(error => {
      if (controller.signal.aborted) return;
      setStatus(error instanceof ApiError && (error.status === 403 || error.status === 404) ? 'inaccessible' : 'error');
    });
    return () => controller.abort();
  }, [id, attempt, user.id]);

  const back = <Button variant="ghost" size="small" asChild><Link href={own ? '/' : '/people'}><ArrowLeft size={16} aria-hidden="true" />{own ? c.workspace : c.back}</Link></Button>;
  const formatDate = (value: string) => {
    if (!value) return c.notSet;
    const date = new Date(`${value}T00:00:00`);
    return Number.isNaN(date.getTime()) ? c.notSet : new Intl.DateTimeFormat(dateLocales[locale], { day: 'numeric', month: 'long', year: 'numeric' }).format(date);
  };
  const formats: Record<string, string> = { office: c.office, hybrid: c.hybrid, remote: c.remote };
  const languages: Record<string, string> = { ru: c.russian, kk: c.kazakh, en: c.english };

  return <div className="cq-profile-page">
    <div className="cq-profile-back">{back}</div>
    <Heading title={own ? c.own : c.profileTitle} subtitle={own ? c.ownSub : c.profileSub} />
    {!id ? <div className="cq-profile-panel"><EmptyState title={c.noLinked} description={c.noLinkedSub} /></div>
      : status === 'loading' ? <div className="cq-profile-panel"><Loading /></div>
      : status === 'error' ? <ErrorState message={c.profileError} retry={() => setAttempt(value => value + 1)} />
      : status === 'inaccessible' ? <div className="cq-profile-panel"><EmptyState title={c.inaccessible} description={c.inaccessibleSub} action={back} /></div>
      : profile && <>
        <section data-testid="profile-detail" className="cq-profile-identity" aria-label={profile.name}>
          <div className="cq-profile-identity-main"><div className="cq-profile-avatar"><Avatar name={profile.name} /></div><div><div className="cq-profile-name-line"><h2>{profile.name}</h2>{own && <Badge>{c.you}</Badge>}</div><p className="cq-profile-role">{profile.role}<span aria-hidden="true">·</span>{profile.grade || c.notSet}</p><p className="cq-profile-dept"><BriefcaseBusiness size={16} aria-hidden="true" />{profile.department || c.notSet}</p></div></div>
          <div className="cq-profile-id"><span>{c.employeeId}</span><strong>{profile.id}</strong></div>
        </section>

        <div className="cq-profile-grid">
          <section className="cq-profile-panel cq-profile-details" aria-labelledby="profile-details-title">
            <div className="cq-profile-section-heading"><div className="cq-profile-section-icon"><BriefcaseBusiness size={20} aria-hidden="true" /></div><div><h2 id="profile-details-title">{c.details}</h2><p>{c.detailsSub}</p></div></div>
            <dl className="cq-profile-detail-list">
              <div><dt><CalendarDays size={16} aria-hidden="true" />{c.hireDate}</dt><dd>{formatDate(profile.hireDate)}</dd></div>
              <div><dt>{c.tenure}</dt><dd>{new Intl.NumberFormat(dateLocales[locale], { style: 'unit', unit: 'month', unitDisplay: 'long' }).format(profile.tenureMonths)}</dd></div>
              <div><dt><MapPin size={16} aria-hidden="true" />{c.workFormat}</dt><dd>{formats[profile.workFormat] ?? profile.workFormat ?? c.notSet}</dd></div>
              <div><dt>{c.review}</dt><dd>{formatDate(profile.lastReviewDate)}</dd></div>
              <div><dt><Globe2 size={16} aria-hidden="true" />{c.language}</dt><dd>{languages[profile.language] ?? profile.language ?? c.notSet}</dd></div>
              <div><dt>{c.manager}</dt><dd>{profile.managerId || c.notSet}</dd></div>
            </dl>
          </section>

          <section className="cq-profile-goal" aria-labelledby="profile-goal-title">
            <div className="cq-profile-goal-top"><span className="cq-profile-goal-icon"><Flag size={21} aria-hidden="true" /></span><ArrowUpRight size={25} aria-hidden="true" /></div>
            <h2 id="profile-goal-title">{c.goal}</h2>
            {profile.targetRole || profile.targetGrade ? <><p>{c.goalSub}</p><dl className="cq-profile-goal-details"><div><dt>{c.targetRole}</dt><dd>{profile.targetRole || c.notSet}</dd></div><div><dt>{c.targetGrade}</dt><dd>{profile.targetGrade ? <span className="cq-profile-target-grade">{profile.targetGrade}</span> : c.notSet}</dd></div></dl></> : <div className="cq-profile-goal-empty"><h3>{c.noGoal}</h3><p>{c.noGoalSub}</p></div>}
          </section>
        </div>
      </>}
  </div>;
}
