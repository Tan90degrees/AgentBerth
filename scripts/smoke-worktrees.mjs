import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { _electron as electron } from 'playwright';
const execute=promisify(execFile);
const git=async(cwd,...args)=>(await execute('git',['-c','commit.gpgsign=false','-C',cwd,...args],{windowsHide:true})).stdout.trim();

export async function checkWorktrees(page,{folder,root,project,session,run,packaged=false}){
  console.log('Worktree smoke: create dialogs, remote branches and nested session picker');
  const remote=path.join(folder,'worktree-remote.git'),publisher=path.join(folder,'worktree-publisher');
  await git(folder,'clone','--bare',root,remote);await git(root,'remote','add','origin',remote);await git(folder,'clone',remote,publisher);
  await git(publisher,'config','user.name','Worktree smoke');await git(publisher,'config','user.email','smoke@example.invalid');
  await git(publisher,'switch','-c','feature/remote-worktree');await writeFile(path.join(publisher,'from-remote.txt'),'WORKTREE_REMOTE_CONTENT\n');
  await git(publisher,'add','.');await git(publisher,'commit','-m','remote fixture');await git(publisher,'push','-u','origin','feature/remote-worktree');
  const ids=await page.evaluate(()=>window.berth.rpc('state').then(s=>s.sessions.map(s=>s.id)));
  const beforeHead=await git(root,'rev-parse','HEAD');
  await page.getByRole('tablist',{name:'侧栏视图'}).getByRole('tab',{name:'Git',exact:true}).click();
  const manager=page.locator('.worktree-manager');await manager.getByText('主工作区',{exact:true}).waitFor();
  await manager.getByRole('button',{name:'＋ 新建 Worktree',exact:true}).click();
  const create=()=>page.getByRole('dialog',{name:'创建 Worktree',exact:true});
  await create().getByLabel('新分支名称',{exact:true}).fill('invalid..branch');
  await create().getByRole('button',{name:'创建 Worktree',exact:true}).click();await create().getByRole('alert').waitFor();
  assert.deepEqual(await page.evaluate(()=>window.berth.rpc('state').then(s=>s.sessions.map(s=>s.id))),ids,'A failed worktree creation leaves the dialog open without creating a session');
  await create().getByLabel('新分支名称',{exact:true}).fill('feature/sidebar-worktree');
  await create().getByLabel('新分支名称',{exact:true}).press('Enter');await create().waitFor({state:'hidden'});
  const row=manager.locator('.worktree-row').filter({has:page.getByText('feature/sidebar-worktree',{exact:true})});await row.waitFor();
  assert.deepEqual(await page.evaluate(()=>window.berth.rpc('state').then(s=>s.sessions.map(s=>s.id))),ids);
  await row.getByRole('button',{name:'删除',exact:true}).click();await row.waitFor({state:'hidden'});
  console.log('Worktree smoke: sidebar creation, visible errors and removal passed');
  await manager.locator('.worktree-row').filter({has:page.getByText('主工作区',{exact:true})}).getByRole('button',{name:'新建终端',exact:true}).click();
  const outer=page.getByRole('dialog',{name:'新建项目会话',exact:true});await outer.getByLabel('Agent 类型',{exact:true}).selectOption('shell');
  await outer.getByLabel('会话名称',{exact:true}).fill('Remote Worktree shell');await outer.getByLabel('创建后立即启动',{exact:true}).uncheck();
  await outer.getByRole('button',{name:'新建 Worktree…',exact:true}).click();await create().waitFor();
  assert.equal(await page.locator('form form').count(),0,'Worktree form must never be nested inside the session form');
  await page.keyboard.press('Escape');await create().waitFor({state:'hidden'});await outer.waitFor();
  assert.equal(await outer.getByRole('button',{name:'新建 Worktree…',exact:true}).evaluate(el=>el===document.activeElement),true,'Closing the inner dialog restores focus in the session dialog');
  await outer.getByRole('button',{name:'新建 Worktree…',exact:true}).click();
  await create().getByLabel('分支来源',{exact:true}).selectOption('remote');
  await create().getByRole('button',{name:'获取远端分支',exact:true}).click();
  const remoteSelect=create().getByLabel('远端分支',{exact:true});
  await remoteSelect.locator('option').filter({hasText:'origin/feature/remote-worktree'}).waitFor({state:'attached'});
  await remoteSelect.selectOption({label:'origin/feature/remote-worktree'});
  await create().getByLabel('本地分支名称',{exact:true}).fill('feature/session-remote');
  await page.screenshot({animations:'disabled',path:`test-results/${packaged?'packaged-':''}worktree-remote-dialog.png`});
  await create().getByRole('button',{name:'创建 Worktree',exact:true}).click();await create().waitFor({state:'hidden'});await outer.waitFor();
  assert.equal(await page.locator('form form').count(),0);
  assert.deepEqual(await page.evaluate(()=>window.berth.rpc('state').then(s=>s.sessions.map(s=>s.id))),ids,'Creating a worktree must not submit the session dialog');
  const worktrees=await page.evaluate(id=>window.berth.rpc('gitWorktrees',{projectId:id}),project.id),created=worktrees.find(w=>w.branch==='feature/session-remote');assert.ok(created);
  assert.equal(await outer.getByLabel('Git 工作区',{exact:true}).inputValue(),created.workingPath);
  console.log('Worktree smoke: nested dialog, remote fetch and selection passed');
  await outer.getByRole('button',{name:'创建会话',exact:true}).click();await outer.waitFor({state:'hidden'});
  const createdSession=await page.evaluate(()=>window.berth.rpc('state').then(s=>s.sessions.find(s=>s.title==='Remote Worktree shell')));assert.equal(createdSession.worktreePath,created.workingPath);
  assert.equal(await git(created.workingPath,'rev-parse','--abbrev-ref','@{upstream}'),'origin/feature/remote-worktree');
  assert.equal(await readFile(path.join(created.workingPath,'from-remote.txt'),'utf8'),'WORKTREE_REMOTE_CONTENT\n');
  const started=await page.evaluate(id=>window.berth.rpc('start',{sessionId:id,cols:160,rows:25}),createdSession.id);
  const expected=created.workingPath;
  const command=process.platform==='win32'?`if((Get-Location).Path -eq '${expected.replaceAll("'","''")}'){Write-Output ('WORKTREE_'+'CWD_OK')}\r`:`if test "$PWD" = '${expected.replaceAll("'","'\\''")}'; then printf 'WORKTREE_%s_OK\\n' CWD; fi\r`;
  await page.evaluate(({id,runId,data})=>window.berth.rpc('input',{sessionId:id,runId,data}),{id:createdSession.id,runId:started.id,data:command});
  await page.waitForFunction(async id=>(await window.berth.rpc('attach',{sessionId:id})).snapshot.includes('WORKTREE_CWD_OK'),createdSession.id);
  await page.evaluate(id=>window.berth.rpc('stop',{sessionId:id}),createdSession.id);
  await page.evaluate(({projectId,path})=>window.berth.rpc('gitRemoveWorktree',{projectId,path,deleteSessions:true}),{projectId:project.id,path:created.path});
  const original=await page.evaluate(id=>window.berth.rpc('state').then(s=>s.sessions.find(s=>s.id===id).latestRun),session.id);
  assert.equal(original.id,run.id);assert.equal(original.pid,run.pid);assert.equal(original.status,'running');
  assert.equal(await git(root,'rev-parse','HEAD'),beforeHead);assert.equal(await git(root,'branch','--show-current'),'main');
  console.log('Worktree smoke: sidebar create, nested dialog/Enter protection, fetch, tracking, session cwd and live-terminal preservation passed');
}

