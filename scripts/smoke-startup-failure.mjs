import { _electron as electron } from 'playwright';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtemp, mkdir, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const packaged=process.argv.includes('--packaged');
const root=await mkdtemp(path.join(os.tmpdir(),'berth-legacy-startup-'));
const data=path.join(root,'data');
await mkdir(data);
const db=new DatabaseSync(path.join(data,'berth.sqlite'));
db.exec('CREATE TABLE projects (id TEXT PRIMARY KEY); PRAGMA user_version=5;');
db.close();
let application;
try {
  const args=[...(packaged?[]:[path.resolve('.')]),'--user-data-dir='+path.join(root,'profile')];
  if(process.platform==='linux'&&process.getuid?.()===0)args.push('--no-sandbox');
  const env={...process.env,AGENTBERTH_DATA_DIR:data};
  delete env.ELECTRON_RUN_AS_NODE;
  application=await electron.launch({
    executablePath:packaged?path.resolve('release/win-unpacked/AgentBerth.exe'):undefined,
    args,env,timeout:30000,
  });
  const page=await application.firstWindow({timeout:30000});
  page.setDefaultTimeout(30000);
  await page.getByRole('heading',{name:'无法连接工作空间',exact:true}).waitFor();
  await page.getByText(/不支持原地升级/).first().waitFor();
  const failure=JSON.parse(await readFile(path.join(data,'daemon-startup-error.json'),'utf8'));
  assert.match(failure.message,/不支持原地升级/);
  const untouched=new DatabaseSync(path.join(data,'berth.sqlite'),{readOnly:true});
  assert.equal(untouched.prepare('PRAGMA user_version').get().user_version,5);
  untouched.close();
  assert.equal(await page.getByRole('button',{name:'打开数据目录'}).count(),1);
  assert.equal(await page.getByRole('button',{name:'重试连接'}).count(),1);
  // Emergency exit must work even though there is no running daemon.
  const exited=new Promise((resolve,reject)=>{
    const proc=application.process();
    if(proc.exitCode!==null||proc.signalCode!==null){resolve();return;}
    proc.once('exit',resolve);
    proc.once('error',reject);
  });
  await page.getByRole('button',{name:'仅退出界面',exact:true}).click({noWaitAfter:true});
  await Promise.race([exited,new Promise((_,reject)=>setTimeout(()=>reject(new Error('Desktop-only quit blocked by failed daemon')),12000))]);
  console.log('Startup-failure smoke: legacy database preserved; actual startup error visible; desktop can exit without daemon');
} finally {
  if(application){try{await application.close();}catch{}}
  await rm(root,{recursive:true,force:true,maxRetries:5});
}
