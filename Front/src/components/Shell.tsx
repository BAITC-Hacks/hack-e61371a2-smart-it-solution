import { useEffect, useState, type ReactNode } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import { Link, useLocation } from 'wouter';
import { ArrowUpRight, ChevronRight, LayoutDashboard, LogOut, Menu, ShieldCheck, UploadCloud, UserRound, UsersRound, X } from 'lucide-react';
import type { User } from '../api';
import { appCopy } from '../app.copy';
import { Language, useI18n } from '../i18n';
import { Avatar, Badge, Brand, Button } from './ui';

export function Shell({ user, busy, onLogout, children }: { user: User; busy: boolean; onLogout: () => void; children: ReactNode }) {
  const { locale, t } = useI18n(); const copy = appCopy[locale];
  const [location] = useLocation(); const [menuOpen, setMenuOpen] = useState(false);
  const items = [
    { href: '/', label: copy.overview, icon: LayoutDashboard },
    ...(user.employeeId ? [{ href: '/profile', label: t.profile, icon: UserRound }] : []),
    ...(user.role !== 'employee' ? [{ href: '/people', label: user.role === 'manager' ? t.team : t.people, icon: UsersRound }] : []),
    ...(user.role === 'admin' ? [{ href: '/admin/imports', label: t.imports, icon: UploadCloud }] : []),
    { href: '/access', label: t.access, icon: ShieldCheck },
  ];
  const active = items.find(item => item.href === '/' ? location === '/' : location.startsWith(item.href));
  useEffect(() => {
    document.title = `${active?.label ?? t.profile} · Career Quest`;
  }, [active?.label, t.profile]);
  useEffect(() => {
    setMenuOpen(false);
    const frame = requestAnimationFrame(() => document.querySelector<HTMLElement>('#main-content')?.focus({ preventScroll: true }));
    return () => cancelAnimationFrame(frame);
  }, [location]);
  function sidebar() {
    return <><Link className="brand-link" href="/" aria-label="Career Quest"><Brand /></Link>
      <div className="sidebar-section-label">{copy.space}</div>
      <nav className="side-nav" aria-label={copy.navigation}>
        {items.map(({ href, label, icon: Icon }) => {
          const selected = href === '/' ? location === '/' : location.startsWith(href);
          return <Link key={href} href={href} className={`side-nav-link${selected ? ' is-active' : ''}`} aria-current={selected ? 'page' : undefined} onClick={() => setMenuOpen(false)}><Icon size={20} aria-hidden="true" /><span>{label}</span>{selected && <span className="nav-active-dot" />}</Link>;
        })}
      </nav>
      <div className="sidebar-bottom"><div className="sidebar-note"><span className="sidebar-note-icon"><ArrowUpRight size={23} /></span><p>{t.tagline}</p><span>Career Quest</span></div>
        <div className="sidebar-account"><Avatar name={user.displayName} size="small" /><div><strong>{user.displayName}</strong><span>{t[user.role]}</span></div></div>
        <Button variant="ghost" onClick={onLogout} disabled={busy} className="logout-button" data-testid="logout"><LogOut size={17} aria-hidden="true" />{busy ? t.loading : t.logout}</Button>
      </div></>;
  }
  return <div className="app-shell"><a className="skip-link" href="#main-content">{copy.skip}</a>
    <aside className="sidebar">{sidebar()}</aside>
    <div className="workspace-frame"><header className="topbar">
      <Dialog.Root open={menuOpen} onOpenChange={setMenuOpen}>
        <Dialog.Trigger asChild><Button variant="ghost" className="mobile-menu-button icon-button" aria-label={t.menu}><Menu size={22} /></Button></Dialog.Trigger>
        <Dialog.Portal><Dialog.Overlay className="drawer-overlay" /><Dialog.Content className="mobile-drawer"><Dialog.Title className="sr-only">{copy.navigation}</Dialog.Title><Dialog.Description className="sr-only">{copy.space}</Dialog.Description><Dialog.Close asChild><Button variant="ghost" className="drawer-close icon-button" aria-label={t.close}><X size={21} /></Button></Dialog.Close>{sidebar()}</Dialog.Content></Dialog.Portal>
      </Dialog.Root>
      <div className="breadcrumbs"><span>{copy.space}</span><ChevronRight size={14} aria-hidden="true" /><strong>{active?.label ?? t.profile}</strong></div>
      <div className="topbar-actions">{user.demo && <Badge tone="demo"><span className="status-dot" />{copy.demoNote}</Badge>}<Language /><div className="topbar-avatar" title={user.displayName}><Avatar name={user.displayName} size="small" /></div></div>
    </header>
    <main id="main-content" className="main-content" tabIndex={-1}>{children}</main>
    <footer className="app-footer"><span>© {new Date().getFullYear()} Career Quest</span><span>Smart IT Solution <span className="footer-dot">·</span> HackAlem.ai</span></footer></div>
  </div>;
}
