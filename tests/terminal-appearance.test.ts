import { spawn } from 'node:child_process';
import test from 'node:test';
import assert from 'node:assert/strict';
import { Terminal } from '@xterm/headless';
import { terminalAppearance } from '../src/daemon/terminal-appearance';
import { TerminalAppearanceSync } from '../src/main/terminal-appearance';
import { isTerminalReply } from '../src/shared/terminal-replies';
import { DaemonServer } from '../src/daemon/server';
import { DaemonConnection } from '../src/main/connection';
import type { Attachment, Project, Run, Session, State } from '../src/shared/protocol';
import { mkdtempSync, rmSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import * as pty from 'node-pty';
import { Server } from 'ssh2';
import { generateKeyPairSync } from 'node:crypto';

const write=(terminal:Terminal,data='')=>new Promise<void>(resolve=>terminal.write(data,resolve));
function fixture(t:import('node:test').TestContext){const terminal=new Terminal({allowProposedApi:true}),replies:string[]=[];t.after(()=>terminal.dispose());return {terminal,replies,theme:terminalAppearance(terminal,'dark',data=>replies.push(data))};}

test('theme queries, fragmented opt-in, DECRQM and reset obey DEC 2031 without unsolicited Shell input',async t=>{
 const {terminal,replies,theme}=fixture(t);
 theme.update('light');assert.deepEqual(replies,[]);
 await write(terminal,'\x1b[?2031$p\x1b[?996n');assert.deepEqual(replies,['\x1b[?2031;2$y','\x1b[?997;2n']);replies.length=0;
 await write(terminal,'\x1b[?20');await write(terminal,'31h\x1b[?2031$p');assert.deepEqual(replies,['\x1b[?2031;1$y']);replies.length=0;
 theme.update('dark');theme.update('dark');assert.deepEqual(replies,['\x1b[?997;1n']);
 await write(terminal,'\x1b[?2031l');theme.update('light');assert.equal(replies.length,1);
 await write(terminal,'\x1b[?2031h\x1bc');theme.update('dark');assert.equal(replies.length,1);
 await write(terminal,'\x1b[?2031h\x1b[!p');theme.update('light');assert.equal(replies.length,1);
});

test('default, chained and indexed OSC queries use the current theme; OSC overrides track the rendered defaults',async t=>{
 const {terminal,replies,theme}=fixture(t);
 await write(terminal,'\x1b]10;?;?\x07');assert.deepEqual(replies,['\x1b]10;rgb:ecec/ecec/ecec\x1b\\','\x1b]11;rgb:2121/2121/2121\x1b\\']);replies.length=0;
 theme.update('light');await write(terminal,'\x1b]11;?\x1b\\\x1b]4;1;?;255;?\x07');assert.deepEqual(replies,['\x1b]11;rgb:ffff/ffff/ffff\x1b\\','\x1b]4;1;rgb:a8a8/2121/3232\x1b\\','\x1b]4;255;rgb:eeee/eeee/eeee\x1b\\']);replies.length=0;
 await write(terminal,'\x1b]11;#123456\x07\x1b]4;1;rgb:a/b/c\x07');await write(terminal,'\x1b]11;?\x07\x1b]4;1;?\x07');assert.deepEqual(replies,['\x1b]11;rgb:1212/3434/5656\x1b\\','\x1b]4;1;rgb:aaaa/bbbb/cccc\x1b\\']);replies.length=0;
 theme.update('dark');await write(terminal,'\x1b]111\x07\x1b]104;1\x07\x1b]11;?\x07\x1b]4;1;?\x07');assert.deepEqual(replies,['\x1b]11;rgb:2121/2121/2121\x1b\\','\x1b]4;1;rgb:eeee/8585/8585\x1b\\']);
 for(const reply of replies)assert.equal(isTerminalReply(reply),true);
});

test('invalid color selectors never generate replies; theme reports cannot masquerade as ordinary text',async t=>{
 const {terminal,replies}=fixture(t);await write(terminal,'\x1b]4;999;?;bad;?\x07\x1b]11;not-a-color\x07');assert.deepEqual(replies,[]);
 for(const reply of ['\x1b[?997;1n','\x1b[?997;2n'])assert.equal(isTerminalReply(reply),true);
 for(const input of ['echo dark','\x1b[?997;3n','\x1b[?997;1nCOMMAND','\x1b[997;1n'])assert.equal(isTerminalReply(input),false);
});

function connection(api=62){const calls:{method:string;params:unknown}[]=[];const target={connected:true,rpc:async(method:string,params:unknown)=>{calls.push({method,params});return method==='state'?{apiVersion:api}:null;}};return {target:target as unknown as DaemonConnection,calls,raw:target};}
test('main synchronizes rapid switches in order, deduplicates and leaves compatible old daemons attached',async()=>{
 const sync=new TerminalAppearanceSync(),current=connection();await sync.sync(current.target,'dark');await Promise.all([sync.sync(current.target,'light'),sync.sync(current.target,'dark'),sync.sync(current.target,'dark')]);
 assert.deepEqual(current.calls,[{method:'state',params:undefined},...['dark','light','dark'].map(appearance=>({method:'terminalAppearance',params:{appearance}}))]);
 const old=connection(61);await sync.sync(old.target,'light');await sync.sync(old.target,'dark');assert.deepEqual(old.calls,[{method:'state',params:undefined}]);
});
test('same-mode palette changes synchronize once on API 64 and remain compatible with API 63',async()=>{
 const sync=new TerminalAppearanceSync(),current=connection(64);await sync.sync(current.target,'dark','classic');await sync.sync(current.target,'dark','glass');await sync.sync(current.target,'dark','glass');await sync.sync(current.target,'light','claude');
 assert.deepEqual(current.calls.slice(1).map(call=>call.params),[{appearance:'dark',palette:'classic'},{appearance:'dark',palette:'glass'},{appearance:'light',palette:'claude'}]);
 const old=connection(63);await sync.sync(old.target,'dark','glass');await sync.sync(old.target,'dark','claude');assert.deepEqual(old.calls,[{method:'state',params:undefined},{method:'terminalAppearance',params:{appearance:'dark'}}]);
});
test('same-mode family changes notify subscribed TUI and update subsequent default color queries',async t=>{
 const {terminal,replies,theme}=fixture(t);await write(terminal,'\x1b[?2031h');theme.update('dark','claude');await write(terminal,'\x1b]11;?\x07');assert.deepEqual(replies,['\x1b[?997;1n','\x1b]11;rgb:2525/2323/1f1f\x1b\\']);
 theme.update('light','glass');await write(terminal,'\x1b]11;?\x07');assert.equal(replies.at(-1),'\x1b]11;rgb:f5f5/f9f9/ffff\x1b\\');
});
test('a failed sync remains retryable and late negotiation cannot recolor a replacement daemon',async()=>{
 const sync=new TerminalAppearanceSync(),current=connection();const rpc=current.raw.rpc;let fail=true;current.raw.rpc=async(method,params)=>{if(method==='terminalAppearance'&&fail){fail=false;throw new Error('disconnected');}return rpc(method,params);};
 await assert.rejects(sync.sync(current.target,'light'),/disconnected/);await sync.sync(current.target,'light');assert.equal(current.calls.at(-1)!.method,'terminalAppearance');
 let finish!:(value:{apiVersion:number})=>void;const stale=connection();stale.raw.rpc=()=>new Promise(resolve=>{finish=resolve as typeof finish;});const pending=sync.sync(stale.target,'light');await new Promise(resolve=>setImmediate(resolve));
 const replacement=connection();await sync.sync(replacement.target,'dark');finish({apiVersion:62});await pending;assert.deepEqual(replacement.calls.at(-1),{method:'terminalAppearance',params:{appearance:'dark'}});
});

test('daemon answers local TUI queries and theme changes without any renderer subscription, keeping the same run',async t=>{
 const folder=mkdtempSync(path.join(os.tmpdir(),'berth-theme-')),received:string[]=[];let output:(data:string)=>void=()=>{};let exit:(data:{exitCode:number})=>void=()=>{};
 const owned=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{env:{...process.env,ELECTRON_RUN_AS_NODE:'1'},stdio:'ignore'});await new Promise<void>((resolve,reject)=>{owned.once('spawn',resolve);owned.once('error',reject);});owned.once('exit',()=>exit({exitCode:0}));
 const processDouble={pid:owned.pid!,write:(data:string|Buffer)=>received.push(String(data)),resize(){},pause(){},resume(){},onData(fn:typeof output){output=fn;return {dispose(){}};},onExit(fn:typeof exit){exit=fn;return {dispose(){}};},kill(){owned.kill();}};
 const daemon=new DaemonServer(path.join(folder,'data'),()=>{},(()=>processDouble) as unknown as typeof pty.spawn),client=await DaemonConnection.open(await daemon.listen(),()=>{});
 t.after(async()=>{client.close(true);await daemon.close();owned.kill();rmSync(folder,{recursive:true,force:true,maxRetries:5});});
 await client.rpc('terminalAppearance',{appearance:'light'});const project=await client.rpc<Project>('createProject',{name:'Theme',path:folder}),session=await client.rpc<Session>('createSession',{projectId:project.id,title:'TUI',agent:'shell'}),run=await client.rpc<Run>('start',{sessionId:session.id,cols:80,rows:24});
 output('\x1b[?2031h\x1b[?996n\x1b]11;?\x07');await client.rpc('terminalAppearance',{appearance:'dark'});
 assert.deepEqual(received,['\x1b[?997;2n','\x1b]11;rgb:ffff/ffff/ffff\x1b\\','\x1b[?997;1n']);
 const attached=await client.rpc<Attachment>('attach',{sessionId:session.id});assert.equal(attached.terminalReplies,true);assert.equal(attached.run!.id,run.id);assert.equal(attached.run!.pid,run.pid);assert.equal(attached.cols,80);assert.equal(attached.rows,24);
 await client.rpc('detach',{sessionId:session.id});await client.rpc('terminalAppearance',{appearance:'light'});assert.equal(received.at(-1),'\x1b[?997;2n');
 output('\x1b[?2031l');await client.rpc('terminalAppearance',{appearance:'dark'});assert.equal(received.at(-1),'\x1b[?997;2n','unsubscribed programs receive no extra keystrokes');
});

