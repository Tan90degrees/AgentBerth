import {test} from 'node:test';
import assert from 'node:assert/strict';
import {appearanceMode,resolveAppearance,terminalPalette,terminalThemes} from '../src/shared/appearance';
import {uiPalettes,uiPalette,paletteChoices} from '../src/shared/ui-palettes';
import {normalizeUiFont,uiFontFamily} from '../src/shared/ui-fonts';

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
// Composite translucent glass surfaces against their opaque base before measuring.
function composite(color:string,base:string){if(color.length===7)return color;const alpha=parseInt(color.slice(7,9),16)/255;return '#'+[1,3,5].map(i=>Math.round(parseInt(color.slice(i,i+2),16)*alpha+parseInt(base.slice(i,i+2),16)*(1-alpha)).toString(16).padStart(2,'0')).join('');}
test('all palette families keep readable text, actions and selected controls in both modes',()=>{
 const keys=Object.keys(uiPalettes.classic.light).sort();
 for(const family of paletteChoices)for(const mode of ['light','dark'] as const){const colors=uiPalettes[family.id][mode],color=(key:string)=>composite(colors['--'+key],colors['--bg']);assert.deepEqual(Object.keys(colors).sort(),keys);
  for(const [a,b,min] of [['text','surface',7],['text-muted','surface',4.5],['on-primary','primary',4.5],['text','selected',4.5],['accent','accent-soft',4.5],['text','panel',7]] as const)assert.ok(contrast(color(a),color(b))>=min,`${family.id} ${mode} ${a}/${b}: ${contrast(color(a),color(b))}`);
  const terminal=terminalPalette(mode,family.id);assert.equal(terminal,terminalPalette(mode,family.id));assert.ok(contrast(terminal.foreground!,terminal.background!)>=7);assert.ok(contrast(terminal.foreground!,terminal.selectionBackground!)>=4.5);assert.match(terminal.background!,/^#[0-9a-f]{6}$/);
 }
});
test('old installations retain the classic palette and local font preferences normalize safely',()=>{
 for(const value of [undefined,null,'',{},'unknown'])assert.equal(uiPalette(value),'classic');
 assert.equal(uiPalettes.classic.dark['--bg'],'#212121');assert.equal(uiPalettes.classic.light['--primary'],'#212121');
 assert.deepEqual(normalizeUiFont(null),{font:'system',customFont:''});assert.equal(normalizeUiFont({font:'missing'}).font,'system');assert.equal(normalizeUiFont({customFont:'a\nb'}).customFont,'ab');
 const font=normalizeUiFont({font:'custom',customFont:'Example"; color: red; /*'});assert.equal(uiFontFamily(font).split(', ')[0],JSON.stringify(font.customFont));assert.equal(normalizeUiFont({customFont:'a'.repeat(101)}).customFont.length,100);assert.equal(uiFontFamily({font:'custom',customFont:'  '}),uiFontFamily(normalizeUiFont(null)));
});
