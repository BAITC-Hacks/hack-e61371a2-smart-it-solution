import { useEffect, useState } from 'react';
import { Download } from 'lucide-react';
import { useI18n } from '../i18n';
import { navigationCopy } from '../navigation.copy';
import { Button } from './ui';
interface InstallPrompt extends Event { prompt:()=>Promise<void>; userChoice:Promise<{outcome:'accepted'|'dismissed'}> }
export function InstallApp() {
  const {locale}=useI18n(); const copy=navigationCopy[locale];
  const [prompt,setPrompt]=useState<InstallPrompt|null>(null); const [busy,setBusy]=useState(false);
  useEffect(()=>{
    const available=(event:Event)=>{event.preventDefault();setPrompt(event as InstallPrompt);};
    const installed=()=>setPrompt(null);
    window.addEventListener('beforeinstallprompt',available); window.addEventListener('appinstalled',installed);
    return()=>{window.removeEventListener('beforeinstallprompt',available);window.removeEventListener('appinstalled',installed);};
  },[]);
  if(!prompt)return null;
  return <Button variant="ghost" className="install-button" title={copy.installHint} disabled={busy} onClick={async()=>{setBusy(true);try{await prompt.prompt();await prompt.userChoice;}catch{/* The browser may withdraw its optional installation prompt. */}finally{setPrompt(null);setBusy(false);}}}><Download size={17} aria-hidden="true"/>{copy.install}</Button>;
}
