import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { strToU8, zipSync } from 'fflate';
import { _electron as electron } from 'playwright';
import { cleanupSmoke } from './smoke-cleanup.mjs';
import { testPassword, testUsername, workspaceSshFixture } from './ssh-workspace-fixture.mjs';

const root=await mkdtemp(path.join(tmpdir(),'berth-ssh-desktop-'));
const home=path.join(root,'remote'),local=path.join(root,'local'),profile=path.join(root,'profile');
const runtime=path.join(home,'.local/share/agentberth-server/runtime.json');
const pluginFile=path.join(root,'server-plugin.zip');
await mkdir(home);
await writeFile(pluginFile,zipSync({
  'agentberth.extension.json':strToU8(JSON.stringify({apiVersion:1,id:'example.server-smoke',name:'Server smoke fixture',version:'1.0.0',desktopEntry:'desktop.cjs'})),
  'index.cjs':strToU8("exports.apply=()=>{};"),
  'desktop.cjs':strToU8("exports.apply=()=>{throw new Error('Remote desktop code must stay disabled');};"),
}));
await mkdir('test-results',{recursive:true});
const ssh=await workspaceSshFixture(home,{remotePath:process.env.AGENTBERTH_TEST_REMOTE_PATH});
let app,daemonPid,page;

try{
  const args=[path.resolve('.'),'--user-data-dir='+profile,'--use-gl=angle','--use-angle=swiftshader','--enable-unsafe-swiftshader'];
  if(process.getuid?.()===0)args.push('--no-sandbox');
  app=await electron.launch({args,env:{...process.env,AGENTBERTH_DATA_DIR:local},timeout:25000});
  await app.evaluate(({dialog},file)=>{
    const show=dialog.showMessageBox.bind(dialog);
    dialog.showMessageBox=(...args)=>{
      if(args[1]?.title==='确认 SSH 主机指纹'&&args[1]?.detail?.includes('SHA256:'))return Promise.resolve({response:1});
      return show(...args);
    };
    const choose=dialog.showOpenDialog.bind(dialog);
    dialog.showOpenDialog=(...args)=>args[1]?.title==='安装插件到服务器'
      ?Promise.resolve({canceled:false,filePaths:[file]}):choose(...args);
  },pluginFile);
  page=await app.firstWindow();
  await page.getByRole('button',{name:'添加第一个项目'}).waitFor();
  daemonPid=JSON.parse(await readFile(path.join(local,'runtime.json'),'utf8')).pid;

  async function connect(status,action){
    await page.getByRole('button',{name:'切换工作区'}).click();
    const form=page.getByRole('dialog',{name:'工作区连接'});
    await form.getByLabel('服务器 IP 或主机名').fill('127.0.0.1');
    await form.getByLabel('SSH 端口').fill(String(ssh.port));
    await form.getByLabel('SSH 用户名').fill(testUsername);
    await form.getByLabel('SSH 密码').fill(testPassword);
    await form.getByRole('button',{name:'探测服务器'}).click();
    await form.getByText(status,{exact:true}).waitFor();
    if(status==='未部署')await page.screenshot({path:'test-results/server-ssh-probe.png'});
    const next=app.waitForEvent('window',{timeout:90000});
    await form.getByRole('button',{name:action}).click().catch(error=>{if(!page.isClosed())throw error;});
    page=await next;
    await page.getByRole('button',{name:'添加第一个项目'}).waitFor();
    assert.match(new URL(page.url()).searchParams.get('server'),/^ssh:\/\/127\.0\.0\.1:/);
    assert.ok((await page.evaluate(()=>window.berth.rpc('state'))).server);
  }
  await connect('未部署','部署并进入');
  const pid=JSON.parse(await readFile(runtime,'utf8')).pid;
  await page.locator('.activity-bar').getByRole('button',{name:'扩展管理',exact:true}).click();
  assert.equal(await page.getByRole('button',{name:'加载开发目录'}).count(),0);
  await page.getByRole('button',{name:'安装扩展插件'}).click();
  const card=page.locator('[data-plugin-id="example.server-smoke"]');
  await card.getByText('已启用',{exact:true}).waitFor();
  assert.equal(await card.getByRole('alert').count(),0);
  assert.ok((await page.evaluate(()=>window.berth.extensions({action:'list'}))).plugins.some(plugin=>plugin.manifest.id==='example.server-smoke'));
  await page.getByRole('button',{name:'切换工作区'}).click();
  const localWindow=app.waitForEvent('window');
  await page.getByRole('button',{name:'返回本机'}).click().catch(error=>{if(!page.isClosed())throw error;});
  page=await localWindow;
  await page.getByRole('button',{name:'添加第一个项目'}).waitFor();
  assert.equal((await page.evaluate(()=>window.berth.rpc('state'))).server,undefined);
  assert.ok(!(await page.evaluate(()=>window.berth.extensions({action:'list'}))).plugins.some(plugin=>plugin.manifest.id==='example.server-smoke'));
  await connect('已部署，服务运行中','进入工作区');
  assert.equal(JSON.parse(await readFile(runtime,'utf8')).pid,pid);
  await page.screenshot({path:'test-results/server-ssh-workspace.png'});
  console.log('Desktop smoke verified SSH deployment, workspace switching, server plugin installation and service reuse');
}catch(error){
  if(page&&!page.isClosed())await page.screenshot({path:'test-results/server-ssh-failure.png',timeout:2500}).catch(()=>{});
  throw error;
}finally{
  const info=await readFile(runtime,'utf8').then(JSON.parse).catch(()=>null);
  await ssh.close();
  if(info?.pid)try{process.kill(info.pid,'SIGTERM');}catch{}
  await cleanupSmoke(app,daemonPid,root);
}
