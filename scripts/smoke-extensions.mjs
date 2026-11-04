import {openExtensionView} from './smoke-navigation.mjs';
import { _electron as electron } from 'playwright';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

const packaged=process.argv.includes('--packaged');
if(packaged&&process.platform!=='win32')throw new Error('Packaged extension smoke requires Windows');
const root=await mkdtemp(path.join(os.tmpdir(),'berth-plugin-smoke-')),source=path.join(root,'plugin');await mkdir(source);await mkdir('test-results',{recursive:true});
const manifest={apiVersion:1,id:'example.smoke',name:'Smoke extension',version:'1.0.0',entry:'index.cjs',desktopEntry:'desktop.cjs',dependencies:['agents'],config:{name:{type:'string',title:'Agent name',default:'Plugin Agent'},mode:{type:'string',title:'Mode',enum:['basic','advanced'],default:'basic'},...Object.fromEntries(Array.from({length:18},(_,i)=>['field'+i,{type:'string',title:'Extra field '+i,default:'value'}]))},views:[{id:'info',title:'Plugin info',location:'sidebar',entry:'view.html'}]};
const code=`exports.apply=(ctx,c)=>{ctx.berth.agent({id:'main',definition:{name:c.name,command:'fixture-agent',skills:{project:'.fixture/skills'}}});ctx.berth.command({name:'info',description:'Read configured name',inputSchema:{type:'object',properties:{},additionalProperties:false}},()=>({name:c.name}));};`;
await Promise.all([
  writeFile(path.join(source,'agentberth.extension.json'),JSON.stringify(manifest)),writeFile(path.join(source,'index.cjs'),code),
  writeFile(path.join(source,'desktop.cjs'),`exports.apply=(ctx,c)=>{const{BrowserWindow}=require('electron');ctx.effect(()=>{const win=new BrowserWindow({show:false,title:'Plugin native '+c.name,webPreferences:{sandbox:true,nodeIntegration:false,contextIsolation:true}});return()=>{if(!win.isDestroyed())win.destroy();};});};`),
  writeFile(path.join(source,'view.html'),`<button id="read" data-calls="0">Read plugin</button><pre id="result"></pre><script>document.querySelector('#read').onclick=async()=>{const button=document.querySelector('#read');button.dataset.calls=String(Number(button.dataset.calls)+1);document.querySelector('#result').textContent=JSON.stringify(await agentberth.call('info'));};</script>`),
]);
let application,daemonPid;
try {
  const args=[...(process.env.AGENTBERTH_TEST_PRELOAD?['-r',process.env.AGENTBERTH_TEST_PRELOAD]:[]),...(packaged?[]:[path.resolve('.')]),'--use-gl=angle','--use-angle=swiftshader','--enable-unsafe-swiftshader','--user-data-dir='+path.join(root,'profile')];if(process.platform==='linux'&&process.getuid?.()===0)args.push('--no-sandbox');
  const env={...process.env,AGENTBERTH_DATA_DIR:path.join(root,'data')};delete env.ELECTRON_RUN_AS_NODE;
  application=await electron.launch({executablePath:packaged?path.resolve('release/win-unpacked/AgentBerth.exe'):undefined,args,env,timeout:20000});
  const page=await application.firstWindow();page.setDefaultTimeout(15000);const errors=[];page.on('pageerror',e=>errors.push(e.message));
  await page.getByRole('button',{name:'添加第一个项目'}).waitFor();daemonPid=JSON.parse(await readFile(path.join(root,'data','runtime.json'),'utf8')).pid;
  await page.evaluate(source=>window.berth.extensions({action:'install',path:source}),source);
  await page.locator('.sidebar-settings').getByRole('button',{name:'插件',exact:true}).click();
  await page.getByRole('heading',{name:'插件中心'}).waitFor();
  assert.equal(await page.getByRole('navigation',{name:'设置分类'}).count(),0,'Core settings navigation must be separate from Plugins');
  await page.getByRole('navigation',{name:'插件分类'}).getByRole('button',{name:/Agent 接入/}).click();
  const card=page.locator('[data-plugin-id="example.smoke"]');await card.getByText('已启用',{exact:true}).waitFor();
  // All plugin actions must share the same geometry; semantic color variants
  // must not regress to mixed borderless text links and full-sized buttons.
  const actionStyles=await card.locator(':scope > header .extension-actions button').evaluateAll(buttons=>buttons.map(button=>{
    const style=getComputedStyle(button);
    return {height:Math.round(button.getBoundingClientRect().height),radius:style.borderRadius,fontSize:style.fontSize,borderWidth:style.borderTopWidth,classes:button.className};
  }));
  assert.equal(actionStyles.length,4,'Installed extension exposes configure, enable/disable, reload and uninstall');
  assert.ok(actionStyles.every(({classes})=>classes.includes('extension-button')),JSON.stringify(actionStyles));
  assert.equal(new Set(actionStyles.map(({height,radius,fontSize,borderWidth})=>[height,radius,fontSize,borderWidth].join(':'))).size,1,JSON.stringify(actionStyles));
  assert.equal(actionStyles[0].height>=34,true,'Plugin actions should meet the common minimum height');
  assert.equal(actionStyles.at(-1).classes.includes('danger'),true,'Uninstall must use the destructive action variant');
  assert.equal(await page.locator('.extension-utilities .extension-button').count(),0,'Developer tools must stay inside owner plugin settings');
  await page.waitForFunction(()=>window.berth.rpc('state').then(s=>s.agents.some(a=>a.name==='Plugin Agent')));
  const nativeCount=()=>application.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows().filter(w=>w.getTitle().startsWith('Plugin native ')).length);
  for(let i=0;i<100&&await nativeCount()!==1;i++)await new Promise(r=>setTimeout(r,50));assert.equal(await nativeCount(),1);
  assert.equal(await card.getByLabel('Smoke extension Agent name').count(),0,'Plugin configuration must not be embedded in settings');
  await card.getByRole('button',{name:'配置',exact:true}).click();
  const configDialog=page.getByRole('dialog',{name:'配置插件 · Smoke extension'});
  await configDialog.locator('.plugin-development > summary').click();await configDialog.getByRole('button',{name:'导出插件开发套件并复制指令',exact:true}).waitFor();await configDialog.locator('.plugin-development > summary').click();
  const mode=configDialog.getByLabel('Smoke extension Mode');await mode.focus();
  const spacing=await mode.evaluate(select=>{const host=select.closest('.extension-config-dialog'),box=host.getBoundingClientRect(),rect=select.getBoundingClientRect(),style=getComputedStyle(select),ring=parseFloat(style.outlineWidth)+parseFloat(style.outlineOffset);return {right:rect.right+ring,edge:box.left+host.clientLeft+host.clientWidth,left:rect.left-ring,start:box.left+host.clientLeft,scrolls:host.scrollHeight>host.clientHeight};});
  assert.ok(spacing.scrolls,'Use a genuinely scrolling plugin configuration');
  assert.ok(spacing.edge-spacing.right>=6,'Focused select must leave its outline clear of the scrollbar: '+JSON.stringify(spacing));
  assert.ok(spacing.left>=spacing.start,'Focus outline must remain inside the scrolling content');
  await page.screenshot({animations:'disabled',path:`test-results/${packaged?'packaged-':''}extensions-config-focus.png`});
  await configDialog.getByLabel('Smoke extension Agent name').fill('Updated Agent');
  await configDialog.getByRole('button',{name:'保存配置'}).click();
  await configDialog.waitFor({state:'hidden'});
  await page.waitForFunction(()=>window.berth.rpc('state').then(s=>s.agents.some(a=>a.name==='Updated Agent')));
  // Observe plugin messages independently of the React bridge so a failure
  // distinguishes iframe initialization from parent dispatch or daemon RPC.
  await page.evaluate(()=>{window.__pluginSmokeMessages=[];window.addEventListener('message',event=>{if(typeof event.data?.kind==='string'&&event.data.kind.startsWith('agentberth-plugin-'))window.__pluginSmokeMessages.push({kind:event.data.kind,id:event.data.id,command:event.data.command,error:event.data.error});});});
  await openExtensionView(page,'Plugin info');
  const frame=page.frameLocator('iframe[title="Plugin info"]');
  // Explicitly verify the sandboxed view can reach its parent before calling
  // an Agent command. The readiness probe may retry; the command never does.
  await frame.locator('body').evaluate(()=>window.agentberth.ready());
  // Playwright can see a parsed button before its trailing inline script
  // installs onclick, especially under the slower Linux/Xvfb renderer.
  for(let i=0;i<100;i++){if(await frame.locator('#read').evaluate(button=>typeof button.onclick==='function'))break;await new Promise(resolve=>setTimeout(resolve,25));}
  assert.equal(await frame.locator('#read').evaluate(button=>typeof button.onclick==='function'),true,'Plugin view must finish initializing before the first click');
  // Focus the native window and its iframe explicitly. CDP bringToFront and
  // focusing only the inner button do not establish browsing-context focus.
  const mainWindow=await application.browserWindow(page);
  await mainWindow.evaluate(win=>{if(win.isMinimized())win.restore();win.show();win.focus();win.webContents.focus();});
  await page.bringToFront();await page.locator('iframe[title="Plugin info"]').focus();
  await frame.getByRole('button',{name:'Read plugin'}).focus();
  assert.equal(await frame.locator('body').evaluate(()=>document.hasFocus()),true,'Plugin iframe must own focus before its single activation');
  await frame.getByRole('button',{name:'Read plugin'}).click();
  try{await frame.locator('#result').filter({hasText:'Updated Agent'}).waitFor();}
  catch(error){
    const diagnostic=await frame.locator('body').evaluate(()=>({result:document.querySelector('#result')?.textContent,calls:document.querySelector('#read')?.getAttribute('data-calls'),focused:document.hasFocus(),bridge:typeof window.agentberth?.call,secure:window.isSecureContext,cryptoUuid:typeof crypto?.randomUUID,frameUrl:location.href,frameConnected:window.parent!==window})).catch(reason=>({frameError:String(reason)}));
    const parentMessages=await page.evaluate(()=>window.__pluginSmokeMessages);
    const directCommand=await page.evaluate(()=>window.berth.extensions({action:'call',id:'example.smoke',command:'info'})).catch(reason=>({error:String(reason)}));
    throw new Error('Plugin iframe RPC failed: '+JSON.stringify({diagnostic,parentMessages,directCommand,pageErrors:errors}),{cause:error});
  }
  assert.equal(await frame.locator('#read').getAttribute('data-calls'),'1','Plugin command must run once without automatic replay');
  await page.screenshot({animations:'disabled',path:`test-results/${packaged?'packaged-':''}extensions-view.png`});
  await page.locator('.sidebar-settings').getByRole('button',{name:'插件',exact:true}).click();
  await card.getByRole('button',{name:'停用',exact:true}).click();await card.getByText('已停用',{exact:true}).waitFor();await page.getByRole('button',{name:'扩展应用',exact:true}).click();assert.equal(await page.getByRole('dialog',{name:'扩展应用',exact:true}).getByRole('button',{name:'Plugin info',exact:true}).count(),0);await page.keyboard.press('Escape');
  for(let i=0;i<100&&await nativeCount()!==0;i++)await new Promise(r=>setTimeout(r,50));assert.equal(await nativeCount(),0);
  await card.getByRole('button',{name:'启用',exact:true}).click();await card.getByText('已启用',{exact:true}).waitFor();
  for(const id of ['workspace','agents','ssh','files','git','resources','appearance'])assert.equal(await page.locator('[data-plugin-id="'+id+'"]').count(),0,`${id} is a core capability, not an extension`);
  const registered=(await page.evaluate(()=>window.berth.rpc('state'))).extensions.plugins.map(p=>p.manifest.id);
  for(const id of ['agent.codex','agent.claude','agent.opencode','example.smoke'])assert.ok(registered.includes(id),`${id} must be registered independently`);
  await page.locator('.sidebar-settings').getByRole('button',{name:'设置',exact:true}).click();
  await page.getByRole('navigation',{name:'设置分类'}).getByRole('button',{name:'Agent 与 Skills',exact:true}).click();
  await page.getByRole('heading',{name:'Skill 管理'}).waitFor();
  await page.locator('.sidebar-settings').getByRole('button',{name:'插件',exact:true}).click();
  await page.getByRole('navigation',{name:'插件分类'}).getByRole('button',{name:/Agent 接入/}).click();
  await page.locator('.sidebar-settings').getByRole('button',{name:'设置',exact:true}).click();
  assert.equal(await page.getByRole('navigation',{name:'插件分类'}).count(),0,'Plugin navigation must not be embedded in core settings');
  assert.equal(await page.locator('[data-setting-id="agent-integrations"]').count(),0);
  assert.equal(await page.locator('[data-setting-id="plugins"]').count(),0);
  await page.locator('.sidebar-settings').getByRole('button',{name:'插件',exact:true}).click();
  await page.screenshot({animations:'disabled',path:`test-results/${packaged?'packaged-':''}extensions-manager.png`});
  await card.getByRole('button',{name:'卸载',exact:true}).click();await card.getByText('未安装',{exact:true}).waitFor();
  assert.deepEqual(errors,[]);console.log('Extension smoke: install, config, Agent+Skills, iframe bridge, native window cleanup and dependency lifecycle passed');
} finally {
  if(application){let timer;try{await Promise.race([application.close(),new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error('Plugin smoke exit timed out')),20000);})]);}finally{clearTimeout(timer);}}
  if(daemonPid){try{process.kill(daemonPid,'SIGTERM');}catch{}}
  await rm(root,{recursive:true,force:true,maxRetries:8,retryDelay:150});
}
