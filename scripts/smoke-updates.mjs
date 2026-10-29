import { _electron as electron } from 'playwright';
import ssh2 from 'ssh2';
const { Server } = ssh2;
import { generateKeyPairSync } from 'node:crypto';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm, cp, appendFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createUpdate } from './create-update.mjs';
import { RELEASE_API, RELEASE_REPOSITORY, updateNames } from '../src/shared/update-format.mjs';
if (process.platform !== 'win32') throw new Error('Packaged hot update smoke requires Windows');
const folder = await mkdtemp(path.join(os.tmpdir(),'berth-update-smoke-'));
const root = process.cwd(), executablePath = path.resolve('release/win-unpacked/AgentBerth.exe');
const current = JSON.parse(await readFile('package.json','utf8')).version;
const next = current.split('.').map(Number); next[2]++; const version = next.join('.');
const output = path.join(folder,'updates'), data = path.join(folder,'data'), stateFile = path.join(data,'app-updates/state.json');
const fixtureResources=path.join(folder,'resources');await cp(path.resolve('release/win-unpacked/resources'),fixtureResources,{recursive:true});
await appendFile(path.join(fixtureResources,'mcp/server.cjs'),'\nprocess.stderr.write("UPDATE_MCP_FIXTURE_LOADED\\n");\n');
const manifest = await createUpdate(root,fixtureResources,output,{version});
const names = updateNames(version), prefix = `https://github.com/${RELEASE_REPOSITORY}/releases/download/v${version}/`;
const manifestBytes = await readFile(path.join(output,names.manifest));
const release = {tag_name:'v'+version,draft:false,prerelease:false,body:'Controlled packaged update fixture',assets:[{name:names.bundle,size:manifest.bundle.size},{name:names.manifest,size:manifestBytes.length}].map(a=>({...a,state:'uploaded',browser_download_url:prefix+a.name}))};
const keys = generateKeyPairSync('rsa',{modulusLength:2048,privateKeyEncoding:{type:'pkcs1',format:'pem'},publicKeyEncoding:{type:'pkcs1',format:'pem'}});
let logins=0, shells=0, liveChannel; const clients=new Set();
// A real SSH transport and persistent channel. This fixture intentionally models
// an unmanaged login shell, so it does not require any remote helper program.
const ssh=new Server({hostKeys:[keys.privateKey]},client=>{
  clients.add(client);client.on('error',()=>{});client.on('close',()=>clients.delete(client));
  client.on('authentication',ctx=>ctx.method==='password'&&ctx.password==='fixture-only'?ctx.accept():ctx.reject(['password']));
  client.on('ready',()=>{logins++;client.on('session',accept=>{const session=accept();session.on('pty',accept=>accept());session.on('window-change',accept=>accept?.());session.on('exec',accept=>{accept().end('unmanaged shell');});session.on('shell',accept=>{shells++;liveChannel=accept();liveChannel.on('error',()=>{});liveChannel.write('SSH_BEFORE_UPDATE\r\nfixture> ');liveChannel.on('data',bytes=>liveChannel.write(bytes));});});});
});
await new Promise(resolve=>ssh.listen(0,'127.0.0.1',resolve)); const port=ssh.address().port;
const args=['--user-data-dir='+path.join(folder,'profile'),'--use-gl=angle','--use-angle=swiftshader','--enable-unsafe-swiftshader'];
const env={...process.env,AGENTBERTH_DATA_DIR:data};delete env.ELECTRON_RUN_AS_NODE;
let application, page, mcp, mcp2;
const step=message=>console.log('Update smoke: '+message);
async function eventually(check,message,ms=20000){const until=Date.now()+ms;while(Date.now()<until){try{if(await check())return;}catch{}await new Promise(resolve=>setTimeout(resolve,100));}throw new Error(message);}
async function launch(){application=await electron.launch({executablePath,args,env,timeout:20000});page=await application.firstWindow();page.setDefaultTimeout(15000);await page.waitForFunction(()=>!!window.berth);await eventually(()=>page.evaluate(()=>window.berth.rpc('state').then(s=>s.apiVersion>=35)),'backend did not connect');return application;}
const runtime=async()=>JSON.parse(await readFile(path.join(data,'runtime.json'),'utf8'));
function mcpClient(config){
 const child=spawn(config.command,config.args,{env:{...env,...config.env},windowsHide:true,stdio:['pipe','pipe','pipe']});let stderr='';child.stderr.on('data',bytes=>{stderr+=bytes.toString();});let seq=0;const pending=new Map();
 createInterface({input:child.stdout}).on('line',line=>{const reply=JSON.parse(line);const p=pending.get(reply.id);if(p){clearTimeout(p.timer);pending.delete(reply.id);reply.error?p.reject(new Error(reply.error.message)):p.resolve(reply.result);}});
 return {child,get stderr(){return stderr;},call(method,params={}){return new Promise((resolve,reject)=>{const id=++seq,timer=setTimeout(()=>{pending.delete(id);reject(new Error('MCP fixture timed out'));},10000);pending.set(id,{resolve,reject,timer});child.stdin.write(JSON.stringify({jsonrpc:'2.0',id,method,params})+'\n');});},close(){child.stdin.end();}};
}
try{
 step('launch packaged runtime, persistent local PTY, real SSH and detached window');
 await launch();await page.evaluate(()=>window.berth.updates('automatic',false));
 const project=await page.evaluate(folder=>window.berth.rpc('createProject',{name:'更新验证',path:folder}),folder);
 const session=await page.evaluate(projectId=>window.berth.rpc('createSession',{projectId,title:'更新时保持运行',agent:'shell'}),project.id);
 const run=await page.evaluate(sessionId=>window.berth.rpc('start',{sessionId,cols:90,rows:30}),session.id);
 await page.evaluate(({sessionId,runId})=>window.berth.rpc('input',{sessionId,runId,data:'echo LOCAL_BEFORE_UPDATE\r'}),{sessionId:session.id,runId:run.id});
 await eventually(()=>page.evaluate(id=>window.berth.rpc('attach',{sessionId:id}).then(a=>a.snapshot.includes('LOCAL_BEFORE_UPDATE')),session.id),'local terminal did not render');
 await application.evaluate(({dialog})=>{dialog.showMessageBox=async()=>({response:1,checkboxChecked:false});});
 await page.evaluate(port=>window.berth.saveSshConnection({alias:'update-fixture',hostname:'127.0.0.1',port,username:'fixture',authentication:'password',privateKeyPath:'',allowAgent:true},undefined,{password:'fixture-only'},false),port);
 const remote=await page.evaluate(()=>window.berth.openSshConnection('update-fixture'));
 await page.evaluate(id=>window.berth.sshWindow('open',id),remote.sessionId);
 await eventually(async()=>application.windows().length===2,'detached SSH window did not open');
 await application.evaluate(({BrowserWindow})=>{const main=BrowserWindow.getAllWindows().find(w=>!w.webContents.getURL().includes('view=ssh'));const ssh=BrowserWindow.getAllWindows().find(w=>w.webContents.getURL().includes('view=ssh'));main.setBounds({x:40,y:45,width:1060,height:740});ssh.setBounds({x:100,y:100,width:760,height:480});});
 const before=await runtime();
 const config=JSON.parse(await page.evaluate(()=>window.berth.mcpConfig())).mcpServers.agentberth;
 mcp=mcpClient(config);assert.equal((await mcp.call('tools/list')).tools.length,4);assert.ok(!(await mcp.call('tools/call',{name:'terminal_session',arguments:{}})).isError);
 // Stub only OS relaunch spawning so Playwright can attach to the next process.
 // Activation, UI exit, original bootstrap, native ZIP extraction and PTY/SSH
 // survival all run through production code in actual packaged Electron.
 await application.evaluate(({app,net},{release,manifest,archive,releaseApi,prefix,manifestName,bundleName,marker})=>{
   const fs=process.getBuiltinModule('node:fs');
   net.fetch=async url=>url===releaseApi?Response.json(release):url===prefix+manifestName?new Response(fs.readFileSync(manifest)):url===prefix+bundleName?new Response(fs.readFileSync(archive)):new Response('',{status:404});
   app.relaunch=()=>fs.writeFileSync(marker,'requested');
 },{release,manifest:path.join(output,names.manifest),archive:path.join(output,names.bundle),releaseApi:RELEASE_API,prefix,manifestName:names.manifest,bundleName:names.bundle,marker:path.join(folder,'relaunch')});
 await page.getByRole('button',{name:'设置',exact:true}).click();
 await page.getByRole('navigation',{name:'设置分类',exact:true}).getByRole('button',{name:'关于与支持',exact:true}).click();
 await page.getByRole('button',{name:'检查更新',exact:true}).click();
 await page.getByRole('button',{name:'下载更新',exact:true}).waitFor();
 await page.getByRole('button',{name:'下载更新',exact:true}).click();
 await eventually(()=>page.evaluate(()=>window.berth.updates('state').then(s=>s.phase==='ready')),'update did not become ready');
 await page.getByRole('button',{name:'立即更新（终端继续运行）',exact:true}).waitFor();
 await mkdir('test-results',{recursive:true});await page.screenshot({animations:'disabled',path:'test-results/packaged-software-update-ready.png'});
 await page.evaluate(({project,session})=>{localStorage.setItem('berth.project',project);localStorage.setItem('berth.session',session);localStorage.setItem('berth.updateFixture','preserved');},{project:project.id,session:session.id});
 step('activate verified bundle and relaunch only the UI; keep daemon, PTY, SSH and MCP alive');
 const exiting=new Promise(resolve=>application.process().once('exit',resolve));
 await page.getByRole('button',{name:'立即更新（终端继续运行）',exact:true}).click();await exiting;application=null;
 assert.equal(await readFile(path.join(folder,'relaunch'),'utf8'),'requested');assert.equal((await runtime()).pid,before.pid);
 assert.equal((await mcp.call('tools/list')).tools.length,4);assert.ok(!(await mcp.call('tools/call',{name:'terminal_session',arguments:{}})).isError);assert.equal(logins,1);assert.equal(shells,1);
 await launch();
 assert.equal((await page.evaluate(()=>window.berth.appInfo())).version,version);
 assert.ok(decodeURIComponent(page.url()).replaceAll('\\','/').includes('/app-updates/versions/'+version+'/app.asar/'),'renderer is loaded from the new version directory');
 assert.equal(await page.evaluate(()=>localStorage.getItem('berth.updateFixture')),'preserved');
 assert.equal(await page.evaluate(()=>localStorage.getItem('berth.project')),project.id);
 assert.equal((await runtime()).pid,before.pid);
 const sameRun=await page.evaluate(id=>window.berth.rpc('state').then(s=>s.sessions.find(x=>x.id===id).latestRun),session.id);
 assert.equal(sameRun.id,run.id);assert.equal(sameRun.pid,run.pid);assert.equal(sameRun.status,'running');
 await eventually(async()=>application.windows().length===2,'SSH window was not restored');
 const bounds=await application.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows().map(w=>w.getNormalBounds()).sort((a,b)=>b.width-a.width));assert.equal(bounds[0].width,1060);assert.equal(bounds[1].width,760);
 liveChannel.write('\r\nSSH_AFTER_UPDATE\r\n');
 await eventually(()=>page.evaluate(id=>window.berth.rpc('attach',{sessionId:id}).then(a=>a.snapshot.includes('SSH_AFTER_UPDATE')),remote.sessionId),'SSH output did not continue');
 await page.evaluate(({sessionId,runId})=>window.berth.rpc('input',{sessionId,runId,data:'echo LOCAL_AFTER_UPDATE\r'}),{sessionId:session.id,runId:run.id});
 await eventually(()=>page.evaluate(id=>window.berth.rpc('attach',{sessionId:id}).then(a=>a.snapshot.includes('LOCAL_AFTER_UPDATE')),session.id),'PTY input/output did not continue');
 assert.equal(logins,1);assert.equal(shells,1);assert.equal((await page.evaluate(()=>window.berth.updates('state'))).backendPending,true);
 assert.deepEqual(JSON.parse(await page.evaluate(()=>window.berth.mcpConfig())).mcpServers.agentberth,config);
 await eventually(async()=>JSON.parse(await readFile(stateFile,'utf8')).pending===false,'renderer did not confirm startup');
 mcp2=mcpClient(config);assert.equal((await mcp2.call('tools/list')).tools.length,4);assert.ok(!(await mcp2.call('tools/call',{name:'terminal_session',arguments:{}})).isError);await eventually(()=>mcp2.stderr.includes('UPDATE_MCP_FIXTURE_LOADED'),'stable MCP bootstrap did not load the confirmed update');
 step('defer backend update until both terminals end; normal Quit still stops all terminals');
 await page.evaluate(id=>window.berth.rpc('stop',{sessionId:id}),remote.sessionId);await page.evaluate(id=>window.berth.rpc('stop',{sessionId:id}),session.id);
 await eventually(async()=>(await runtime()).pid!==before.pid,'idle backend was not upgraded');
 await eventually(()=>page.evaluate(()=>window.berth.updates('state').then(s=>!s.backendPending)),'backend update was not acknowledged');
 const last=await page.evaluate(id=>window.berth.rpc('start',{sessionId:id,cols:80,rows:24}),session.id);
 const finalRuntime=await runtime(); const quit=new Promise(resolve=>application.process().once('exit',resolve));await application.evaluate(({app})=>app.quit());await quit;application=null;
 await eventually(async()=>{try{process.kill(finalRuntime.pid,0);return false;}catch{return true;}},'normal Quit left the daemon alive');
 await eventually(async()=>{try{process.kill(last.pid,0);return false;}catch{return true;}},'normal Quit left a local terminal alive');
 step('boot an unconfirmed attempted update and verify rollback to installed code');
 const disk=JSON.parse(await readFile(stateFile,'utf8'));await writeFile(stateFile,JSON.stringify({...disk,active:version,previous:null,pending:true,attempted:true,backendPending:true,previousBackendPending:false}));
 await launch();assert.equal((await page.evaluate(()=>window.berth.appInfo())).version,current);
 assert.match((await page.evaluate(()=>window.berth.updates('state'))).message,/恢复/);
 const rollbackQuit=new Promise(resolve=>application.process().once('exit',resolve));await application.evaluate(({app})=>app.quit());await rollbackQuit;application=null;
 step('passed: code bundle, native extraction, window restoration, live PTY/SSH/MCP, idle backend replacement and rollback');
}catch(error){
 console.error('Update regression failed:',error);
 if(page&&!page.isClosed()){
  console.error('Update state:',await page.evaluate(()=>window.berth.updates('state')).catch(()=>null));
  await mkdir('test-results',{recursive:true});await page.screenshot({path:'test-results/packaged-software-update-failure.png'}).catch(()=>{});
 }
 throw error;
}finally{
 mcp?.close();mcp2?.close();if(application)await application.close().catch(()=>{});
 for(const client of clients)client.end();await new Promise(resolve=>ssh.close(resolve));
 await rm(folder,{recursive:true,force:true,maxRetries:5,retryDelay:200});
}
