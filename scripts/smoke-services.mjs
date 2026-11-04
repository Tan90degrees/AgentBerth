import {openExtensionView} from './smoke-navigation.mjs';
import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {mkdtemp,mkdir,readFile,writeFile} from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {_electron as electron} from 'playwright';
import {cleanupSmoke} from './smoke-cleanup.mjs';

const packaged=process.argv.includes('--packaged'),execute=promisify(execFile);
const folder=await mkdtemp(path.join(os.tmpdir(),'berth-services-smoke-')),root=path.join(folder,'project');await mkdir(root);await mkdir('test-results',{recursive:true});
let app,daemonPid,failure;const errors=[];
try{
  const env={...process.env,AGENTBERTH_DATA_DIR:path.join(folder,'data')};delete env.ELECTRON_RUN_AS_NODE;
  const args=[...(process.env.AGENTBERTH_TEST_PRELOAD?['-r',process.env.AGENTBERTH_TEST_PRELOAD]:[]),...(packaged?[]:[path.resolve('.')]),'--user-data-dir='+path.join(folder,'profile'),'--use-gl=angle','--use-angle=swiftshader','--enable-unsafe-swiftshader',...(process.platform==='linux'?['--no-sandbox']:[])];
  app=await electron.launch({executablePath:packaged?path.resolve('release/win-unpacked/AgentBerth.exe'):undefined,args,env,timeout:30000});
  const page=await app.firstWindow();page.on('pageerror',error=>errors.push(error.message));page.setDefaultTimeout(15000);
  const rpc=(method,params={})=>page.evaluate(({method,params})=>window.berth.rpc(method,params),{method,params});
  async function until(check){const end=Date.now()+20000;while(Date.now()<end){if(await check())return;await new Promise(r=>setTimeout(r,50));}throw new Error('Smoke condition timed out');}
  await until(()=>rpc('state').then(state=>state.apiVersion>=51));daemonPid=JSON.parse(await readFile(path.join(folder,'data','runtime.json'),'utf8')).pid;
  const project=await rpc('createProject',{name:'Service workspace',path:root});
  const {stdout}=await execute('node',['-p','process.execPath']);const node=stdout.trim(),counter=path.join(folder,'service-starts.jsonl');
  const quote=value=>"'"+value.replaceAll("'",process.platform==='win32'?"''":"'\\''")+"'";
  const command=(process.platform==='win32'?'& ':'')+[node,path.resolve('tests/fixtures/service-job.cjs'),counter].map(quote).join(' ');
  const session=await rpc('createSession',{projectId:project.id,title:'Readonly service',agent:'shell',service:true,command});
  await page.locator(`.project-branch[data-project-id="${project.id}"]`).waitFor();
  // The project may be collapsed on first creation.
  if(!await page.locator(`.session-row[data-session-id="${session.id}"]`).isVisible())await page.locator(`.project-branch[data-project-id="${project.id}"] .project-item`).click();
  await page.locator(`.session-row[data-session-id="${session.id}"] .session-item`).click();
  await page.getByRole('button',{name:'启动服务',exact:true}).click();
  await until(()=>rpc('attach',{sessionId:session.id}).then(value=>value.snapshot.includes('SERVICE_READY')));
  assert.equal(await page.getByRole('button',{name:'粘贴',exact:true}).count(),0);
  await page.getByRole('button',{name:'停止服务',exact:true}).click();await until(()=>rpc('attach',{sessionId:session.id}).then(value=>value.run?.status==='stopped'));
  await page.getByRole('button',{name:'重启服务',exact:true}).click();await until(async()=>((await readFile(counter,'utf8')).trim().split('\n').length===2));
  await page.screenshot({path:'test-results/service-terminal-dark.png'});
  // Bulk tree operations preserve the selected, running service and search text.
  const otherRoot=path.join(folder,'other-project');await mkdir(otherRoot);
  const other=await rpc('createProject',{name:'Other project',path:otherRoot});await rpc('createSession',{projectId:other.id,title:'Other session',agent:'shell'});
  const stable=(await rpc('state')).sessions.find(value=>value.id===session.id).latestRun;
  assert.equal(await page.locator('.main>.workbench-header').count(),1);assert.equal(await page.locator('.project-header,.session-header').count(),0);
  const chrome=await page.locator('.workbench-header').boundingBox();assert.ok(chrome.height<=44);assert.equal(await page.getByRole('button',{name:'折叠顶部信息',exact:true}).count(),0);
  await page.getByRole('button',{name:'全部折叠',exact:true}).click();assert.equal(await page.locator('.project-toggle[aria-expanded=true]').count(),0);assert.equal(await page.locator('.workbench-header').getAttribute('data-session-id'),session.id);
  await page.getByRole('button',{name:'全部展开',exact:true}).click();assert.equal(await page.locator('.project-toggle[aria-expanded=true]').count(),2);
  const treeSearch=page.getByRole('textbox',{name:'搜索项目和会话',exact:true});await treeSearch.fill('Other');await page.locator(`.session-row[data-session-id="${session.id}"]`).waitFor({state:'hidden'});
  await page.getByRole('button',{name:'全部折叠',exact:true}).click();assert.equal(await treeSearch.inputValue(),'Other');assert.equal(await page.locator('.project-toggle[aria-expanded=true]').count(),0);
  await page.getByRole('button',{name:'全部展开',exact:true}).click();assert.equal(await treeSearch.inputValue(),'Other');await treeSearch.fill('');
  await page.locator(`.session-row[data-session-id="${session.id}"]`).waitFor();
  const beforePlugins=await page.locator('.sidebar-panel:visible').boundingBox(),pluginRoot=path.join(folder,'layout-extension');await mkdir(pluginRoot);
  await writeFile(path.join(pluginRoot,'agentberth.extension.json'),JSON.stringify({apiVersion:1,id:'layout.smoke',name:'Layout extension',version:'1.0.0',entry:'index.cjs',views:Array.from({length:16},(_,i)=>({id:'view'+i,title:'Layout view '+i,location:'sidebar',entry:'view.html'}))}));
  await writeFile(path.join(pluginRoot,'index.cjs'),'exports.apply=()=>{};');await writeFile(path.join(pluginRoot,'view.html'),'<h2>Layout extension</h2>');
  await page.evaluate(path=>window.berth.extensions({action:'install',path,development:true}),pluginRoot);
  assert.ok(Math.abs((await page.locator('.sidebar-panel:visible').boundingBox()).height-beforePlugins.height)<2,'Adding 16 extension views must not shrink the session tree');
  await page.getByRole('button',{name:'扩展应用',exact:true}).click();const launcher=page.getByRole('dialog',{name:'扩展应用',exact:true});await launcher.waitFor();
  assert.equal(await launcher.locator('.plugin-launcher-entry').count(),18);assert.ok(await launcher.locator('.plugin-launcher-list').evaluate(node=>node.scrollHeight>node.clientHeight));
  await page.screenshot({path:'test-results/workbench-extension-launcher.png'});
  await launcher.getByRole('textbox',{name:'搜索扩展应用',exact:true}).fill('Layout view 15');assert.equal(await launcher.locator('.plugin-launcher-entry').count(),1);await page.keyboard.press('Escape');await launcher.waitFor({state:'hidden'});
  await page.getByRole('button',{name:'扩展应用',exact:true}).click();await launcher.waitFor();await page.locator('.quick-link').focus();await launcher.waitFor({state:'hidden'});assert.equal(await page.locator('.quick-link').evaluate(node=>node===document.activeElement),true);
  const retained=(await rpc('state')).sessions.find(value=>value.id===session.id).latestRun;assert.equal(retained.id,stable.id);assert.equal(retained.pid,stable.pid);
  await page.getByRole('button',{name:'停止服务',exact:true}).click();
  // Verify the persisted form exposes the service configuration, including its command.
  await page.locator(`.session-row[data-session-id="${session.id}"]`).click({button:'right'});await page.getByRole('menuitem',{name:'编辑会话',exact:true}).click();
  assert.equal(await page.getByLabel('终端模式',{exact:true}).inputValue(),'service');assert.equal(await page.getByLabel('启动命令',{exact:true}).inputValue(),command);await page.getByRole('button',{name:'取消',exact:true}).click();
  // Fresh plugins display effective defaults, without creating a dirty draft.
  await openExtensionView(page,'DeepSeek Harness');
  await page.locator('.plugin-web-actions').getByRole('button',{name:'设置',exact:true}).click();
  const harnessSettings=page.getByRole('dialog',{name:'配置插件 · DeepSeek Harness',exact:true});await harnessSettings.waitFor();
  const executable=harnessSettings.getByLabel('DeepSeek Harness 启动程序',{exact:true}),arguments_=harnessSettings.getByLabel('DeepSeek Harness 启动参数',{exact:true});
  assert.equal(await executable.inputValue(),'npx');assert.equal(await arguments_.isVisible(),false);assert.equal(await harnessSettings.getByRole('button',{name:'保存配置',exact:true}).count(),0);
  assert.equal(await harnessSettings.locator('iframe').count(),0);assert.equal(await harnessSettings.getByText('ACP',{exact:false}).count(),0);assert.equal(await harnessSettings.getByText('开发文档与工具',{exact:true}).count(),0);
  await executable.fill('dsh');await harnessSettings.getByRole('button',{name:'保存配置',exact:true}).waitFor();
  await harnessSettings.getByRole('button',{name:'恢复默认',exact:true}).click();assert.equal(await executable.inputValue(),'npx');assert.equal(await harnessSettings.getByRole('button',{name:'保存配置',exact:true}).count(),0);
  await page.screenshot({path:'test-results/harness-settings-dark.png'});
  const theme=await page.evaluate(()=>document.documentElement.dataset.theme);await page.evaluate(()=>{document.documentElement.dataset.theme='light';});await page.screenshot({path:'test-results/harness-settings-light.png',animations:'disabled'});await page.evaluate(theme=>{if(theme)document.documentElement.dataset.theme=theme;else delete document.documentElement.dataset.theme;},theme);
  await harnessSettings.getByText('高级选项',{exact:true}).click();assert.ok(JSON.parse(await arguments_.inputValue()).includes('@deepseek-ai/dsh'));
  await page.screenshot({path:'test-results/harness-settings-advanced.png'});
  await harnessSettings.getByRole('button',{name:'关闭',exact:true}).click();
  const starts=path.join(folder,'web-starts.jsonl');
  await page.evaluate(({node,starts,fixture})=>window.berth.extensions({action:'configure',id:'deepseek-harness',config:{executable:node,args:JSON.stringify([fixture,starts])}}),{node,starts,fixture:path.resolve('tests/fixtures/harness-web.cjs')});
  await openExtensionView(page,'DeepSeek Harness');
  assert.equal(await page.getByLabel('Web 服务项目',{exact:true}).count(),0);await page.getByRole('button',{name:'启动',exact:true}).click();
  await until(()=>app.evaluate(({webContents})=>webContents.getAllWebContents().some(w=>!w.isDestroyed()&&w.getTitle()==='Harness Native Fixture')));
  const native=()=>app.evaluate(({webContents,BrowserWindow})=>{const w=webContents.getAllWebContents().find(w=>!w.isDestroyed()&&w.getTitle()==='Harness Native Fixture');if(!w)return null;const owner=BrowserWindow.getAllWindows().find(win=>win.getTitle().startsWith('AgentBerth')&&win.contentView.children.some(v=>v.webContents?.id===w.id));const view=owner?.contentView.children.find(v=>v.webContents?.id===w.id);return {id:w.id,url:w.getURL(),visible:view?.getVisible(),bounds:view?.getBounds(),preferences:w.getLastWebPreferences()};});
  await until(async()=>(await native())?.visible===true);
  const original=await native();assert.ok(original.bounds.width>400&&original.bounds.height>200);assert.equal(original.preferences.nodeIntegration,false);assert.equal(original.preferences.sandbox,true);assert.ok(!original.preferences.preload);
  const nativePage=app.context().pages().find(p=>p.url().startsWith('http://127.0.0.1:'));assert.ok(nativePage,'Native web view must have an independent browser page');
  await nativePage.getByText('undefined/undefined/undefined',{exact:true}).waitFor();await nativePage.getByLabel('原生输入').fill('Native interaction works');await nativePage.getByRole('button',{name:'发送',exact:true}).click();await nativePage.locator('#result').getByText('Native interaction works',{exact:true}).waitFor();
  await page.screenshot({path:'test-results/harness-native-web-dark.png'});
  await nativePage.screenshot({path:'test-results/harness-original-frontend.png'});
  // Resize and native authentication must not cause a second service launch.
  await app.evaluate(({BrowserWindow})=>{const target=BrowserWindow.getAllWindows().find(w=>w.getTitle()==='AgentBerth · 泊栈');if(!target)throw new Error('Workbench window missing');const [width]=target.getSize();target.setSize(width>1100?1000:1200,820);});
  await until(async()=>Math.abs(((await native())?.bounds.width??original.bounds.width)-original.bounds.width)>10);
  const resized=await native(),hostBounds=await page.locator('.plugin-web-host').boundingBox();
  const zoom=await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows().find(w=>w.getTitle()==='AgentBerth · 泊栈').webContents.getZoomFactor());
  assert.ok(Math.abs(resized.bounds.width-hostBounds.width*zoom)<=1,'Native browser width must follow its host after resize');
  assert.ok(Math.abs(resized.bounds.x-hostBounds.x*zoom)<=1,'Native browser position must follow its host after resize');
  // Open a workbench modal while the native browser is active: it must hide.
  await page.locator('.plugin-web-toolbar').click({position:{x:5,y:5}});await page.keyboard.press('Control+Shift+p');await page.getByRole('dialog').waitFor();await until(async()=>(await native())?.visible===false);await page.keyboard.press('Escape');await until(async()=>(await native())?.visible===true);
  await page.locator('.sidebar-settings button[aria-label="设置"]').focus();await page.locator('.sidebar-settings button[aria-label="设置"]').press('Enter');await until(async()=>(await native())?.visible===false);
  await openExtensionView(page,'DeepSeek Harness');await until(async()=>(await native())?.visible===true);assert.equal((await native()).id,original.id);
  assert.equal((await readFile(starts,'utf8')).trim().split('\n').length,1);
  await page.getByRole('button',{name:'停止',exact:true}).click();await until(async()=>(await native())?.visible===false);assert.deepEqual(errors,[]);
}catch(error){failure=error;if(app)await app.firstWindow().then(page=>page.screenshot({path:'test-results/services-failure.png'})).catch(()=>{});}
finally{try{await cleanupSmoke(app,daemonPid,folder);}catch(error){failure??=error;}}
if(failure)throw failure;
console.log('Service terminal and native Harness Web smoke passed');
