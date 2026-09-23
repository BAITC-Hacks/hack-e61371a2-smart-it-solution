import {useEffect,useRef,useState} from 'react';
import {api,ApiError,type Session} from '../../api';
import type {Locale} from './types';
export type SemanticArticle={id:string;topicId:string;locale:Locale;title:string;summary:string;version:number;synthetic:boolean;score?:number};
export type SemanticSearchResult={source:'sql'|'semantic';fallbackReason?:string|null;articles:SemanticArticle[];usageIds?:string[]};
// Keep the receipt key on all retries, including successful repeats. A new charge
// requires changed input or an explicitly confirmed new attempt.
export function useSemanticRequest(session:Session){
 const lock=useRef(false),pending=useRef<{signature:string;key:string}|null>(null),controller=useRef<AbortController|null>(null);
 const [busy,setBusy]=useState(false),[error,setError]=useState(''),[errorCode,setErrorCode]=useState('');
 useEffect(()=>()=>controller.current?.abort(),[]);
 const clear=()=>{setError('');setErrorCode('');};
 async function run<T>(path:string,body:unknown):Promise<T|undefined>{
  if(lock.current)return;lock.current=true;setBusy(true);clear();const signature=JSON.stringify([path,body]);if(pending.current?.signature!==signature)pending.current={signature,key:crypto.randomUUID()};const request=new AbortController();controller.current=request;
  try{const result=await api<T>(path,{method:'POST',body,csrf:session.csrfToken,idempotencyKey:pending.current.key,signal:request.signal,timeoutMs:60_000});if(!request.signal.aborted)return result.data;}
  catch(e){if(!request.signal.aborted){setError((e as Error).message);setErrorCode(e instanceof ApiError?e.code:'UNKNOWN');}}
  finally{lock.current=false;if(!request.signal.aborted)setBusy(false);}
 }
 return {run,busy,error,errorCode,clear,newAttempt:()=>{if(!lock.current){pending.current=null;clear();}},abort:()=>{controller.current?.abort();setBusy(false);clear();}};
}
