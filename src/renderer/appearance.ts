import { useSyncExternalStore } from 'react';
import { appearanceMode,resolveAppearance,terminalPalette,type AppearanceMode,type ResolvedAppearance } from '../shared/appearance';
import { uiPalette,uiPalettes,type UiPalette } from '../shared/ui-palettes';
import { normalizeUiFont,uiFontFamily,type UiFont } from '../shared/ui-fonts';
import { glassStyle } from '../shared/glass-style';
import { readStored,saveStored } from './storage';

const key='berth.appearance',paletteKey='berth.palette',fontKey='berth.uiFont';
let preference:AppearanceMode='dark',resolved:ResolvedAppearance='dark',palette:UiPalette='classic',font=normalizeUiFont(null),media:MediaQueryList|null=null,initialized=false;
const listeners=new Set<()=>void>();
const subscribe=(listener:()=>void)=>{listeners.add(listener);return()=>{listeners.delete(listener);};};
function readFont(){try{return normalizeUiFont(JSON.parse(readStored(fontKey)??'null'));}catch{return normalizeUiFont(null);}}
function apply(){
  resolved=resolveAppearance(preference,media?.matches??false);
  const root=document.documentElement;
  root.dataset.theme=resolved;root.dataset.palette=palette;root.style.colorScheme=resolved;
  for(const [name,value] of Object.entries(uiPalettes[palette][resolved]))root.style.setProperty(name,value);
  root.style.setProperty('--palette',palette);root.style.setProperty('--font-sans',uiFontFamily(font));
  void window.berth?.setAppearance?.(preference,resolved,palette).catch(()=>{});
  for(const listener of listeners)listener();
}
export function initializeAppearance(){
  if(initialized)return;initialized=true;
  preference=appearanceMode(readStored(key));palette=uiPalette(readStored(paletteKey));font=readFont();
  const style=document.createElement('style');style.textContent=glassStyle;document.head.append(style);
  media=window.matchMedia('(prefers-color-scheme: dark)');
  media.addEventListener('change',()=>{if(preference==='system')apply();});
  window.addEventListener('storage',event=>{if(event.storageArea&&event.storageArea!==localStorage)return;if(event.key===key||event.key===paletteKey||event.key===fontKey||event.key===null){preference=appearanceMode(readStored(key));palette=uiPalette(readStored(paletteKey));font=readFont();apply();}});
  apply();
}
export function setAppearance(value:AppearanceMode){preference=value;saveStored(key,value);apply();}
export function setPalette(value:UiPalette){palette=uiPalette(value);saveStored(paletteKey,palette);apply();}
export function setUiFont(value:UiFont){font=normalizeUiFont(value);saveStored(fontKey,JSON.stringify(font));apply();}
export function useAppearance(){return useSyncExternalStore(subscribe,()=>resolved);}
export function useAppearancePreference(){return useSyncExternalStore(subscribe,()=>preference);}
export function usePalette(){return useSyncExternalStore(subscribe,()=>palette);}
export function useUiFont(){return useSyncExternalStore(subscribe,()=>font);}
export function useTerminalTheme(){return terminalPalette(useAppearance(),usePalette());}
