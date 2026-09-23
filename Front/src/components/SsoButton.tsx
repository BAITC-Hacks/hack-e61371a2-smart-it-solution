import {useEffect,useRef,useState} from 'react';
import {Building2} from 'lucide-react';
import {api} from '../api';
import {useI18n} from '../i18n';
import {personalCopy} from '../features/platform/personal.copy';
import {Button,ErrorState} from './ui';
export function SsoButton(){const {locale}=useI18n();const c=personalCopy[locale];const [enabled,setEnabled]=useState(false);const [busy,setBusy]=useState(false);const [error,setError]=useState('');const lock=useRef(false);const controller=useRef<AbortController|null>(null);
 useEffect(()=>{const request=new AbortController();void api<{enabled:boolean}>('/auth/sso/config',{signal:request.signal}).then(response=>{if(!request.signal.aborted)setEnabled(response.data.enabled);}).catch(()=>{/* Password and demo login stay available when SSO configuration is absent. */});return()=>{request.abort();controller.current?.abort();};},[]);
 if(!enabled)return null;
 return <div className="login-sso">{error&&<ErrorState message={error}/>}<Button variant="secondary" disabled={busy} onClick={async()=>{if(lock.current)return;lock.current=true;setBusy(true);setError('');const request=new AbortController();controller.current=request;try{const response=await api<{authorizationUrl:string}>('/auth/sso/start',{method:'POST',body:{},signal:request.signal});const target=new URL(response.data.authorizationUrl);if(target.protocol!=='https:')throw new Error('Invalid authorization URL');if(!request.signal.aborted)window.location.assign(target.href);}catch{if(!request.signal.aborted)setError(c.ssoFailure);}finally{lock.current=false;if(!request.signal.aborted)setBusy(false);}}}><Building2 size={18}/>{busy?c.ssoChecking:c.sso}</Button></div>;
}
