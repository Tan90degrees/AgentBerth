import type { ResolvedAppearance } from '../shared/appearance';
import type { DaemonConnection } from './connection';

/** Serialize rapid switches; negotiate once per connection. A compatible old
 * daemon stays attached until the user chooses to update an idle backend. */
export class TerminalAppearanceSync {
  private target:DaemonConnection|null=null;
  private chain:Promise<void>=Promise.resolve();
  private api:number|undefined;
  private last:ResolvedAppearance|undefined;
  sync(target:DaemonConnection,appearance:ResolvedAppearance):Promise<void>{
    if(target!==this.target){this.target=target;this.chain=Promise.resolve();this.api=undefined;this.last=undefined;}
    const next=this.chain.catch(()=>{}).then(async()=>{
      if(target!==this.target||!target.connected)return;
      if(this.api===undefined){const state=await target.rpc<{apiVersion:number}>('state');if(target!==this.target)return;this.api=state.apiVersion;}
      if(this.api<62||this.last===appearance)return;
      await target.rpc('terminalAppearance',{appearance});
      if(target===this.target)this.last=appearance;
    });
    this.chain=next;return next;
  }
}
