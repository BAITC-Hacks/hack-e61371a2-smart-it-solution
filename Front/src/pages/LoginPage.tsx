import { useEffect, useRef, useState, type FormEvent } from 'react';
import { ArrowRight, Compass, Eye, EyeOff, Fingerprint, Flag, LockKeyhole, ShieldCheck, Sprout, UserRound, UsersRound } from 'lucide-react';
import { api, type Session, type User } from '../api';
import { appCopy } from '../app.copy';
import { Language, useI18n } from '../i18n';
import { Brand, Button, ErrorState, Loading } from '../components/ui';
import { SsoButton } from '../components/SsoButton';

export function LoginPage({ onLogin, notice }: { onLogin: (session: Session) => void; notice?: 'expired' | 'logout' }) {
  const { locale, t } = useI18n(); const copy = appCopy[locale];
  const [mode, setMode] = useState<'demo' | 'credentials'>('demo');
  const [accounts, setAccounts] = useState<User[]>([]); const [demoEnabled, setDemoEnabled] = useState(false);
  const [demoLoading, setDemoLoading] = useState(true); const [demoError, setDemoError] = useState(''); const [retry, setRetry] = useState(0);
  const [error, setError] = useState(''); const [busy, setBusy] = useState<string | null>(null); const [showPassword, setShowPassword] = useState(false);
  const lock = useRef(false); const loginController = useRef<AbortController | null>(null);
  useEffect(() => { document.title = `${copy.loginWelcome} · Career Quest`; }, [copy.loginWelcome]);
  useEffect(() => {
    const controller = new AbortController(); setDemoLoading(true); setDemoError('');
    api<{ enabled: boolean; accounts: User[] }>('/auth/demo-accounts', { signal: controller.signal }).then(({ data }) => { if (controller.signal.aborted) return; setAccounts(data.accounts); setDemoEnabled(data.enabled); if (!data.enabled || !data.accounts.length) setMode('credentials'); }).catch(e => { if (!controller.signal.aborted) { setDemoError((e as Error).message); setMode('credentials'); } }).finally(() => { if (!controller.signal.aborted) setDemoLoading(false); });
    return () => controller.abort();
  }, [retry]);
  useEffect(() => () => loginController.current?.abort(), []);
  async function login(body: unknown, key: string) {
    if (lock.current) return; lock.current = true;
    const controller = new AbortController(); loginController.current = controller;
    setError(''); setBusy(key);
    try { const result = await api<Session>('/auth/login', { method: 'POST', body, signal: controller.signal }); if (!controller.signal.aborted) onLogin(result.data); }
    catch (e) { if (!controller.signal.aborted) setError((e as Error).message); }
    finally { lock.current = false; if (!controller.signal.aborted) setBusy(null); }
  }
  function credentials(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); const fields = new FormData(event.currentTarget);
    void login({ login: String(fields.get('login') ?? '').trim(), password: fields.get('password') }, 'credentials');
  }
  const roleText = { employee: copy.loginRoleEmployee, manager: copy.loginRoleManager, hr: copy.loginRoleHr, admin: copy.loginRoleAdmin };
  const roleIcons = { employee: UserRound, manager: UsersRound, hr: Sprout, admin: ShieldCheck };
  return <div className="login-page"><header className="login-header"><Brand /><Language /></header>
    <main className="login-main"><section className="login-story"><div className="eyebrow"><span />{copy.loginEyebrow}</div><h1>{copy.loginTitle}</h1><p className="login-intro">{copy.loginIntro}</p>
      <div className="journey-art" aria-hidden="true"><div className="journey-orbit orbit-one" /><div className="journey-orbit orbit-two" /><div className="journey-orbit orbit-three" />
        <svg className="journey-path" viewBox="0 0 480 260" fill="none"><path d="M45 214C151 215 120 72 227 91C308 106 327 184 432 43" stroke="currentColor" strokeWidth="2" strokeDasharray="5 8" /><path d="m420 45 16-8-1 18" stroke="currentColor" strokeWidth="2" /></svg>
        <div className="journey-node node-one"><UserRound size={20} /><span>{t.profile}</span><span className="node-number">01</span></div><div className="journey-node node-two"><Compass size={20} /><span>{t.goal}</span><span className="node-number">02</span></div><div className="journey-node node-three"><Flag size={20} /><span>{t.development.toLocaleLowerCase(locale)}</span><span className="node-number">03</span></div>
      </div><div className="login-story-foot"><span className="little-star">✳</span><span>HackAlem.ai <span> / </span> Smart IT Solution</span></div>
    </section>
    <section className="login-panel" aria-labelledby="login-heading"><div className="login-panel-icon"><Fingerprint size={29} /></div><h2 id="login-heading">{copy.loginWelcome}</h2><p>{copy.loginSubtitle}</p>
      {notice && <div role="status" className="info-notice">{notice === 'expired' ? copy.sessionExpired : copy.signedOut}</div>}
      <div className="login-tabs" role="group" aria-label={copy.loginWelcome}><button type="button" className={mode === 'demo' ? 'selected' : ''} aria-pressed={mode === 'demo'} onClick={() => { setMode('demo'); setError(''); }} disabled={!!busy}>{copy.demoTab}</button><button type="button" className={mode === 'credentials' ? 'selected' : ''} aria-pressed={mode === 'credentials'} onClick={() => { setMode('credentials'); setError(''); }} disabled={!!busy}>{copy.credentialsTab}</button></div>
      {error && <ErrorState message={error} />}
      {mode === 'demo' ? <><p className="form-hint">{copy.demoHint}</p>{demoLoading ? <Loading /> : demoError ? <ErrorState message={demoError} retry={() => setRetry(value => value + 1)} /> : !demoEnabled || !accounts.length ? <div className="info-notice">{copy.noDemo}</div> : <div className="demo-accounts">{accounts.map(account => { const Icon = roleIcons[account.role]; return <button className="demo-account" key={account.id} disabled={!!busy} onClick={() => void login({ login: account.login, demo: true }, account.id)} data-testid={`demo-login-${account.role}`}><span className={`role-icon role-${account.role}`}><Icon size={21} /></span><span className="demo-account-copy"><strong>{t[account.role]}</strong><span>{roleText[account.role]}</span><small>{account.displayName}</small></span>{busy === account.id ? <span className="spinner" /> : <ArrowRight size={18} className="demo-arrow" />}</button>; })}</div>}</> : <form onSubmit={credentials} className="credentials-form"><p className="form-hint">{copy.credentialsHint}</p><label htmlFor="login">{t.login}</label><input id="login" name="login" placeholder={copy.loginPlaceholder} autoComplete="username" required maxLength={120} disabled={!!busy} data-testid="login-username" /><label htmlFor="password">{t.password}</label><div className="password-field"><input id="password" name="password" type={showPassword ? 'text' : 'password'} placeholder={copy.passwordPlaceholder} autoComplete="current-password" required maxLength={256} disabled={!!busy} data-testid="login-password" /><button type="button" aria-label={showPassword ? copy.passwordHide : copy.passwordShow} aria-pressed={showPassword} onClick={() => setShowPassword(value => !value)}>{showPassword ? <EyeOff size={19} /> : <Eye size={19} />}</button></div><Button type="submit" disabled={!!busy} className="login-submit" data-testid="login-submit">{busy ? <><span className="spinner" />{t.loading}</> : <>{t.signIn}<ArrowRight size={18} /></>}</Button></form>}
      <SsoButton /><div className="login-secure"><LockKeyhole size={14} aria-hidden="true" /><span>{copy.secureSession}</span></div>{mode === 'demo' && <p className="login-disclaimer">{copy.loginFooter}</p>}
    </section></main><footer className="login-footer"><span>© {new Date().getFullYear()} Career Quest</span><span>{t.tagline}</span></footer>
  </div>;
}
