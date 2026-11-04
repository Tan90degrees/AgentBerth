import type {ExtensionConfig} from '../../shared/extensions';
import {harnessManifest} from './manifest';

const defaults:ExtensionConfig=Object.fromEntries(Object.entries(harnessManifest.config).flatMap(([key,field])=>field.default===undefined?[]:[[key,field.default]]));

export function HarnessSettings({value,onChange,disabled}:{value:ExtensionConfig;onChange:(value:ExtensionConfig)=>void;disabled:boolean}){
  const isDefault=Object.keys(defaults).every(key=>value[key]===defaults[key]);
  return <section className="harness-settings" aria-label="Harness 启动设置">
    <header><h3>启动设置</h3><button type="button" className="extension-button subtle" disabled={disabled||isDefault} onClick={()=>onChange({...defaults})}>恢复默认</button></header>
    <label>启动程序<input aria-label="DeepSeek Harness 启动程序" spellCheck={false} value={String(value.executable??defaults.executable)} onChange={event=>onChange({...value,executable:event.target.value})} disabled={disabled}/></label>
    <details className="harness-advanced"><summary>高级选项</summary>
      <label>启动参数（JSON 数组）<textarea aria-label="DeepSeek Harness 启动参数" spellCheck={false} rows={5} value={String(value.args??defaults.args)} onChange={event=>onChange({...value,args:event.target.value})} disabled={disabled}/></label>
    </details>
  </section>;
}
