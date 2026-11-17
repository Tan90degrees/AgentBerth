import { setAppearance,setPalette,setUiFont,useAppearance,useAppearancePreference,usePalette,useUiFont } from './appearance';
import type { AppearanceMode } from '../shared/appearance';
import { paletteChoices,uiPalettes } from '../shared/ui-palettes';
import { uiFonts } from '../shared/ui-fonts';
import type { KeyboardEvent } from 'react';

function ThemeIcon({kind}:{kind:AppearanceMode}){
 return <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{kind==='light'?<><circle cx="12" cy="12" r="4"/><path d="M12 2v2m0 16v2M2 12h2m16 0h2M5 5l1.5 1.5m11 11L19 19M5 19l1.5-1.5m11-11L19 5"/></>:kind==='dark'?<path d="M20.5 14A9 9 0 0 1 10 3.5 9 9 0 1 0 20.5 14Z"/>:<><rect x="3" y="4" width="18" height="13" rx="2"/><path d="M8 21h8m-4-4v4"/></>}</svg>;
}
export function AppearanceToggle(){const theme=useAppearance();return <button className="appearance-toggle" aria-label={`切换为${theme==='dark'?'浅色':'深色'}模式`} title={`切换为${theme==='dark'?'浅色':'深色'}模式；更多选项见设置`} onClick={()=>setAppearance(theme==='dark'?'light':'dark')}><ThemeIcon kind={theme==='dark'?'light':'dark'}/><span className="activity-label">外观</span></button>;}
const modes:Array<{id:AppearanceMode;label:string}>=[{id:'light',label:'浅色'},{id:'dark',label:'深色'},{id:'system',label:'跟随系统'}];
// Radio groups retain roving focus when choosing a theme with the keyboard.
function radioKey(event:KeyboardEvent<HTMLButtonElement>,index:number,count:number,select:(index:number)=>void){
 if(!['ArrowLeft','ArrowRight','ArrowUp','ArrowDown','Home','End'].includes(event.key))return;
 event.preventDefault();const next=event.key==='Home'?0:event.key==='End'?count-1:(index+(['ArrowLeft','ArrowUp'].includes(event.key)?count-1:1))%count;
 select(next);event.currentTarget.parentElement?.querySelectorAll<HTMLElement>('[role="radio"]')[next]?.focus();
}
export function AppearanceControls(){
 const selected=useAppearancePreference(),palette=usePalette(),appearance=useAppearance();
 return <section className="settings-card appearance-card"><h2>外观</h2><div className="appearance-options" role="radiogroup" aria-label="外观主题">{modes.map((mode,index)=><button key={mode.id} type="button" role="radio" aria-checked={selected===mode.id} tabIndex={selected===mode.id?0:-1} className={selected===mode.id?'selected':''} onClick={()=>setAppearance(mode.id)} onKeyDown={event=>radioKey(event,index,modes.length,next=>setAppearance(modes[next].id))}><ThemeIcon kind={mode.id}/><span>{mode.label}</span></button>)}</div>
 <div className="palette-options" role="radiogroup" aria-label="配色主题">{paletteChoices.map((item,index)=>{const tokens=uiPalettes[item.id][appearance];return <button key={item.id} type="button" role="radio" aria-checked={palette===item.id} tabIndex={palette===item.id?0:-1} className={'palette-option'+(palette===item.id?' selected':'')} onClick={()=>setPalette(item.id)} onKeyDown={event=>radioKey(event,index,paletteChoices.length,next=>setPalette(paletteChoices[next].id))}><span className="palette-swatch" aria-hidden="true" style={{background:tokens['--bg'],borderColor:tokens['--border']}}>{['--primary','--accent','--selected'].map(name=><i key={name} style={{background:tokens[name]}}/>)}</span><span>{item.name}</span>{palette===item.id&&<span aria-hidden="true">✓</span>}</button>;})}</div></section>;
}
export function UiFontControls(){
 const value=useUiFont();return <section className="ui-font-controls"><label>界面字体<select aria-label="界面字体" value={value.font} onChange={event=>setUiFont({...value,font:event.target.value})}>{uiFonts.map(font=><option key={font.id} value={font.id}>{font.name}</option>)}</select></label>
 {value.font==='custom'&&<label>自定义界面字体<input aria-label="自定义界面字体" maxLength={100} placeholder="字体名称，如 Microsoft YaHei" value={value.customFont} onChange={event=>setUiFont({...value,customFont:event.target.value})}/></label>}
 <div className="ui-font-sample" aria-label="字体预览">泊栈 AgentBerth · Aa 0123456789</div><button type="button" className="text-button" onClick={()=>setUiFont({font:'system',customFont:''})} disabled={value.font==='system'&&!value.customFont}>恢复系统字体</button></section>;
}
