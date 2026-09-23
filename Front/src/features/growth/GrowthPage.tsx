import { Link, useSearch } from 'wouter';
import type { Session } from '../../api';
import { Button, EmptyState, Heading } from '../../components/ui';
import { useGrowthCopy } from './copy';
import { Plans, Forecasts } from './Plans';
import { Mentors, Tasks, Teams, Thanks } from './Social';
import { Rewards } from './Rewards';
import './growth.css';

export type GrowthSection = 'plans' | 'forecast' | 'mentors' | 'tasks' | 'thanks' | 'team' | 'rewards';
const sections: GrowthSection[] = ['plans','forecast','mentors','tasks','thanks','team','rewards'];
export function GrowthPage({ session, employeeId, initialSection = 'plans' }: { session: Session; employeeId?: string; initialSection?: GrowthSection }) {
  const { c } = useGrowthCopy(); const search = useSearch(); const chosen = new URLSearchParams(search).get('section'); const section = sections.includes(chosen as GrowthSection) ? chosen as GrowthSection : initialSection;
  const own = !employeeId || employeeId === session.user.employeeId;
  if (!own || !session.user.employeeId) return <div className="growth-page"><Heading title={c('title')} subtitle={c('subtitle')}/><div className="card"><EmptyState title={c('privateTitle')} description={own ? c('noEmployee') : c('privateText')} action={['admin','hr'].includes(session.user.role) ? <Button asChild><Link href="/admin/growth">{c('management')}</Link></Button> : undefined}/></div></div>;
  return <div className="growth-page"><Heading title={c('title')} subtitle={c('subtitle')}/><nav className="growth-nav" aria-label={c('title')}>{sections.map(item => <Link key={item} className={section === item ? 'is-selected' : ''} aria-current={section === item ? 'page' : undefined} href={`/growth?section=${item}`}>{c(item)}</Link>)}</nav>
    {section === 'plans' && <Plans session={session}/>} {section === 'forecast' && <Forecasts session={session}/>} {section === 'mentors' && <Mentors session={session}/>} {section === 'tasks' && <Tasks session={session}/>} {section === 'thanks' && <Thanks session={session}/>} {section === 'team' && <Teams session={session}/>} {section === 'rewards' && <Rewards session={session}/>}
  </div>;
}
