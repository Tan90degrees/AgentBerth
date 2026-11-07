// Source-smoke launcher only: exercise the real renderer and backend with
// controlled read failures. No fault handler is shipped in the application.
const {ipcMain}=require('electron');
const register=ipcMain.handle.bind(ipcMain);
globalThis.uiFaults={fail:{},hold:null,release:null,calls:[]};
ipcMain.handle=(channel,handler)=>register(channel,channel!=='berth:rpc'?handler:async(event,method,params)=>{
  const faults=globalThis.uiFaults;
  if(['acpSnapshot','acpSend','runs','output','start','deleteRun'].includes(method))faults.calls.push({method,params});
  const fail=!!faults.fail[method];if(fail)faults.fail[method]--;
  if(faults.hold===method)await new Promise(resolve=>{faults.release=()=>{faults.release=null;faults.hold=null;resolve();};});
  if(fail)throw new Error('UI read fixture unavailable');
  return handler(event,method,params);
});
require(process.env.AGENTBERTH_UI_SMOKE_MAIN);
