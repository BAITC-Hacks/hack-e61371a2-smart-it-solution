import { useEffect, useRef, useState, type ReactNode } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import { Link, useLocation } from 'wouter';
import { Bell, BookOpen, ChevronRight, Compass, Flag, History, LayoutDashboard, LibraryBig, LogOut, Menu, MessageCircle, Settings, ShieldCheck, Sprout, TrendingUp, UploadCloud, UserRound, UsersRound, X } from 'lucide-react';
import type { User } from '../api';
import { appCopy } from '../app.copy';
import { Language, useI18n } from '../i18n';
import { Avatar, Badge, Brand, Button } from './ui';
import { navigationCopy } from '../navigation.copy';
import { InstallApp } from './InstallApp';

export function Shell({ user, busy, onLogout, children }: { user: User; busy: boolean; onLogout: () => void; children: ReactNode }) {
  const { locale, t } = useI18n(); const copy = appCopy[locale]; const navCopy = navigationCopy[locale];
  const [location] = useLocation(); const [menuOpen, setMenuOpen] = useState(false);
  const openedAt = useRef(location);
  const staff = user.role === 'hr' || user.role === 'admin';
  const groups = [{title:navCopy.personal,items:[
    { href: '/', label: copy.overview, icon: LayoutDashboard },
    ...(user.employeeId ? [{ href: '/profile', label: t.profile, icon: UserRound }] : []),
    ...(user.employeeId ? [{href:'/development',label:navCopy.development,icon:TrendingUp},{href:'/growth',label:navCopy.growth,icon:Sprout},{href:'/history',label:navCopy.history,icon:History}] : []),
  ]},{title:navCopy.learning,items:[
    {href:'/events',label:navCopy.events,icon:BookOpen},
    {href:'/guide',label:navCopy.guide,icon:Compass},
    {href:'/assistant',label:navCopy.assistant,icon:MessageCircle},
  ]},{title:navCopy.organization,items:[
    ...(user.role !== 'employee' ? [{ href: '/people', label: user.role === 'manager' ? t.team : t.people, icon: UsersRound }] : []),
    ...(staff || user.role === 'manager' ? [{href:'/hr',label:navCopy.hr,icon:TrendingUp}] : []),
    ...(user.employeeId ? [{href:'/notifications',label:navCopy.notifications,icon:Bell}] : []),
    { href: '/access', label: t.access, icon: ShieldCheck },
  ]},{title:navCopy.administration,items:[
    ...(staff ? [{href:'/events/manage',label:navCopy.eventsAdmin,icon:BookOpen},{href:'/guide/manage',label:navCopy.guideAdmin,icon:LibraryBig},{href:'/admin/growth',label:navCopy.growthAdmin,icon:Flag}] : []),
    ...(user.role === 'admin' ? [{ href: '/admin/imports', label: t.imports, icon: UploadCloud }] : []),
    ...(user.role === 'admin' ? [{href:'/admin/settings',label:navCopy.settings,icon:Settings}] : []),
  ]}].filter(group=>group.items.length);
  const items=groups.flatMap(group=>group.items);
  const active = [...items].sort((a,b)=>b.href.length-a.href.length).find(item => item.href === '/' ? location === '/' : location === item.href || location.startsWith(`${item.href}/`));
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
      <nav className="side-nav" aria-label={copy.navigation}>
        {groups.map(group=><div className="nav-group" key={group.title}><div className="sidebar-section-label">{group.title}</div>{group.items.map(({ href, label, icon: Icon }) => {
          const selected = active?.href === href;
          return <Link key={href} href={href} className={`side-nav-link${selected ? ' is-active' : ''}`} aria-current={selected ? 'page' : undefined} onClick={() => setMenuOpen(false)}><Icon size={20} aria-hidden="true" /><span>{label}</span>{selected && <span className="nav-active-dot" />}</Link>;
        })}</div>)}
      </nav>
      <div className="sidebar-bottom"><InstallApp />
        <div className="sidebar-account"><Avatar name={user.displayName} size="small" /><div><strong>{user.displayName}</strong><span>{t[user.role]}</span></div></div>
        <Button variant="ghost" onClick={onLogout} disabled={busy} className="logout-button" data-testid="logout"><LogOut size={17} aria-hidden="true" />{busy ? t.loading : t.logout}</Button>
      </div></>;
  }
  return <div className="app-shell"><a className="skip-link" href="#main-content">{copy.skip}</a>
    <aside className="sidebar">{sidebar()}</aside>
    <div className="workspace-frame"><header className="topbar">
      <Dialog.Root open={menuOpen} onOpenChange={open=>{if(open)openedAt.current=location;setMenuOpen(open);}}>
        <Dialog.Trigger asChild><Button variant="ghost" className="mobile-menu-button icon-button" aria-label={t.menu}><Menu size={22} /></Button></Dialog.Trigger>
        <Dialog.Portal><Dialog.Overlay className="drawer-overlay" /><Dialog.Content className="mobile-drawer" onCloseAutoFocus={event=>{if(openedAt.current!==location){event.preventDefault();document.querySelector<HTMLElement>('#main-content')?.focus({preventScroll:true});}}}><Dialog.Title className="sr-only">{copy.navigation}</Dialog.Title><Dialog.Description className="sr-only">{copy.space}</Dialog.Description><Dialog.Close asChild><Button variant="ghost" className="drawer-close icon-button" aria-label={t.close}><X size={21} /></Button></Dialog.Close>{sidebar()}</Dialog.Content></Dialog.Portal>
      </Dialog.Root>
      <div className="breadcrumbs"><span>{copy.space}</span><ChevronRight size={14} aria-hidden="true" /><strong>{active?.label ?? t.profile}</strong></div>
      <div className="topbar-actions">{user.demo && <Badge tone="demo"><span className="status-dot" />{copy.demoNote}</Badge>}<Language /><div className="topbar-avatar" title={user.displayName}><Avatar name={user.displayName} size="small" /></div></div>
    </header>
    <main id="main-content" className="main-content" tabIndex={-1}>{children}</main>
    <footer className="app-footer"><span>© {new Date().getFullYear()} Career Quest</span><span>Smart IT Solution <span className="footer-dot">·</span> HackAlem.ai</span></footer></div>
  </div>;
}
