import test from 'node:test';
import assert from 'node:assert/strict';
import {JSDOM} from 'jsdom';
import {initializeAppearance,setAppearance,setPalette,setUiFont} from '../src/renderer/appearance';
import {uiPalettes} from '../src/shared/ui-palettes';
import {extensionDocument} from '../src/extensions/view-document';

test('palette, mode and font persist independently, restore on startup and synchronize cross-window',async t=>{
 const dom=new JSDOM('<!doctype html><head></head><body></body>',{url:'https://fixture.invalid'}),win=dom.window;
 const previous=new Map(['window','document','localStorage'].map(key=>[key,Object.getOwnPropertyDescriptor(globalThis,key)]));
 for(const [key,value] of Object.entries({window:win,document:win.document,localStorage:win.localStorage}))Object.defineProperty(globalThis,key,{value,configurable:true,writable:true});
 t.after(()=>{dom.window.close();for(const [key,descriptor] of previous)if(descriptor)Object.defineProperty(globalThis,key,descriptor);else Reflect.deleteProperty(globalThis,key);});
 let dark=false;const mediaListeners:Array<()=>void>=[],calls:unknown[][]=[];
 Object.defineProperty(win,'matchMedia',{value:()=>({get matches(){return dark;},addEventListener:(_type:string,fn:()=>void)=>mediaListeners.push(fn)})});
 (win as any).berth={setAppearance:async(...args:unknown[])=>{calls.push(args);}};
 win.localStorage.setItem('berth.palette','glass');win.localStorage.setItem('berth.appearance','system');win.localStorage.setItem('berth.uiFont',JSON.stringify({font:'custom',customFont:'Example Font'}));
 initializeAppearance();const root=win.document.documentElement;assert.equal(root.dataset.palette,'glass');assert.equal(root.dataset.theme,'light');assert.match(root.style.getPropertyValue('--font-sans'),/^"Example Font",/);
 assert.equal(root.style.getPropertyValue('--bg'),uiPalettes.glass.light['--bg']);
 dark=true;mediaListeners.forEach(fn=>fn());assert.equal(root.dataset.theme,'dark');assert.equal(root.style.getPropertyValue('--bg'),uiPalettes.glass.dark['--bg']);
 setPalette('claude');assert.equal(root.dataset.theme,'dark');assert.equal(win.localStorage.getItem('berth.palette'),'claude');setUiFont({font:'serif',customFont:''});assert.equal(root.dataset.palette,'claude');assert.match(root.style.getPropertyValue('--font-sans'),/^Georgia/);
 setAppearance('light');dark=true;mediaListeners.forEach(fn=>fn());assert.equal(root.dataset.theme,'light');
 win.localStorage.setItem('berth.palette','ocean');win.localStorage.setItem('berth.uiFont','invalid json');win.dispatchEvent(new win.StorageEvent('storage',{key:'berth.palette'}));assert.equal(root.dataset.palette,'ocean');assert.match(root.style.getPropertyValue('--font-sans'),/^-apple-system/);assert.deepEqual(calls.at(-1),['light','light','ocean']);
 win.localStorage.clear();win.dispatchEvent(new win.StorageEvent('storage',{key:null}));assert.equal(root.dataset.palette,'classic');assert.equal(root.dataset.theme,'dark');
});

test('HTML plugin theme bridge mirrors glass and long custom font stacks only from its owning host',()=>{
 const dom=new JSDOM(extensionDocument(''),{runScripts:'dangerously',url:'https://fixture.invalid'}),win=dom.window;
 try{
  const theme={'--palette':'glass','--font-sans':'"'+ 'Long Font '.repeat(40)+'", sans-serif','--bg':uiPalettes.glass.dark['--bg']};
  win.dispatchEvent(new win.MessageEvent('message',{source:{} as any,data:{kind:'agentberth-plugin-theme',theme}}));assert.equal(win.document.documentElement.dataset.palette,undefined);
  win.dispatchEvent(new win.MessageEvent('message',{source:win as unknown as Window,data:{kind:'agentberth-plugin-theme',theme}}));assert.equal(win.document.documentElement.dataset.palette,'glass');assert.equal(win.document.documentElement.style.getPropertyValue('--font-sans'),theme['--font-sans']);
  win.dispatchEvent(new win.MessageEvent('message',{source:win as unknown as Window,data:{kind:'agentberth-plugin-theme',theme:{'--palette':'invalid'}}}));assert.equal(win.document.documentElement.dataset.palette,'glass');
 }finally{win.close();}
});
