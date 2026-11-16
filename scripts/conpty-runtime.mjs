import { copyFileSync, mkdirSync, readdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
const require=createRequire(import.meta.url);

// electron-rebuild cleans build/Release after node-pty's npm postinstall copied
// these files. Restore only the pinned package's runtime, without downloading.
export function prepareConptyRuntime(directory,platform=process.platform,arch=process.arch){
  if(platform!=='win32')return;
  if(!['x64','arm64'].includes(arch))throw new Error('Unsupported ConPTY architecture: '+arch);
  directory??=path.dirname(require.resolve('node-pty/package.json'));
  const root=path.join(directory,'third_party','conpty');
  const versions=readdirSync(root,{withFileTypes:true}).filter(entry=>entry.isDirectory()&&/^\d+\.\d+\.\d+$/.test(entry.name));
  if(versions.length!==1)throw new Error('Expected one pinned node-pty ConPTY runtime');
  const source=path.join(root,versions[0].name,'win10-'+arch),destination=path.join(directory,'build','Release','conpty');
  mkdirSync(destination,{recursive:true});
  for(const file of ['conpty.dll','OpenConsole.exe'])copyFileSync(path.join(source,file),path.join(destination,file));
}
