import {useEffect,useRef,useState,type ReactNode} from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import {X} from 'lucide-react';
import {api,type ApiResponse,type PageMeta,type Session} from '../../api';
import {Button,EmptyState,ErrorState,Loading} from '../../components/ui';
import {useI18n} from '../../i18n';
import './platform.css';
export function useResource<T,M=PageMeta>(path:string|null,revision=0){
 const [value,setValue]=useState<ApiResponse<T,M>|null>(null);const [error,setError]=useState('');const [loading,setLoading]=useState(Boolean(path));const [attempt,setAttempt]=useState(0);const [loadedPath,setLoadedPath]=useState(path);
 useEffect(()=>{setLoadedPath(path);setValue(null);setError('');setLoading(Boolean(path));if(!path)return;const controller=new AbortController();api<T,M>(path,{signal:controller.signal}).then(result=>{if(!controller.signal.aborted)setValue(result);}).catch(e=>{if(!controller.signal.aborted)setError((e as Error).message);}).finally(()=>{if(!controller.signal.aborted)setLoading(false);});return()=>controller.abort();},[path,revision,attempt]);
 const current=loadedPath===path;
 return {data:current?value?.data:undefined,meta:current?value?.meta:undefined,error:current?error:'',loading:Boolean(path)&&(!current||loading),reload:()=>setAttempt(v=>v+1)};
}
export function useAction(session:Session){
 const [busy,setBusy]=useState(false);const [error,setError]=useState('');const [success,setSuccess]=useState(false);const lock=useRef(false);const pending=useRef<{signature:string;key:string}|null>(null);const controller=useRef<AbortController|null>(null);
 useEffect(()=>()=>{controller.current?.abort();pending.current=null;},[]);
 async function run<T=unknown>(path:string,method:string,body?:unknown):Promise<T|undefined>{
  if(lock.current)return;lock.current=true;setBusy(true);setError('');setSuccess(false);const signature=JSON.stringify([path,method,body]);if(pending.current?.signature!==signature)pending.current={signature,key:crypto.randomUUID()};const request=new AbortController();controller.current=request;
  try{const result=await api<T>(path,{method,body,csrf:session.csrfToken,idempotencyKey:pending.current.key,signal:request.signal});if(request.signal.aborted)return;pending.current=null;setSuccess(true);return result.data;}
  catch(e){if(!request.signal.aborted)setError((e as Error).message);return undefined;}
  finally{lock.current=false;if(!request.signal.aborted)setBusy(false);}
 }
 return {busy,error,success,run,clear:()=>{setError('');setSuccess(false);}};
}
export function ResourceState({loading,error,retry,children}:{loading:boolean;error:string;retry:()=>void;children:ReactNode}){return loading?<Loading/>:error?<ErrorState message={error} retry={retry}/>:<>{children}</>;}
export function Modal({title,description,open,onClose,children,busy=false}:{title:string;description:string;open:boolean;onClose:()=>void;children:ReactNode;busy?:boolean}){const {t}=useI18n();return <Dialog.Root open={open} onOpenChange={value=>{if(!value&&!busy)onClose();}}><Dialog.Portal><Dialog.Overlay className="platform-overlay"/><Dialog.Content className="platform-modal" onEscapeKeyDown={event=>{if(busy)event.preventDefault();}} onPointerDownOutside={event=>{if(busy)event.preventDefault();}}><Dialog.Title>{title}</Dialog.Title><Dialog.Description>{description}</Dialog.Description><Dialog.Close asChild><Button variant="ghost" className="platform-modal-close" disabled={busy} aria-label={t.close}><X size={20}/></Button></Dialog.Close>{children}</Dialog.Content></Dialog.Portal></Dialog.Root>;}
export function Empty({title,text}:{title:string;text?:string}){return <EmptyState title={title} description={text}/>;}
export function dateText(value:string|undefined|null,locale:string){if(!value)return '—';const date=new Date(value.length===10?value+'T00:00:00Z':value);return Number.isNaN(date.getTime())?'—':new Intl.DateTimeFormat(locale==='kk'?'kk-KZ':locale==='ru'?'ru-RU':'en-GB',{dateStyle:'medium',timeZone:'UTC'}).format(date);}
export function safeInternalLink(value:string|undefined|null){
 if(!value||!/^\/(?![\/\\])/.test(value)||/[\u0000-\u0020\u007f]/.test(value))return '/';
 try{const url=new URL(value,window.location.origin);return url.origin===window.location.origin?url.pathname+url.search+url.hash:'/';}catch{return '/';}
}
export function Pager({page,total,limit,onChange}:{page:number;total:number;limit:number;onChange:(page:number)=>void}){const {locale}=useI18n();const c=locale==='ru'?['Назад','Далее','Страница']:locale==='kk'?['Артқа','Келесі','Бет']:['Previous','Next','Page'];return <div className="platform-pagination"><span>{c[2]} {page} / {Math.max(1,Math.ceil(total/limit))}</span><Button size="small" variant="secondary" disabled={page<=1} onClick={()=>onChange(page-1)}>{c[0]}</Button><Button size="small" variant="secondary" disabled={page*limit>=total} onClick={()=>onChange(page+1)}>{c[1]}</Button></div>;}
