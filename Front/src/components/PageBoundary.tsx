import { Component, type ReactNode } from 'react';
import { useI18n } from '../i18n';
import { navigationCopy } from '../navigation.copy';
import { Button, EmptyState } from './ui';
class Boundary extends Component<{children:ReactNode;title:string;text:string;retry:string},{failed:boolean}> {
  state={failed:false};
  static getDerivedStateFromError(){return {failed:true};}
  render(){return this.state.failed?<div className="card" role="alert"><EmptyState title={this.props.title} description={this.props.text} action={<Button onClick={()=>this.setState({failed:false})}>{this.props.retry}</Button>}/></div>:this.props.children;}
}
export function PageBoundary({children}:{children:ReactNode}){const {locale}=useI18n();const copy=navigationCopy[locale];return <Boundary title={copy.pageError} text={copy.pageErrorText} retry={copy.retry}>{children}</Boundary>;}
