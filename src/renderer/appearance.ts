import { useSyncExternalStore } from 'react';
import { appearanceMode,resolveAppearance,type AppearanceMode,type ResolvedAppearance } from '../shared/appearance';
import { readStored,saveStored } from './storage';

const key='berth.appearance';
let preference:AppearanceMode='system',resolved:ResolvedAppearance='light',media:MediaQueryList|null=null,initialized=false;
const listeners=new Set<()=>void>();
const subscribe=(listener:()=>void)=>{listeners.add(listener);return()=>{listeners.delete(listener);};};
function apply(){
  resolved=resolveAppearance(preference,media?.matches??false);
  document.documentElement.dataset.theme=resolved;document.documentElement.style.colorScheme=resolved;
  void window.berth?.setAppearance?.(preference).catch(()=>{});
  for(const listener of listeners)listener();
}
export function initializeAppearance(){
  if(initialized)return;initialized=true;
  preference=appearanceMode(readStored(key));media=window.matchMedia('(prefers-color-scheme: dark)');
  media.addEventListener('change',()=>{if(preference==='system')apply();});
  window.addEventListener('storage',event=>{if(event.key===key||event.key===null){preference=appearanceMode(readStored(key));apply();}});
  apply();
}
export function setAppearance(value:AppearanceMode){preference=value;saveStored(key,value);apply();}
export function useAppearance(){return useSyncExternalStore(subscribe,()=>resolved);}
export function useAppearancePreference(){return useSyncExternalStore(subscribe,()=>preference);}
