import { spawn } from 'node:child_process';
import { generateKeyPairSync } from 'node:crypto';
import { once } from 'node:events';
import { connect } from 'node:net';
import ssh2 from 'ssh2';

export const testPassword='agentberth-fixture-password';
export const testUsername='agentberth-fixture-user';

export function generateSshKeys() {
  return generateKeyPairSync('rsa',{
    modulusLength:2048,publicKeyEncoding:{type:'pkcs1',format:'pem'},privateKeyEncoding:{type:'pkcs1',format:'pem'},
  });
}

export async function workspaceSshFixture(home,{hostKey,publicKey,remotePath=process.env.PATH}={}) {
  const clients=new Set();
  const server=new ssh2.Server({hostKeys:[hostKey??generateSshKeys().privateKey]});
  function pipeProcess(stream,program,args,withExit) {
    const child=spawn(program,args,{cwd:home,env:{...process.env,HOME:home,PATH:remotePath,XDG_RUNTIME_DIR:'',DBUS_SESSION_BUS_ADDRESS:''}});
    stream.pipe(child.stdin);
    child.stdout.pipe(stream,{end:false});
    child.stderr.pipe(stream.stderr,{end:false});
    child.stdin.on('error',()=>{});
    child.on('close',code=>{if(withExit)stream.exit(code??1);stream.end();});
    stream.on('close',()=>{if(child.exitCode===null)child.kill();});
  }
  server.on('connection',client=>{
    clients.add(client);
    client.on('error',()=>{});
    client.on('close',()=>clients.delete(client));
    client.on('authentication',ctx=>{
      if(ctx.username!==testUsername)return ctx.reject(['password','publickey']);
      if(ctx.method==='password'&&ctx.password===testPassword)return ctx.accept();
      if(ctx.method==='publickey'&&publicKey&&ctx.key.data.equals(publicKey.getPublicSSH())&&
        (!ctx.signature||publicKey.verify(ctx.blob,ctx.signature,ctx.hashAlgo)===true))return ctx.accept();
      ctx.reject(['password','publickey']);
    });
    client.on('ready',()=>{
      client.on('session',accept=>{
        const session=accept();
        session.on('exec',(accept,reject,{command})=>{
          if(command!=='sh -s')return reject();
          pipeProcess(accept(),'/bin/sh',['-s'],true);
        });
        session.on('subsystem',(accept,reject,{name})=>{
          if(name!=='sftp')return reject();
          pipeProcess(accept(),'/usr/lib/openssh/sftp-server',['-d',home],false);
        });
      });
      client.on('tcpip',(accept,reject,{destIP,destPort})=>{
        if(destIP!=='127.0.0.1')return reject();
        const socket=connect(destPort,destIP);
        socket.once('error',reject);
        socket.once('connect',()=>{
          socket.removeListener('error',reject);
          const stream=accept();
          socket.on('error',()=>stream.destroy());
          stream.on('error',()=>socket.destroy());
          stream.on('close',()=>socket.destroy());
          socket.on('close',()=>stream.end());
          stream.pipe(socket).pipe(stream);
        });
      });
    });
  });
  server.listen(0,'127.0.0.1');
  await once(server,'listening');
  return {
    port:server.address().port,
    close:async()=>{
      for(const client of clients)client.end();
      await new Promise(resolve=>server.close(resolve));
    },
  };
}
