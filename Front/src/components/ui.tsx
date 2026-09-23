import { cva, type VariantProps } from 'class-variance-authority';
import { twMerge } from 'tailwind-merge';
import { Slot } from '@radix-ui/react-slot';
import type { ButtonHTMLAttributes, ReactNode } from 'react';
import { AlertCircle, ArrowUpRight, Inbox } from 'lucide-react';
import { useI18n } from '../i18n';

const button = cva('button', {
  variants: { variant: { primary: 'button-primary', secondary: 'button-secondary', ghost: 'button-ghost', danger: 'button-danger' }, size: { normal: '', small: 'button-small' } },
  defaultVariants: { variant: 'primary', size: 'normal' },
});
export function Button({ variant, size, asChild, className, type, ...props }: ButtonHTMLAttributes<HTMLButtonElement> & VariantProps<typeof button> & { asChild?: boolean }) {
  const Component = asChild ? Slot : 'button';
  return <Component type={asChild ? undefined : type ?? 'button'} className={twMerge(button({ variant, size }), className)} {...props} />;
}
export function Brand() {
  return <span className="brand"><span className="brand-icon" aria-hidden="true"><ArrowUpRight size={25} strokeWidth={2.3} /></span><span>Career<span className="brand-light">Quest</span><small>SMART IT SOLUTION</small></span></span>;
}
export function Badge({ children, tone = 'neutral' }: { children: ReactNode; tone?: string }) { return <span className={`badge badge-${tone}`}>{children}</span>; }
export function Avatar({ name, size = 'normal' }: { name: string; size?: 'small' | 'normal' | 'large' }) {
  const initials = name.trim().split(/\s+/).slice(0, 2).map(word => Array.from(word)[0]).join('').toLocaleUpperCase();
  return <span className={`avatar avatar-${size}`} aria-hidden="true">{initials || '?'}</span>;
}
export function Loading({ label }: { label?: string }) {
  const { t } = useI18n();
  return <div className="state loading-state" role="status"><span className="spinner" aria-hidden="true" /><span>{label ?? t.loading}</span></div>;
}
export function ErrorState({ message, retry }: { message: string; retry?: () => void }) {
  const { t } = useI18n();
  return <div className="error-state" role="alert"><AlertCircle size={21} aria-hidden="true" /><span>{message}</span>{retry && <Button variant="secondary" size="small" onClick={retry}>{t.retry}</Button>}</div>;
}
export function EmptyState({ title, description, action }: { title: string; description?: string; action?: ReactNode }) {
  return <div className="empty-state"><span className="empty-icon"><Inbox size={27} aria-hidden="true" /></span><h2>{title}</h2>{description && <p>{description}</p>}{action}</div>;
}
export function Heading({ title, subtitle, action }: { title: string; subtitle?: string; action?: ReactNode }) {
  return <div className="page-heading"><div><h1>{title}</h1>{subtitle && <p>{subtitle}</p>}</div>{action && <div className="heading-action">{action}</div>}</div>;
}
