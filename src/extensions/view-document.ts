// Each sandboxed plugin view has an opaque origin. Its message bridge must
// handshake with the owning renderer before delivering a command: on Linux /
// Xvfb the document can finish loading before the React frame is fully mounted.
export const extensionDocument=(html:string)=>`<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:; connect-src 'none'; form-action 'none'"><style>body{font:var(--fs-md,14px)/1.6 var(--font-sans,system-ui);margin:16px;color:var(--text,#ddd);background:var(--surface,#212121)}button,input{font:inherit}button{border:1px solid var(--border,#444);border-radius:var(--radius-sm,6px);background:transparent;padding:6px 10px}button:hover{background:var(--hover,#333)}</style><script>
let requestSequence=0,bridgeReady;
function applyTheme(theme){if(typeof document==='undefined'||!theme||typeof theme!=='object')return;for(const name of Object.keys(theme))if(/^--[a-z0-9-]+$/.test(name)&&typeof theme[name]==='string'&&theme[name].length<256)document.documentElement.style.setProperty(name,theme[name]);}
addEventListener('message',event=>{if(event.source===parent&&event.data?.kind==='agentberth-plugin-theme')applyTheme(event.data.theme);});
function waitForBridge(){
  if(bridgeReady)return bridgeReady;
  bridgeReady=new Promise((resolve,reject)=>{
    let attempts=0,settled=false;
    const onMessage=event=>{
      if(event.source!==parent||event.data?.kind!=='agentberth-plugin-ready-ack')return;
      applyTheme(event.data.theme);
      settled=true;removeEventListener('message',onMessage);resolve();
    };
    addEventListener('message',onMessage);
    const ping=()=>{
      if(settled)return;
      if(++attempts>60){settled=true;removeEventListener('message',onMessage);reject(new Error('插件视图消息桥未就绪'));return;}
      parent.postMessage({kind:'agentberth-plugin-ready'},'*');
      setTimeout(ping,100);
    };
    ping();
  });
  return bridgeReady;
}
window.agentberth={
  ready:waitForBridge,
  openSession:sessionId=>parent.postMessage({kind:'agentberth-plugin-open-session',sessionId},'*'),
  call:async(command,params={})=>{
    await waitForBridge();
    return new Promise((resolve,reject)=>{
      const id=String(++requestSequence);
      const timer=setTimeout(()=>{removeEventListener('message',listener);reject(new Error('等待插件结果超时，操作不会自动重试'))},60000);
      const listener=event=>{
        if(event.source!==parent||event.data?.kind!=='agentberth-plugin-result'||event.data.id!==id)return;
        clearTimeout(timer);removeEventListener('message',listener);
        event.data.error?reject(new Error(event.data.error)):resolve(event.data.result);
      };
      addEventListener('message',listener);
      parent.postMessage({kind:'agentberth-plugin-call',id,command,params},'*');
    });
  }
};
</script>`+html;
