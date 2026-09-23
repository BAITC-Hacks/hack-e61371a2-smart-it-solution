import {useState} from 'react';
import {RefreshCw} from 'lucide-react';
import type {Session} from '../../api';
import {Badge,Button,EmptyState,Heading} from '../../components/ui';
import {useI18n} from '../../i18n';
import {ResourceState,useResource} from '../platform/common';
import {AccountsPanel} from './AccountsPanel';
import {AuditPanel} from './AuditPanel';
import {IntegrationsPanel} from './IntegrationsPanel';
import {SemanticPanel} from './SemanticPanel';
import {semanticCopy} from '../guide/semantic.copy';
import {settingsCopy} from './settings.copy';
import './settings.css';
type AiUsage={enabled:boolean;provider?:'openai'|'self_hosted';costBasis?:'openai_api_tokens';gpuCostExcluded?:boolean;model:string|null;recommendModel:string|null;budgetUsd:number;chargedUsd:number;remainingUsd:number;requests:number;unresolvedReservations:number;warningThresholds:number[];providerConfigured:boolean};
function AiUsagePanel(){
 const {locale}=useI18n();const c=settingsCopy(locale);const resource=useResource<AiUsage>('/admin/ai/usage');const data=resource.data;
 const money=(n:number)=>new Intl.NumberFormat(locale,{style:'currency',currency:'USD',maximumFractionDigits:4}).format(n);
 return <section data-testid="ai-usage-panel"><div className="settings-section-heading"><div><h2>{c.aiTitle}</h2><p>{c.aiSub}</p></div><Button variant="secondary" disabled={resource.loading} onClick={resource.reload}><RefreshCw size={16}/>{c.refresh}</Button></div><ResourceState loading={resource.loading} error={resource.error} retry={resource.reload}>{data&&<>
  <div className="card"><dl className="settings-review"><div><dt>{c.provider}</dt><dd>{data.provider==='self_hosted'?c.selfHosted:data.provider==='openai'?'OpenAI':c.providerUnknown}</dd></div><div><dt>{c.status}</dt><dd><Badge tone={data.enabled?'success':'neutral'}>{data.enabled?c.enabled:c.disabled}</Badge></dd></div><div><dt>{c.model}</dt><dd>{data.model||c.notConfigured}</dd></div><div><dt>{c.recommendModel}</dt><dd>{data.recommendModel||c.notConfigured}</dd></div></dl></div>
  <div className="settings-section-heading"><div><h3>{c.apiCostsTitle}</h3><p>{c.apiCostsHelp}</p>{(data.gpuCostExcluded===true||data.provider==='self_hosted')&&<p data-testid="gpu-cost-note">{c.gpuCostsHelp}</p>}</div></div>
  <div className="settings-ai-cards">{[[c.budget,money(data.budgetUsd)],[c.charged,money(data.chargedUsd)],[c.remaining,money(data.remainingUsd)],[c.requests,new Intl.NumberFormat(locale).format(data.requests)]].map(([label,value])=><div className="card" key={label}><span>{label}</span><strong>{value}</strong></div>)}</div>
  <p className="form-hint">{c.requestsHelp}</p><div className="card"><dl className="settings-review"><div><dt>{c.reservations}</dt><dd>{data.unresolvedReservations}</dd></div><div><dt>{c.thresholds}</dt><dd>{data.warningThresholds.length?data.warningThresholds.map(n=>`${n}%`).join(', '):'—'}</dd></div></dl></div>
 </>}</ResourceState></section>;
}
export function SettingsPage({session}:{session:Session}){const {locale}=useI18n();const c=settingsCopy(locale);const [tab,setTab]=useState<'accounts'|'audit'|'integrations'|'ai'|'semantic'>('accounts');if(session.user.role!=='admin')return <div className="settings-page"><Heading title={c.title}/><EmptyState title={c.denied}/></div>;return <div className="settings-page"><Heading title={c.title} subtitle={c.subtitle}/><nav className="settings-tabs" aria-label={c.title}>{(['accounts','audit','integrations','ai','semantic'] as const).map(key=><button key={key} className={key===tab?'is-active':''} aria-current={key===tab?'page':undefined} onClick={()=>setTab(key)}>{key==='semantic'?semanticCopy(locale).title:c[key]}</button>)}</nav>{tab==='accounts'?<AccountsPanel session={session}/>:tab==='audit'?<AuditPanel/>:tab==='integrations'?<IntegrationsPanel session={session}/>:tab==='semantic'?<SemanticPanel session={session}/>:<AiUsagePanel/>}</div>;}
