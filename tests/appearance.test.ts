import {test} from 'node:test';
import assert from 'node:assert/strict';
import {appearanceMode,resolveAppearance,terminalThemes} from '../src/shared/appearance';

test('appearance preference tolerates old/unavailable storage and follows system only when requested',()=>{
 for(const value of [null,undefined,'',false,{},'invalid'])assert.equal(appearanceMode(value),'system');
 assert.equal(appearanceMode('light'),'light');assert.equal(appearanceMode('dark'),'dark');
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
