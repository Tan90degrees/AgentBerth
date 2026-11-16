import type { Terminal } from '@xterm/headless';
import { terminalThemes, type ResolvedAppearance } from '../shared/appearance';

const ansi = ['black','red','green','yellow','blue','magenta','cyan','white','brightBlack','brightRed','brightGreen','brightYellow','brightBlue','brightMagenta','brightCyan','brightWhite'] as const;
function rgb(value:string):string|null {
  const parts=value.startsWith('#')&&[3,6,9,12].includes(value.length-1)?value.slice(1).match(new RegExp('.{'+((value.length-1)/3)+'}','g')):value.match(/^rgb:([\da-f]{1,4})\/([\da-f]{1,4})\/([\da-f]{1,4})$/i)?.slice(1);
  if(!parts||parts.length!==3||parts.some(part=>!/^[\da-f]{1,4}$/i.test(part)))return null;
  return 'rgb:'+parts.map(part=>Math.round(parseInt(part,16)/((16**part.length)-1)*65535).toString(16).padStart(4,'0')).join('/');
}
function indexed(index:number,appearance:ResolvedAppearance):string {
  if(index<16)return terminalThemes[appearance][ansi[index]]!;
  if(index>=232){const value=(8+(index-232)*10).toString(16).padStart(2,'0');return '#'+value.repeat(3);}
  const value=index-16,levels=[0,95,135,175,215,255];
  return '#'+[Math.floor(value/36),Math.floor(value/6)%6,value%6].map(n=>levels[n].toString(16).padStart(2,'0')).join('');
}

/** The daemon owns replies even without a renderer or while an Agent owns SSH.
 * Contour DEC 2031: https://contour-terminal.org/vt-extensions/color-palette-update-notifications/
 * Do not inject notifications into applications that did not subscribe. */
export function terminalAppearance(terminal:Terminal,initial:ResolvedAppearance,send:(data:string)=>void){
  let appearance=initial,enabled=false;
  const overrides=new Map<number,string>();
  const report=()=>send(`\x1b[?997;${appearance==='dark'?1:2}n`);
  for(const final of ['h','l'])terminal.parser.registerCsiHandler({prefix:'?',final},params=>{if(params.includes(2031))enabled=final==='h';return false;});
  terminal.parser.registerCsiHandler({prefix:'?',intermediates:'$',final:'p'},params=>{if(params.length!==1||params[0]!==2031)return false;send(`\x1b[?2031;${enabled?1:2}$y`);return true;});
  terminal.parser.registerCsiHandler({prefix:'?',final:'n'},params=>{if(params.length!==1||params[0]!==996)return false;report();return true;});
  terminal.parser.registerEscHandler({final:'c'},()=>{enabled=false;overrides.clear();return false;});
  terminal.parser.registerCsiHandler({intermediates:'!',final:'p'},()=>{enabled=false;return false;});
  const color=(key:number)=>overrides.get(key)??rgb(key<256?indexed(key,appearance):terminalThemes[appearance][key===256?'foreground':key===257?'background':'cursor']!)!;
  terminal.parser.registerOscHandler(4,data=>{
    if(data.length>4096)return false;const parts=data.split(';');
    for(let i=0;i+1<parts.length;i+=2){if(!/^\d{1,3}$/.test(parts[i]))continue;const key=Number(parts[i]);if(key>255)continue;
      if(parts[i+1]==='?')send(`\x1b]4;${key};${color(key)}\x1b\\`);else {const value=rgb(parts[i+1]);if(value)overrides.set(key,value);}
    }
    return true;
  });
  for(const code of [10,11,12])terminal.parser.registerOscHandler(code,data=>{
    if(data.length>4096)return false;const parts=data.split(';');
    for(let i=0;i<parts.length&&code+i<=12;i++){const key=256+code+i-10;if(parts[i]==='?')send(`\x1b]${code+i};${color(key)}\x1b\\`);else {const value=rgb(parts[i]);if(value)overrides.set(key,value);}}
    return true;
  });
  terminal.parser.registerOscHandler(104,data=>{if(!data)for(const key of overrides.keys()){if(key<256)overrides.delete(key);}else for(const value of data.split(';'))if(/^\d{1,3}$/.test(value))overrides.delete(Number(value));return true;});
  for(const code of [110,111,112])terminal.parser.registerOscHandler(code,()=>{overrides.delete(256+code-110);return true;});
  // xterm resets its default/ANSI overrides when the host applies a new theme.
  return {snapshot:()=>[...overrides].map(([key,value])=>`\x1b]${key<256?'4;'+key:String(key-246)};${value}\x1b\\`).join(''),update(next:ResolvedAppearance){if(next===appearance)return;appearance=next;overrides.clear();if(enabled)report();}};
}
