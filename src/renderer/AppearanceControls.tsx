import { setAppearance,useAppearance,useAppearancePreference } from './appearance';
import type { AppearanceMode } from '../shared/appearance';

function ThemeIcon({kind}:{kind:AppearanceMode}){
 return <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{kind==='light'?<><circle cx="12" cy="12" r="4"/><path d="M12 2v2m0 16v2M2 12h2m16 0h2M5 5l1.5 1.5m11 11L19 19M5 19l1.5-1.5m11-11L19 5"/></>:kind==='dark'?<path d="M20.5 14A9 9 0 0 1 10 3.5 9 9 0 1 0 20.5 14Z"/>:<><rect x="3" y="4" width="18" height="13" rx="2"/><path d="M8 21h8m-4-4v4"/></>}</svg>;
}
export function AppearanceToggle(){const theme=useAppearance();return <button className="appearance-toggle" aria-label={`切换为${theme==='dark'?'浅色':'深色'}模式`} title={`切换为${theme==='dark'?'浅色':'深色'}模式；更多选项见设置`} onClick={()=>setAppearance(theme==='dark'?'light':'dark')}><ThemeIcon kind={theme==='dark'?'light':'dark'}/></button>;}
const modes:Array<{id:AppearanceMode;label:string}>=[{id:'light',label:'浅色'},{id:'dark',label:'深色'},{id:'system',label:'跟随系统'}];
export function AppearanceControls(){
 const selected=useAppearancePreference();return <section className="settings-card appearance-card"><div><h2>外观</h2><p>选择更适合你的界面。立即生效，自动保存。</p></div><div className="appearance-options" role="radiogroup" aria-label="外观主题">{modes.map((mode,index)=><button key={mode.id} type="button" role="radio" aria-checked={selected===mode.id} tabIndex={selected===mode.id?0:-1} className={selected===mode.id?'selected':''} onClick={()=>setAppearance(mode.id)} onKeyDown={event=>{if(['ArrowLeft','ArrowRight','Home','End'].includes(event.key)){event.preventDefault();const next=event.key==='Home'?0:event.key==='End'?2:(index+(event.key==='ArrowLeft'?2:1))%3;setAppearance(modes[next].id);event.currentTarget.parentElement?.querySelectorAll<HTMLElement>('[role="radio"]')[next]?.focus();}}}><ThemeIcon kind={mode.id}/><span>{mode.label}</span></button>)}</div></section>;
}
