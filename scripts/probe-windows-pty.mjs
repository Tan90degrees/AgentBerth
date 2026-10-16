import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const require = createRequire(import.meta.url), execute = promisify(execFile);
const mode=process.argv[2];
if (!mode) {
  for (const backend of ['system','bundled']) for (let n=0;n<3;n++) {
    console.log('PROBE',backend,n);
    const child=spawn(require('electron'),[fileURLToPath(import.meta.url),backend],{env:{...process.env,ELECTRON_RUN_AS_NODE:'1'},stdio:['ignore','pipe','pipe']});
    child.stdout.pipe(process.stdout); child.stderr.pipe(process.stderr);
    await new Promise(resolve=>{
      const timer=setTimeout(async()=>{console.log('PROBE TIMEOUT',backend,child.pid);try{await execute('taskkill.exe',['/PID',String(child.pid),'/T','/F']);}catch{}resolve();},15000);
      child.once('exit',code=>{clearTimeout(timer);console.log('PROBE EXIT',backend,code);resolve();});
    });
  }
} else {
  const pty=require('node-pty');
  const {Terminal}=require('@xterm/headless');
  const terminal=new Terminal({cols:100,rows:30,allowProposedApi:true});
  console.log('spawn',mode);
  const child=pty.spawn(path.join(process.env.ProgramFiles,'PowerShell','7','pwsh.exe'),['-NoLogo'],{cwd:process.cwd(),cols:100,rows:30,env:{...process.env},useConptyDll:mode==='bundled'});
  console.log('spawned',child.pid);
  let pending=false, output='',seq=0;
  child.onData(text=>{
    output+=text;terminal.write(text,()=>seq++);
    if(!pending&&output.includes('REAL_PWSH_Core')){
      pending=true;
      setTimeout(async()=>{
        console.log('taskkill start',child.pid);
        try {console.log('taskkill result',await execute('taskkill.exe',['/PID',String(child.pid),'/T','/F'],{windowsHide:true,timeout:5000}));}catch(e){console.log('taskkill error',e.message)}
      },150);
    }
  });
  child.onExit(async event=>{
    console.log('onExit',event,'kill start');
    child.kill();
    console.log('kill returned');
    await new Promise(resolve=>terminal.write('',resolve));
    console.log('screen flushed',seq);
    terminal.dispose();
    setTimeout(()=>console.log('resources',process.getActiveResourcesInfo()),2200);
  });
  setInterval(()=>console.log('heartbeat',seq),1000).unref();
  child.write('Write-Output ("REAL_PWSH_" + $PSVersionTable.PSEdition)\r');
}
