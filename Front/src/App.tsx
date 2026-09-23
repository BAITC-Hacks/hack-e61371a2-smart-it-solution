import {useEffect,useState,type FormEvent} from 'react';
import {Link,Route,Switch,useLocation} from 'wouter';
import {api,type Session,type User,type Workspace} from './api';
import {Language,useI18n} from './i18n';
import {Badge,Brand,Button,ErrorState,Heading,Loading} from './components/ui';

// Buildable integration starter. The frontend owner develops the full pages here.
export function App(){
 const {t}=useI18n();const [session,setSession]=useState<Session|null>(null);
 const [loading,setLoading]=useState(true);const [error,setError]=useState('');
 const [accounts,setAccounts]=useState<User[]>([]);const [busy,setBusy]=useState(false);
 const [,navigate]=useLocation();
 useEffect(()=>{let active=true;Promise.all([
   api<Session>('/auth/me').then(r=>{if(active)setSession(r.data);}).catch(e=>{if(active&&e.status!==401)setError(e.message);}),
   api<{enabled:boolean;accounts:User[]}>('/auth/demo-accounts').then(r=>{if(active)setAccounts(r.data.accounts);}).catch(e=>{if(active)setError(e.message);}),
 ]).finally(()=>{if(active)setLoading(false);});const expired=()=>setSession(null);window.addEventListener('session-expired',expired);return()=>{active=false;window.removeEventListener('session-expired',expired);};},[]);
 async function login(body:unknown){setBusy(true);setError('');try{const r=await api<Session>('/auth/login',{method:'POST',body});setSession(r.data);navigate('/');}catch(e){setError((e as Error).message);}finally{setBusy(false);}}
 async function logout(){setBusy(true);try{await api('/auth/logout',{method:'POST',csrf:session?.csrfToken});setSession(null);navigate('/');}catch(e){setError((e as Error).message);}finally{setBusy(false);}}
 function credentials(event:FormEvent<HTMLFormElement>){event.preventDefault();const data=new FormData(event.currentTarget);void login({login:data.get('login'),password:data.get('password')});}
 if(loading)return <Loading/>;
 return <div className="shell"><header><Brand/><Language/></header>{error&&<ErrorState message={error}/>}
 {!session?<main className="login-grid"><section className="intro"><Badge>HackAlem.ai · Smart IT Solution</Badge><h1>{t.loginTitle}</h1><p>{t.tagline}</p><small>{t.synthetic}</small></section><section className="card"><h2>{t.loginWelcome}</h2><p>{t.loginSubtitle}</p><div className="account-list">{accounts.map(a=><Button key={a.id} variant="secondary" disabled={busy} onClick={()=>void login({login:a.login,demo:true})}><span>{t[a.role]}</span><small>{a.displayName}</small></Button>)}</div><form onSubmit={credentials}><h3>{t.loginNormal}</h3><label>{t.login}<input name="login" required autoComplete="username" maxLength={120}/></label><label>{t.password}<input name="password" type="password" required autoComplete="current-password" maxLength={256}/></label><Button disabled={busy}>{busy?t.loading:t.signIn}</Button></form></section></main>:
 <><nav><Link href="/">{t.workspace}</Link><Link href="/access">{t.access}</Link><span className="nav-user">{session.user.displayName}</span><Button variant="ghost" disabled={busy} onClick={()=>void logout()}>{t.logout}</Button></nav><main><Switch>
 <Route path="/"><WorkspaceHome user={session.user}/></Route>
 <Route path="/access"><Heading title={t.access} subtitle={t.accessSub}/><section className="card"><Badge>{t[session.user.role]}</Badge><h2>{t.currentRole}</h2><p>{({employee:t.selfRule,manager:t.managerRule,hr:t.hrRule,admin:t.adminRule})[session.user.role]}</p><p>{t.authNote}</p></section></Route>
 <Route><Heading title={t.notFound} subtitle=""/><Link href="/">{t.home}</Link></Route>
 </Switch></main></>}
 <footer>{t.buildLabel} · Smart IT Solution</footer></div>;
}
function WorkspaceHome({user}:{user:User}){
 const{t}=useI18n();const[data,setData]=useState<Workspace|null>(null);const[error,setError]=useState('');
 useEffect(()=>{const controller=new AbortController();api<Workspace>('/workspace',{signal:controller.signal}).then(r=>setData(r.data)).catch(e=>{if(e.name!=='AbortError')setError(e.message);});return()=>controller.abort();},[user.id]);
 return <><Heading title={`${t.greeting}, ${user.displayName.split(' ')[0]}`} subtitle={t.overviewSub}/>{error?<ErrorState message={error}/>:!data?<Loading/>:<><section className="hero"><Badge>{t.foundation}</Badge><h2>{t.heroTitle}</h2><p>{t.heroText}</p></section><div className="stats">{[[t.visiblePeople,data.counts.employees],[t.skills,data.counts.skills],[t.events,data.counts.events],[t.history,data.counts.participations]].map(([label,value])=><section className="card" key={label}><p>{label}</p><strong className="stat-value">{value}</strong></section>)}</div><section className="card"><h2>{t.dataset}</h2><p>{t.snapshot}: {data.dataset?.asOfDate??'—'}</p><p>{t.datasetVersion}: {data.dataset?.version??'—'}</p><small>{t.synthetic}</small></section></>}</>;
}
