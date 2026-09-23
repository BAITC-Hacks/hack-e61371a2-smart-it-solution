import {useState} from 'react';
import {api,type Session} from '../../api';
import {Badge,Button,ErrorState} from '../../components/ui';
import {useI18n} from '../../i18n';
import {dateText,Modal,ResourceState,useAction,useResource} from './common';
import {personalCopy} from './personal.copy';
export function Sessions({session}:{session:Session}) {
  const {locale}=useI18n(); const c=personalCopy[locale];
  const list=useResource<Array<{id:string;expiresAt:string;revokedAt:string|null}>>('/auth/sessions');
  const action=useAction(session); const [selected,setSelected]=useState<string|null>(null);
  async function revoke() {
    if(!selected) return;
    const result=await action.run(`/auth/sessions/${encodeURIComponent(selected)}`,'DELETE');
    if(result===undefined) return;
    setSelected(null); list.reload();
    try { await api('/auth/me'); } catch { /* The global 401 listener handles revocation of this session. */ }
  }
  const expiredText=locale==='en'?'Expired':locale==='kk'?'Мерзімі өткен':'Истекла';
  return <section className="platform-card" style={{marginTop:24}}>
    <h2>{c.sessions}</h2><p>{c.sessionsText}</p>
    <ResourceState loading={list.loading} error={list.error} retry={list.reload}>
      <div className="platform-table-wrap"><table className="platform-table">
        <thead><tr><th>{c.session}</th><th>{c.expires}</th><th>{c.active}</th><th/></tr></thead>
        <tbody>{list.data?.map(row=>{
          const expired=Date.parse(row.expiresAt)<=Date.now();
          return <tr key={row.id}><td>{row.id.slice(0,8)}</td><td>{dateText(row.expiresAt,locale)}</td>
            <td><Badge tone={row.revokedAt||expired?'neutral':'green'}>{row.revokedAt?c.revoked:expired?expiredText:c.active}</Badge></td>
            <td><Button size="small" variant="secondary" disabled={Boolean(row.revokedAt)||expired} onClick={()=>{action.clear();setSelected(row.id);}}>{c.revoke}</Button></td></tr>;
        })}</tbody>
      </table></div>
    </ResourceState>
    <Modal open={Boolean(selected)} onClose={()=>setSelected(null)} busy={action.busy} title={c.confirmTitle} description={c.confirmText}>
      {action.error&&<ErrorState message={action.error}/>}
      <div className="platform-actions"><Button variant="danger" disabled={action.busy} onClick={()=>void revoke()}>{c.confirm}</Button><Button variant="secondary" disabled={action.busy} onClick={()=>setSelected(null)}>{c.cancel}</Button></div>
    </Modal>
  </section>;
}
