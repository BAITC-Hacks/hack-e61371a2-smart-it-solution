import {useEffect,useRef,useState} from 'react';
import {Link} from 'wouter';
import {Search} from 'lucide-react';
import type {Session} from '../../api';
import {Badge,Button,EmptyState,ErrorState} from '../../components/ui';
import {useI18n} from '../../i18n';
import {semanticCopy,semanticFallback} from './semantic.copy';
import {useSemanticRequest,type SemanticSearchResult} from './semantic';
export function SemanticSearch({session}:{session:Session}){
 const {locale}=useI18n(),c=semanticCopy(locale);const [query,setQuery]=useState(''),[result,setResult]=useState<{signature:string;value:SemanticSearchResult}|null>(null);const request=useSemanticRequest(session);const signature=JSON.stringify([query.trim(),locale]);const currentSignature=useRef(signature);currentSignature.current=signature;
 useEffect(()=>{request.abort();setResult(null);},[locale]);
 const search=async()=>{const q=query.trim();if(q.length<2||q.length>300)return;const submitted=signature;const value=await request.run<SemanticSearchResult>('/guide/semantic-search',{q,locale});if(value&&currentSignature.current===submitted)setResult({signature:submitted,value});};
 const shown=result?.signature===signature?result.value:null;
 return <details className="guide-semantic"><summary><Search size={16}/>{c.title}</summary><div className="guide-semantic-body"><p>{c.searchIntro}</p><form onSubmit={e=>{e.preventDefault();void search();}}><label htmlFor="guide-semantic-query">{c.query}</label><div className="guide-semantic-form"><input id="guide-semantic-query" value={query} minLength={2} maxLength={300} required onChange={e=>{request.abort();setQuery(e.target.value);setResult(null);}}/><Button type="submit" disabled={request.busy||query.trim().length<2} data-testid="semantic-search">{request.busy?c.searching:c.search}</Button></div></form><small>{c.privacy}</small>{request.error&&<ErrorState message={request.error}/>}<div aria-live="polite">{shown&&<><p className="guide-semantic-source"><Badge tone={shown.source==='semantic'?'success':'neutral'}>{c[shown.source]}</Badge>{shown.source==='sql'&&<span>{semanticFallback(shown.fallbackReason,c)}</span>}</p>{shown.articles.length?<div className="guide-article-grid">{shown.articles.map(article=><Link className="guide-article-card" key={article.id} href={`/guide/articles/${encodeURIComponent(article.id)}`}><div className="guide-card-top"><span>{article.locale.toUpperCase()} · {c.version} {article.version}</span>{article.synthetic&&<Badge tone="demo">{c.synthetic}</Badge>}</div><h2>{article.title}</h2><p>{article.summary}</p><span>{c.open} →</span></Link>)}</div>:<EmptyState title={c.empty}/>}</>}</div></div></details>;
}
