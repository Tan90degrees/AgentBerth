import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, readFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { once } from 'node:events';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { _electron as electron } from 'playwright';
import { cleanupSmoke } from './smoke-cleanup.mjs';

const root=await mkdtemp(path.join(tmpdir(),'berth-server-desktop-'));
const data=path.join(root,'server'),local=path.join(root,'local'),profile=path.join(root,'profile'),projectPath=path.join(root,'workspace');
await mkdir(projectPath);await mkdir('test-results',{recursive:true});
const portServer=createServer();
portServer.listen(0,'127.0.0.1');
await once(portServer,'listening');
const {port}=portServer.address();
await new Promise(resolve=>portServer.close(resolve));
const address='ws://127.0.0.1:'+port;
const server=spawn(process.execPath,[path.resolve('dist/daemon.cjs'),'--server','--data-dir',data,'--port',String(port)],{stdio:['ignore','ignore','inherit']});
let app,daemonPid,page;

try {
  let token;
  const deadline=Date.now()+15000;
  while(!token&&Date.now()<deadline){
    token=await readFile(path.join(data,'server-token'),'utf8').then(text=>text.trim()).catch(()=>undefined);
    if(!token)await new Promise(resolve=>setTimeout(resolve,50));
  }
  assert.match(token,/^[a-f0-9]{64}$/);
  const args=[path.resolve('.'),'--user-data-dir='+profile,'--use-gl=angle','--use-angle=swiftshader','--enable-unsafe-swiftshader'];
  if(process.getuid?.()===0)args.push('--no-sandbox');
  app=await electron.launch({args,env:{...process.env,AGENTBERTH_DATA_DIR:local},timeout:25000});
  page=await app.firstWindow();
  await page.getByRole('button',{name:'添加第一个项目'}).waitFor();
  daemonPid=JSON.parse(await readFile(path.join(local,'runtime.json'),'utf8')).pid;
  const rpc=(method,params={})=>page.evaluate(({method,params})=>window.berth.rpc(method,params),{method,params});

  async function connect(){
    await page.getByRole('button',{name:'切换工作区'}).click();
    const dialog=page.getByRole('dialog',{name:'工作区连接'});
    await dialog.getByRole('button',{name:'地址与令牌'}).click();
    await dialog.getByLabel('服务器地址').fill(address);
    await dialog.getByLabel('服务器令牌').fill(token);
    const next=app.waitForEvent('window');
    await dialog.getByRole('button',{name:'连接服务器'}).click().catch(error=>{if(!page.isClosed())throw error;});
    page=await next;
    await page.getByRole('button',{name:'切换工作区'}).waitFor();
    assert.equal(new URL(page.url()).searchParams.get('server'),address);
    assert.ok((await rpc('state')).server);
  }

  await connect();
  await page.getByRole('button',{name:'添加第一个项目'}).click();
  const form=page.getByRole('dialog',{name:'添加项目目录'});
  await form.getByLabel('项目目录').fill(projectPath);
  await form.getByRole('button',{name:'选择目录',exact:true}).click();
  await form.getByRole('button',{name:'选择当前目录',exact:true}).click();
  await form.getByRole('button',{name:'添加项目',exact:true}).click();
  await form.waitFor({state:'hidden'});
  const state=await rpc('state');
  const project=state.projects.find(item=>item.path===projectPath);
  assert.ok(project);
  const session=await rpc('createSession',{projectId:project.id,title:'Remote runtime',agent:'shell'});
  const run=await rpc('start',{sessionId:session.id,cols:100,rows:30});
  await rpc('attach',{sessionId:session.id});
  await rpc('input',{sessionId:session.id,runId:run.id,data:"sleep .5; printf 'SERVER_%s\\n' STILL_RUNNING\r"});
  await page.screenshot({path:'test-results/server-remote-workspace.png',animations:'disabled'});
  await page.getByRole('button',{name:'切换工作区'}).click();
  const localWindow=app.waitForEvent('window');
  await page.getByRole('button',{name:'返回本机',exact:true}).click().catch(error=>{if(!page.isClosed())throw error;});
  page=await localWindow;
  await page.getByRole('button',{name:'添加第一个项目'}).waitFor();
  assert.equal((await rpc('state')).server,undefined);

  await connect();
  let restored=await rpc('attach',{sessionId:session.id});
  const outputDeadline=Date.now()+10000;
  while(!restored.snapshot.includes('SERVER_STILL_RUNNING')&&Date.now()<outputDeadline){
    await new Promise(resolve=>setTimeout(resolve,60));
    restored=await rpc('attach',{sessionId:session.id});
  }
  assert.equal(restored.run.id,run.id);
  assert.ok(restored.snapshot.includes('SERVER_STILL_RUNNING'));
  await rpc('stop',{sessionId:session.id});
  console.log('Desktop smoke verified workspace isolation, server directories and PTY continuity');
} catch(error) {
  if(page&&!page.isClosed())await page.screenshot({path:'test-results/server-failure.png',timeout:2500}).catch(()=>{});
  throw error;
} finally {
  if(server.exitCode===null&&server.signalCode===null){
    const exit=once(server,'exit');server.kill('SIGTERM');
    const timer=setTimeout(()=>server.kill('SIGKILL'),15000);
    await exit.finally(()=>clearTimeout(timer));
  }
  await cleanupSmoke(app,daemonPid,root);
}
