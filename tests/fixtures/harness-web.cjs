const http=require('node:http'),fs=require('node:fs');
const token='fixture-private-token';
fs.appendFileSync(process.argv[2],JSON.stringify({pid:process.pid,cwd:process.cwd(),args:process.argv.slice(3)})+'\n');
const server=http.createServer((req,res)=>{
  const url=new URL(req.url,'http://localhost');
  if(url.searchParams.get('token')===token){res.writeHead(302,{'Set-Cookie':'harness='+token+'; HttpOnly; SameSite=Strict; Path=/','Location':'/'});res.end();return;}
  if(!req.headers.cookie?.includes('harness='+token)){res.writeHead(401);res.end('Authentication required');return;}
  res.writeHead(200,{'Content-Type':'text/html; charset=utf-8','X-Frame-Options':'DENY','Content-Security-Policy':"frame-ancestors 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'"});
  res.end('<!doctype html><html lang="zh-CN"><title>Harness Native Fixture</title><style>body{background:#191919;color:#eee;font:16px system-ui;padding:28px}input,button{font:inherit;padding:8px}</style><h1>Harness Native</h1><p id="isolation"></p><input aria-label="原生输入"><button onclick="document.getElementById(\'result\').textContent=document.querySelector(\'input\').value">发送</button><p id="result"></p><script>document.getElementById("isolation").textContent=typeof window.berth+"/"+typeof require+"/"+typeof process;</script></html>');
});
server.listen(0,'127.0.0.1',()=>{
  const url='http://127.0.0.1:'+server.address().port+'/?token='+token;
  process.stdout.write('dsh web: '+url.slice(0,-8));
  process.stderr.write('fixture startup diagnostics\n');
  setTimeout(()=>process.stdout.write(url.slice(-8)+'\n'),20);
});
