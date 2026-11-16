import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync,mkdirSync,writeFileSync,readFileSync,rmSync,existsSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { prepareConptyRuntime } from '../scripts/conpty-runtime.mjs';

test('ConPTY runtime is restored after native rebuild cleanup, including ARM64 and overwritten stale copies',t=>{
 const root=mkdtempSync(path.join(os.tmpdir(),'berth-conpty-'));t.after(()=>rmSync(root,{recursive:true,force:true}));
 for(const arch of ['x64','arm64']){
  const source=path.join(root,'third_party/conpty/1.23.251008001/win10-'+arch);mkdirSync(source,{recursive:true});
  for(const file of ['conpty.dll','OpenConsole.exe'])writeFileSync(path.join(source,file),arch+'-'+file);
  prepareConptyRuntime(root,'win32',arch);
  for(const file of ['conpty.dll','OpenConsole.exe'])assert.equal(readFileSync(path.join(root,'build/Release/conpty',file),'utf8'),arch+'-'+file);
  rmSync(path.join(root,'build/Release'),{recursive:true});prepareConptyRuntime(root,'win32',arch);
  assert.equal(readFileSync(path.join(root,'build/Release/conpty/conpty.dll'),'utf8'),arch+'-conpty.dll');
 }
});
test('non-Windows does not touch dependencies; missing or ambiguous Windows runtimes fail preflight',t=>{
 const root=mkdtempSync(path.join(os.tmpdir(),'berth-conpty-'));t.after(()=>rmSync(root,{recursive:true,force:true}));
 prepareConptyRuntime(root,'linux');assert.equal(existsSync(path.join(root,'build')),false);
 assert.throws(()=>prepareConptyRuntime(root,'win32','ia32'),/architecture/);
 assert.throws(()=>prepareConptyRuntime(root,'win32','x64'),/ENOENT/);
 mkdirSync(path.join(root,'third_party/conpty/1.23.1'),{recursive:true});mkdirSync(path.join(root,'third_party/conpty/1.23.2'),{recursive:true});
 assert.throws(()=>prepareConptyRuntime(root,'win32','x64'),/one pinned/);
 rmSync(path.join(root,'third_party/conpty/1.23.2'),{recursive:true});
 assert.throws(()=>prepareConptyRuntime(root,'win32','x64'),/ENOENT/);
});
