import {test} from 'node:test';
import assert from 'node:assert/strict';
import {appearanceMode,resolveAppearance,terminalThemes} from '../src/shared/appearance';
import {readFile} from 'node:fs/promises';

test('appearance preference tolerates old/unavailable storage and follows system only when requested',()=>{
 for(const value of [null,undefined,'',false,{},'invalid'])assert.equal(appearanceMode(value),'dark');
 assert.equal(appearanceMode('system'),'system');assert.equal(appearanceMode('light'),'light');assert.equal(appearanceMode('dark'),'dark');
 assert.equal(resolveAppearance('system',true),'dark');assert.equal(resolveAppearance('system',false),'light');
 assert.equal(resolveAppearance('light',true),'light');assert.equal(resolveAppearance('dark',false),'dark');
});
function contrast(a:string,b:string){const luminance=(hex:string)=>{const parts=hex.slice(1).match(/../g)!.map(x=>parseInt(x,16)/255).map(x=>x<=.04045?x/12.92:((x+.055)/1.055)**2.4);return parts[0]*.2126+parts[1]*.7152+parts[2]*.0722;};const x=luminance(a),y=luminance(b);return(Math.max(x,y)+.05)/(Math.min(x,y)+.05);}
test('both terminal palettes keep default text, cursor and selections readable',()=>{
 for(const theme of Object.values(terminalThemes)){
  assert.ok(contrast(theme.foreground!,theme.background!)>=7);
  assert.ok(contrast(theme.cursor!,theme.background!)>=7);
  assert.ok(contrast(theme.foreground!,theme.selectionBackground!)>=4.5);
  assert.ok(contrast(theme.cursorAccent!,theme.cursor!)>=7);
 }
});
test('light and dark workspace palettes keep readable text, colored actions and selection contrast',async()=>{
 const css=await readFile('src/renderer/tokens.css','utf8'),parts=css.split(":root[data-theme='dark']");
 for(const part of parts){const values=new Map([...part.matchAll(/--([\w-]+):\s*(#[\da-f]{6});/gi)].map(match=>[match[1],match[2]])),color=(key:string)=>{const value=values.get(key);assert.ok(value,key);return value;};
  assert.ok(contrast(color('text'),color('surface'))>=7);assert.ok(contrast(color('text-muted'),color('surface'))>=4.5);assert.ok(contrast(color('on-primary'),color('primary'))>=4.5);assert.ok(contrast(color('text'),color('selected'))>=4.5);assert.ok(contrast(color('accent'),color('accent-soft'))>=4.5);
 }
});
