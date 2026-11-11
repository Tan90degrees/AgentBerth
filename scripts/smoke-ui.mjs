import {openNotifications} from './smoke-navigation.mjs';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,readFile} from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {_electron as electron} from 'playwright';
import {cleanupSmoke} from './smoke-cleanup.mjs';

const folder=await mkdtemp(path.join(os.tmpdir(),'berth-ui-smoke-')),root=path.join(folder,'project');
await mkdir(root);await mkdir('test-results',{recursive:true});
let app,daemonPid,failure;const errors=[];
try{
  const env={...process.env,AGENTBERTH_DATA_DIR:path.join(folder,'data'),AGENTBERTH_UI_SMOKE_MAIN:path.resolve('dist/main.cjs')};delete env.ELECTRON_RUN_AS_NODE;
  const args=[...(process.env.AGENTBERTH_TEST_PRELOAD?['-r',process.env.AGENTBERTH_TEST_PRELOAD]:[]),path.resolve('tests/fixtures/ui-faults.cjs'),'--user-data-dir='+path.join(folder,'profile'),...(process.platform==='linux'?['--no-sandbox']:[])];
  app=await electron.launch({args,env,timeout:30000});const page=await app.firstWindow();page.setDefaultTimeout(15000);page.on('pageerror',error=>errors.push(error.message));
  await page.getByRole('button',{name:'添加第一个项目',exact:true}).waitFor();daemonPid=JSON.parse(await readFile(path.join(folder,'data','runtime.json'),'utf8')).pid;
  const rpc=(method,params={})=>page.evaluate(({method,params})=>window.berth.rpc(method,params),{method,params});
  const faults=values=>app.evaluate((_,values)=>Object.assign(globalThis.uiFaults,values),values);
  const connection=async connected=>{await app.evaluate(({BrowserWindow},connected)=>{for(const window of BrowserWindow.getAllWindows())window.webContents.send('berth:event',{event:'connection',data:{connected}});},connected);await page.locator('.sidebar-bottom').getByText(connected?'后台已连接':'后台未连接',{exact:true}).waitFor();};
  const select=id=>page.locator(`.session-row[data-session-id="${id}"] .session-item`).click();
  const count=method=>app.evaluate((_,method)=>globalThis.uiFaults.calls.filter(call=>call.method===method).length,method);
  async function until(fn){const end=Date.now()+15000;while(Date.now()<end){if(await fn())return;await new Promise(resolve=>setTimeout(resolve,40));}throw new Error('UI smoke condition timed out');}
  // Welcome/help and dialog-to-dialog focus restoration.
  await page.getByRole('button',{name:/^查看键盘快捷键/}).click();await page.getByRole('dialog',{name:'键盘快捷键',exact:true}).waitFor();await page.keyboard.press('Escape');
  await page.getByRole('button',{name:'快速切换',exact:false}).focus();await page.keyboard.press('Control+Shift+p');
  await page.getByRole('combobox',{name:'搜索项目、会话和操作',exact:true}).fill('键盘快捷键');await page.keyboard.press('Enter');
  await page.getByRole('dialog',{name:'键盘快捷键',exact:true}).waitFor();await page.keyboard.press('Escape');assert.equal(await page.locator('.quick-link').evaluate(node=>node===document.activeElement),true);
  const project=await rpc('createProject',{name:'UI workspace',path:root});
  const shell=await rpc('createSession',{projectId:project.id,title:'UI terminal',agent:'shell'});await select(shell.id);const run=await rpc('start',{sessionId:shell.id,cols:90,rows:24});
  await page.locator('[data-testid="terminal"] .xterm').waitFor();
  const tabs=page.getByRole('tablist',{name:'工作区内容',exact:true}),terminal=tabs.getByRole('tab',{name:'终端',exact:true});
  await terminal.focus();await page.keyboard.press('ArrowRight');await tabs.getByRole('tab',{name:'运行记录',exact:true}).and(page.locator('[aria-selected="true"]')).waitFor();
  await page.keyboard.press('Home');await until(()=>terminal.evaluate(node=>node===document.activeElement));assert.equal(await terminal.getAttribute('aria-selected'),'true');
  await page.keyboard.press('ArrowUp');assert.equal(await terminal.evaluate(node=>node===document.activeElement),true,'Horizontal tabs must preserve vertical navigation');
  const activity=page.locator('.activity-bar');const sessionButton=activity.getByRole('button',{name:'会话',exact:true});await sessionButton.focus();await page.keyboard.press('Enter');assert.equal(await sessionButton.getAttribute('aria-pressed'),'true');
  await rpc('input',{sessionId:shell.id,runId:run.id,data:'echo '+ 'Z'.repeat(300)+'UI_COPY_READY\r'});await until(()=>rpc('attach',{sessionId:shell.id}).then(value=>value.snapshot.includes('UI_COPY_READY')));
  const unchanged=(await rpc('state')).sessions.find(value=>value.id===shell.id).latestRun;assert.equal(unchanged.id,run.id);assert.equal(unchanged.pid,run.pid);
  // Recover read-only run/output failures without restarting the command.
  await faults({fail:{runs:1}});await tabs.getByRole('tab',{name:'运行记录',exact:true}).click();await page.locator('.runs-load-error').waitFor();await page.locator('.runs-load-error').getByRole('button',{name:'重试',exact:true}).click();
  const row=page.locator('.run-row').filter({hasText:run.id.slice(0,8)});await row.waitFor();await faults({fail:{output:1}});await row.locator('.run-item').click();await page.getByRole('heading',{name:'无法读取本次输出',exact:true}).waitFor();
  const starts=await count('start');await page.locator('.output-error').getByRole('button',{name:'重试',exact:true}).click();await page.locator('.output-error').waitFor({state:'hidden'});assert.equal(await count('start'),starts);
  await page.getByRole('button',{name:'查找',exact:true}).click();await page.getByLabel('查找终端文字',{exact:true}).fill('UI_COPY_READY');await page.getByRole('search').getByRole('status').filter({hasText:'已定位'}).waitFor();
  const outputMount=page.locator('.output-host .terminal-mount'),beforeCols=await outputMount.getAttribute('data-cols');
  const bounds=await app.evaluate(({BrowserWindow})=>{const window=BrowserWindow.getAllWindows()[0],bounds=window.getBounds();window.setSize(bounds.width-60,bounds.height-10);return bounds;});
  await until(async()=>await outputMount.getAttribute('data-cols')!==beforeCols);await page.getByRole('button',{name:'复制选中',exact:true}).click();await until(()=>page.evaluate(()=>window.berth.readClipboard()).then(value=>value==='UI_COPY_READY'));
  await page.getByRole('button',{name:'关闭终端查找',exact:true}).click();await app.evaluate(({BrowserWindow},bounds)=>BrowserWindow.getAllWindows()[0].setBounds(bounds),bounds);
  await page.getByRole('button',{name:'返回列表',exact:true}).click();await connection(false);await row.locator('.run-item').click();await page.getByRole('heading',{name:'无法读取本次输出',exact:true}).waitFor();await connection(true);
  await tabs.getByRole('tab',{name:'终端',exact:true}).click();
  // A delayed deletion in another session must not close the current output.
  const other=await rpc('createSession',{projectId:project.id,title:'Other terminal',agent:'shell'});
  const oldRun=await rpc('start',{sessionId:other.id,cols:90,rows:24});await rpc('stop',{sessionId:other.id});
  await until(()=>rpc('runs',{sessionId:other.id}).then(runs=>runs.every(run=>!['running','stopping'].includes(run.status))));
  await select(other.id);await tabs.getByRole('tab',{name:'运行记录',exact:true}).click();
  const setVersion=async version=>app.evaluate(({BrowserWindow},{state,version})=>{for(const window of BrowserWindow.getAllWindows())window.webContents.send('berth:event',{event:'state',data:{...state,apiVersion:version}});},{state:await rpc('state'),version});
  await setVersion(52);const deletesBefore=await count('deleteRun');
  const deleteButton=page.locator('.run-row').filter({hasText:oldRun.id.slice(0,8)}).getByRole('button',{name:'删除运行记录 '+oldRun.id.slice(0,8),exact:true});
  await deleteButton.click();const permanentDelete=page.getByRole('dialog',{name:'删除此运行记录？',exact:true});await permanentDelete.waitFor();
  assert.equal(await count('deleteRun'),deletesBefore,'Old daemons must not delete before confirmation');
  await permanentDelete.getByRole('button',{name:'取消',exact:true}).click();assert.equal((await rpc('runs',{sessionId:other.id})).length,1);
  await setVersion(53);
  await faults({hold:'deleteRun'});await page.locator('.run-row').filter({hasText:oldRun.id.slice(0,8)}).getByRole('button',{name:'删除运行记录 '+oldRun.id.slice(0,8),exact:true}).click();
  await until(()=>app.evaluate(()=>!!globalThis.uiFaults.release));await select(shell.id);
  await tabs.getByRole('tab',{name:'运行记录',exact:true}).click();await row.locator('.run-item').click();
  await page.getByRole('button',{name:'返回列表',exact:true}).waitFor();await app.evaluate(()=>globalThis.uiFaults.release());
  const deletionToast=page.locator('.notification-item').filter({hasText:'已删除'}).first();await deletionToast.waitFor();
  assert.equal(await page.getByRole('button',{name:'返回列表',exact:true}).isVisible(),true,'Late deletion closed another session output');
  await deletionToast.getByRole('button',{name:'关闭提示',exact:true}).click();
  await tabs.getByRole('tab',{name:'终端',exact:true}).click();
  // New notifications collapse after five seconds without deleting history.
  await page.locator(`.project-branch[data-project-id="${project.id}"]>.project-row`).click({button:'right'});await page.getByRole('menuitem',{name:'复制项目路径',exact:true}).click();
  const panel=page.locator('.notification-panel');await panel.waitFor();const box=await panel.boundingBox();assert.ok(box.y<200&&box.x>300,'Notifications belong in the top right');await page.screenshot({path:'test-results/notification-center.png'});await page.waitForTimeout(5200);assert.equal(await panel.isVisible(),false);await openNotifications(page);assert.ok((await panel.innerText()).includes('已复制'));await page.getByRole('button',{name:'收起通知中心',exact:true}).click();
  // ACP first load, refresh failures, queued events and stale responses.
  const program=await app.evaluate(()=>process.execPath),agent=await rpc('createAgent',{name:'UI ACP',command:program,acp:{executable:program,args:[path.resolve('tests/fixtures/acp-agent.cjs'),root,'--slow-init'],env:{ELECTRON_RUN_AS_NODE:'1'}}});
  const session=await rpc('createSession',{projectId:project.id,title:'UI ACP conversation',agent:agent.id});
  await faults({fail:{acpSnapshot:1}});await select(session.id);const conversation=page.getByRole('region',{name:'ACP 对话',exact:true});
  await conversation.getByRole('heading',{name:'暂时无法读取对话',exact:true}).waitFor();await conversation.getByRole('button',{name:'重新读取',exact:true}).click();await conversation.getByRole('button',{name:'连接 Agent',exact:true}).waitFor();assert.equal(await conversation.getByLabel('发送给 Agent 的消息',{exact:true}).isDisabled(),true,'A disconnected Agent must not accept Enter submissions');await rpc('start',{sessionId:session.id,cols:90,rows:24});
  const composer=conversation.getByLabel('发送给 Agent 的消息',{exact:true});await until(()=>composer.isEnabled());await composer.fill('hello');await composer.press('Enter');await conversation.getByText('hello from small',{exact:true}).waitFor();await composer.fill('unsent draft');
  const sends=await count('acpSend'),beforeRefresh=await count('acpSnapshot');await connection(false);await conversation.getByText('ACP · 后台未连接',{exact:true}).waitFor();assert.equal(await count('acpSnapshot'),beforeRefresh,'Offline views must not issue snapshot RPCs');
  await faults({fail:{acpSnapshot:1}});await connection(true);await conversation.locator('.acp-load-error').waitFor();assert.equal(await conversation.getByText('hello from small',{exact:true}).isVisible(),true);assert.equal(await composer.isDisabled(),true);
  await conversation.getByRole('button',{name:'重新读取',exact:true}).click();await until(()=>composer.isEnabled());assert.equal(await composer.inputValue(),'unsent draft');assert.equal(await count('acpSend'),sends,'Reading must never replay a prompt');
  await connection(false);await faults({hold:'acpSnapshot',fail:{acpSnapshot:1}});await connection(true);await until(()=>app.evaluate(()=>!!globalThis.uiFaults.release));
  await select(shell.id);await app.evaluate(()=>globalThis.uiFaults.release());await tabs.getByRole('tab',{name:'终端',exact:true}).waitFor();assert.equal(await page.locator('.acp-load-error:visible').count(),0,'Old reads cannot report errors in another session');
  await select(session.id);await until(()=>composer.isEnabled());assert.equal(await composer.inputValue(),'unsent draft');
  await page.screenshot({path:'test-results/ui-recovery-dark.png',animations:'disabled'});await page.evaluate(()=>document.documentElement.dataset.theme='light');await page.screenshot({path:'test-results/ui-recovery-light.png',animations:'disabled'});
  assert.deepEqual(errors,[]);
}catch(error){failure=error;if(app)await app.firstWindow().then(page=>page.screenshot({path:'test-results/ui-smoke-failure.png'})).catch(()=>{});}
finally{try{await cleanupSmoke(app,daemonPid,folder);}catch(error){failure??=error;}}
if(failure)throw failure;
console.log('UI usability smoke passed: keyboard focus, paused notices, offline output, ACP read recovery, draft retention and stale response isolation');
