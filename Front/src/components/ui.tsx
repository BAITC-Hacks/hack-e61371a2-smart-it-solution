import {cva,type VariantProps} from 'class-variance-authority';
import {twMerge} from 'tailwind-merge';
import {Slot} from '@radix-ui/react-slot';
import type {ButtonHTMLAttributes,ReactNode} from 'react';
import {AlertCircle,ArrowUpRight} from 'lucide-react';
import {useI18n} from '../i18n';
const button=cva('button',{variants:{variant:{primary:'button-primary',secondary:'button-secondary',ghost:'button-ghost'},size:{normal:'',small:'button-small'}},defaultVariants:{variant:'primary',size:'normal'}});
export function Button({variant,size,asChild,className,...props}:ButtonHTMLAttributes<HTMLButtonElement>&VariantProps<typeof button>&{asChild?:boolean}){const Component=asChild?Slot:'button';return <Component className={twMerge(button({variant,size}),className)} {...props}/>;}
export function Brand(){return <div className="brand"><span className="brand-icon"><ArrowUpRight size={24}/></span><span>Career<span className="brand-light">Quest</span><small>SMART IT SOLUTION</small></span></div>;}
export function Badge({children}:{children:ReactNode}){return <span className="badge">{children}</span>;}
export function Loading(){const{t}=useI18n();return <div className="state" role="status"><span className="spinner"/>{t.loading}</div>;}
export function ErrorState({message,retry}:{message:string;retry?:()=>void}){const{t}=useI18n();return <div className="error-state" role="alert"><AlertCircle size={20}/><span>{message}</span>{retry&&<Button variant="secondary" size="small" onClick={retry}>{t.retry}</Button>}</div>;}
export function Heading({title,subtitle,action}:{title:string;subtitle:string;action?:ReactNode}){return <div className="page-heading"><div><h1>{title}</h1><p>{subtitle}</p></div>{action}</div>;}