test('Agent-owned SSH replies follow the host theme with no input permission bypass or duplicate renderer replies',{timeout:15000},async t=>{
 const keys=generateKeyPairSync('rsa',{modulusLength:2048,privateKeyEncoding:{type:'pkcs1',format:'pem'},publicKeyEncoding:{type:'pkcs1',format:'pem'}}),peers=new Set<any>(),channels:any[]=[],received:string[]=[];
 const ssh=new Server({hostKeys:[keys.privateKey]},peer=>{peers.add(peer);peer.on('error',()=>{});peer.on('close',()=>peers.delete(peer));peer.on('authentication',ctx=>ctx.method==='password'?ctx.accept():ctx.reject(['password']));peer.on('ready',()=>peer.on('session',accept=>{const s=accept();s.on('pty',accept=>accept?.());s.on('window-change',accept=>accept?.());s.on('exec',accept=>accept().end('non-POSIX fixture'));s.on('shell',accept=>{const channel=accept();channels.push(channel);channel.on('error',()=>{});channel.on('data',(data:Buffer)=>received.push(data.toString()));channel.write('ready');});}));});
 await new Promise<void>(resolve=>ssh.listen(0,'127.0.0.1',resolve));const address=ssh.address();assert.ok(address&&typeof address!=='string');
 const folder=mkdtempSync(path.join(os.tmpdir(),'berth-theme-ssh-')),daemon=new DaemonServer(path.join(folder,'data')),runtime=await daemon.listen();let ui:DaemonConnection;ui=await DaemonConnection.open(runtime,event=>{if(event.event==='sshChallenge')void ui.rpc('sshChallengeReply',{challengeId:event.data.id,...(event.data.kind==='credentials'?{secret:{password:'fixture-secret'}}:{accepted:true})});});const agent=await DaemonConnection.open(runtime,()=>{});
 t.after(async()=>{ui.close(true);agent.close(true);await daemon.close();for(const peer of peers)peer.end();await new Promise<void>(resolve=>ssh.close(()=>resolve()));rmSync(folder,{recursive:true,force:true,maxRetries:5});});
 await ui.rpc('registerSshProvider');await ui.rpc('saveSshConnection',{config:{alias:'theme-fixture',hostname:'127.0.0.1',port:address.port,username:'fixture',authentication:'password',privateKeyPath:'',allowAgent:true}});await ui.rpc('terminalAppearance',{appearance:'light'});
 const opened=await agent.rpc<{sessionId:string;runId:string}>('remoteOpen',{alias:'theme-fixture',owner:'agent'});await ui.rpc('attach',{sessionId:opened.sessionId});await assert.rejects(ui.rpc('input',{sessionId:opened.sessionId,runId:opened.runId,data:'USER_INPUT'}),/接管/);await ui.rpc('detach',{sessionId:opened.sessionId});channels[0].write('\x1b[?2031h\x1b[?996n\x1b]11;?\x07');
 const until=async(check:()=>boolean)=>{const end=Date.now()+5000;while(!check()){assert.ok(Date.now()<end,'SSH did not receive theme reply');await new Promise(resolve=>setTimeout(resolve,10));}};
 await until(()=>received.join('').includes('rgb:ffff/ffff/ffff'));await ui.rpc('terminalAppearance',{appearance:'dark'});await until(()=>received.join('').includes('\x1b[?997;1n'));
 assert.equal(received.join(''),'\x1b[?997;2n\x1b]11;rgb:ffff/ffff/ffff\x1b\\\x1b[?997;1n');const state=await ui.rpc<State>('state');assert.equal(state.sessions.find(s=>s.id===opened.sessionId)!.latestRun!.id,opened.runId);assert.equal((await ui.rpc<any>('remoteInfo',{sessionId:opened.sessionId})).owner,'agent');
});

test('reattach restores OSC overrides while host theme changes preserve already drawn RGB cells',async t=>{
 const {terminal,replies,theme}=fixture(t);await write(terminal,'\x1b]11;#123456\x07\x1b[48;2;18;52;86mX');
 const restored=new Terminal({allowProposedApi:true}),copy:string[]=[];t.after(()=>restored.dispose());terminalAppearance(restored,'dark',data=>copy.push(data));
 await write(restored,theme.snapshot()+'\x1b]11;?\x07');assert.deepEqual(copy,['\x1b]11;rgb:1212/3434/5656\x1b\\']);
 theme.update('light');await write(terminal,'\x1b]11;?\x07');assert.deepEqual(replies,['\x1b]11;rgb:ffff/ffff/ffff\x1b\\']);
 assert.equal(terminal.buffer.active.getLine(0)!.getCell(0)!.getBgColor(),0x123456);assert.equal(theme.snapshot(),'');
});
