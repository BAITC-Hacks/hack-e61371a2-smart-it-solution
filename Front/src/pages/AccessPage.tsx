import { Check, CircleUserRound, FileClock, Layers3, LockKeyhole, ShieldCheck, Upload, Users, X } from 'lucide-react';
import type { Session } from '../api';
import { Sessions } from '../features/platform/Sessions';
import { navigationCopy } from '../navigation.copy';
import { appCopy } from '../app.copy';
import { Avatar, Badge, Heading } from '../components/ui';
import { useI18n } from '../i18n';
import './access.css';

export function AccessPage({ session }: { session: Session }) {
  const {user} = session;
  const { locale, t } = useI18n();
  const c = appCopy[locale];
  const nav = navigationCopy[locale];
  const organizationAccess = user.role === 'hr' || user.role === 'admin';
  const admin = user.role === 'admin';
  const scope = user.role === 'employee' ? (user.employeeId ? c.scopeSelf : c.notLinked) : user.role === 'manager' ? c.scopeTeam : c.scopeOrganization;
  const permissions = [
    { key: 'own', icon: CircleUserRound, label: c.ownProfile, allowed: Boolean(user.employeeId), detail: !user.employeeId ? c.notLinked : undefined },
    { key: 'reports', icon: Users, label: c.directReports, allowed: user.role === 'manager' || organizationAccess },
    { key: 'organization', icon: Users, label: c.allProfiles, allowed: organizationAccess },
    { key: 'catalog', icon: Layers3, label: c.sharedCatalogs, allowed: true },
    { key: 'career', icon: Layers3, label: nav.development, allowed: Boolean(user.employeeId) || user.role !== 'employee' },
    { key: 'growth', icon: Layers3, label: nav.growth, allowed: Boolean(user.employeeId), detail: !user.employeeId ? c.notLinked : undefined },
    { key: 'guide', icon: FileClock, label: nav.guide, allowed: true },
    { key: 'assistant', icon: FileClock, label: nav.assistant, allowed: true },
    { key: 'analytics', icon: Users, label: nav.hr, allowed: user.role !== 'employee' },
    { key: 'eventsAdmin', icon: Layers3, label: nav.eventsAdmin, allowed: organizationAccess },
    { key: 'guideAdmin', icon: FileClock, label: nav.guideAdmin, allowed: organizationAccess },
    { key: 'growthAdmin', icon: Users, label: nav.growthAdmin, allowed: organizationAccess },
    { key: 'settings', icon: ShieldCheck, label: nav.settings, allowed: admin },
    { key: 'imports', icon: Upload, label: c.manageImports, allowed: admin },
    { key: 'history', icon: FileClock, label: c.uploadHistory, allowed: admin },
  ];

  return <div className="cq-access-page">
    <Heading title={c.accessTitle} subtitle={c.accessIntro} />
    <div className="cq-access-overview">
      <section className="cq-access-account" aria-label={c.account}>
        <Avatar name={user.displayName} size="large" />
        <div className="cq-access-person"><span className="cq-access-eyebrow">{c.accessAccount}</span><h2>{user.displayName}</h2><div className="cq-access-account-meta"><Badge tone="green">{t[user.role]}</Badge><span>{user.login}</span></div></div>
      </section>
      <section className="cq-access-scope" aria-labelledby="access-scope-title">
        <span className="cq-access-scope-icon"><ShieldCheck size={22} aria-hidden="true" /></span>
        <div><h2 id="access-scope-title">{c.scopeTitle}</h2><p>{scope}</p></div>
      </section>
    </div>

    <section className="cq-access-permissions" aria-labelledby="access-permissions-title">
      <div className="cq-access-heading"><h2 id="access-permissions-title">{c.accessTitle}</h2><p>{c.accessDescription}</p></div>
      <table className="cq-access-table">
        <thead><tr><th scope="col">{c.permission}</th><th scope="col">{t[user.role]}</th></tr></thead>
        <tbody>{permissions.map(({ key, icon: Icon, label, allowed, detail }) => <tr key={key} data-permission={key} data-allowed={allowed}>
          <th scope="row"><div className="cq-access-capability"><span className="cq-access-capability-icon"><Icon size={18} aria-hidden="true" /></span><span>{label}{detail && <small>{detail}</small>}</span></div></th>
          <td><span className={`cq-access-status ${allowed ? 'cq-access-status-allowed' : 'cq-access-status-denied'}`}><span className="cq-access-status-icon">{allowed ? <Check size={12} strokeWidth={3} aria-hidden="true" /> : <X size={11} strokeWidth={2.5} aria-hidden="true" />}</span>{allowed ? t.allowed : t.denied}</span></td>
        </tr>)}</tbody>
      </table>
    </section>

    <aside className="cq-access-session"><span><LockKeyhole size={20} aria-hidden="true" /></span><div><h2>{c.sessionSecurity}</h2><p>{c.sessionSecurityText}</p></div></aside>
    <Sessions session={session} />
  </div>;
}