if(process.argv[1]&&fileURLToPath(import.meta.url)===path.resolve(process.argv[1])){
  const folder=await mkdtemp(path.join(os.tmpdir(),'berth-worktree-smoke-')),root=path.join(folder,'project');await mkdir(root);await mkdir('test-results',{recursive:true});
  await git(root,'init','--initial-branch=main');await git(root,'config','user.name','Worktree smoke');await git(root,'config','user.email','smoke@example.invalid');await writeFile(path.join(root,'base.txt'),'base');await git(root,'add','.');await git(root,'commit','-m','initial');
  let app,daemonPid;
  try{
    const args=[...(process.env.AGENTBERTH_TEST_PRELOAD?['-r',process.env.AGENTBERTH_TEST_PRELOAD]:[]),path.resolve('.'),'--user-data-dir='+path.join(folder,'profile'),'--use-gl=angle','--use-angle=swiftshader','--enable-unsafe-swiftshader'];if(process.platform==='linux'&&process.getuid?.()===0)args.push('--no-sandbox');const env={...process.env,AGENTBERTH_DATA_DIR:path.join(folder,'data')};delete env.ELECTRON_RUN_AS_NODE;
    app=await electron.launch({args,env,timeout:20000});const page=await app.firstWindow();page.setDefaultTimeout(12000);await page.getByRole('button',{name:'添加第一个项目'}).waitFor();
    daemonPid=JSON.parse(await readFile(path.join(folder,'data','runtime.json'),'utf8')).pid;
    const project=await page.evaluate(root=>window.berth.rpc('createProject',{name:'Worktree fixture',path:root}),root),session=await page.evaluate(projectId=>window.berth.rpc('createSession',{projectId,title:'Original shell',agent:'shell'}),project.id),run=await page.evaluate(sessionId=>window.berth.rpc('start',{sessionId,cols:120,rows:25}),session.id);
    page.on('pageerror',error=>console.error(error));await checkWorktrees(page,{folder,root,project,session,run});
  }catch(error){if(app){const page=await app.firstWindow();console.error(await page.locator('body').innerText());await page.screenshot({path:'test-results/worktree-failure.png'}).catch(()=>{});}throw error;}
  finally{if(app)await app.close();if(daemonPid){try{process.kill(daemonPid,'SIGTERM');}catch{}}await rm(folder,{recursive:true,force:true,maxRetries:8,retryDelay:100});}
}
