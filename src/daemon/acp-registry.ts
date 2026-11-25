import path from 'node:path';
import { installAcpBinary, type AcpBinaryRecipe } from './acp-registry-binary';
import { validSourcePath } from '../wiki/source-directory';
import { acpCommand } from './acp-transport';
import type { AcpConfig } from '../shared/acp';

const catalog = 'https://cdn.agentclientprotocol.com/registry/v1/latest/registry.json';
const idPattern = /^[a-z0-9][a-z0-9._-]{0,99}$/;
const versionPattern = /^[0-9][0-9A-Za-z.+!-]{0,79}$/;
const npmPattern = /^(?:@[a-z0-9_.-]+\/)?[a-z0-9_.-]+$/;
const target=[{win32:'windows',darwin:'darwin',linux:'linux'}[process.platform as 'win32'|'darwin'|'linux'],{x64:'x86_64',arm64:'aarch64'}[process.arch as 'x64'|'arm64']].join('-');
const pythonPattern = /^[A-Za-z0-9][A-Za-z0-9_.-]*$/;

export interface RegistryAgent {
  id: string; name: string; version: string; description: string; config?: AcpConfig; binary?: AcpBinaryRecipe;
}

let cached: { expires: number; agents: RegistryAgent[] } | undefined;
let request: Promise<RegistryAgent[]> | undefined;

export function readAcpRegistry(): Promise<RegistryAgent[]> {
  if (cached && cached.expires > Date.now()) return Promise.resolve(cached.agents);
  return request ??= (async () => {
    const response = await fetch(catalog, { signal: AbortSignal.timeout(10000), redirect: 'error' });
    if (!response.ok || !response.body) throw new Error('ACP Registry 暂不可用，请重试');
    const chunks: Uint8Array[] = [];
    let length = 0;
    const reader = response.body.getReader();
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        length += value.byteLength;
        if (length > 2 * 1024 * 1024) throw new Error('ACP Registry 目录过大');
        chunks.push(value);
      }
    } finally { await reader.cancel().catch(() => {}); }
    const json = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (!Array.isArray(json.agents)) throw new Error('ACP Registry 返回了无效的目录');
    const agents = json.agents.slice(0, 300).flatMap((entry: any): RegistryAgent[] => {
      if (typeof entry?.id !== 'string' || !idPattern.test(entry.id) || typeof entry.name !== 'string' || !entry.name.trim() ||
          typeof entry.version !== 'string' || !versionPattern.test(entry.version)) return [];
      const recipe = entry.distribution?.npx ?? entry.distribution?.uvx;
      const npm = !!entry.distribution?.npx;
      const args = recipe?.args ?? [];
      const spec = recipe?.package;
      const pin = (npm||typeof spec==='string'&&spec.endsWith('@'+entry.version) ? '@' : '==') + entry.version;
      const name = typeof spec === 'string' && spec.endsWith(pin) ? spec.slice(0, -pin.length) : '';
      const config = (npm ? npmPattern : pythonPattern).test(name) && !name.startsWith('-') &&
        Array.isArray(args) && args.length <= 24 && args.every(arg => typeof arg === 'string' && arg.length <= 1024 && !/[\x00-\x1f]/.test(arg))
        ? { executable: npm ? 'npx' : 'uvx', args: [...(npm ? ['--yes', '--'] : []), spec, ...args],
            env: Object.fromEntries(Object.entries(recipe.env ?? {}).filter(([key, value]) =>
              /^[A-Za-z][A-Za-z0-9_]{0,79}$/.test(key) && !/^(PATH|NODE_|NPM_|PYTHON|UV_|LD_|DYLD_|COMSPEC|SYSTEMROOT)/i.test(key) &&
              typeof value === 'string' && value.length <= 1024 && !/[\x00-\x1f]/.test(value))) as Record<string,string>,
            registryId: entry.id, registryVersion: entry.version } : undefined;
      const binary=config?undefined:binaryRecipe(entry.distribution?.binary?.[target]);
      return [{ id: entry.id, name: entry.name.trim().slice(0, 100), version: entry.version, description: String(entry.description ?? '').slice(0, 350), config, binary }];
    });
    cached = { expires: Date.now() + 5 * 60_000, agents };
    return agents;
  })().finally(() => { request = undefined; });
}

export async function discoverAcpAgents() {
  const candidates = [
    { name: 'OpenCode', executable: 'opencode', args: ['acp'] },
    { name: 'Pi (ACP)', executable: 'openma-pi-acp', args: [] },
    { name: 'Claude (ACP)', executable: 'claude-agent-acp', args: [] },
    { name: 'Codex (ACP)', executable: 'codex-acp', args: [] },
    { name: 'Gemini CLI', executable: 'gemini', args: ['--experimental-acp'] },
    { name: 'Qwen Code', executable: 'qwen', args: ['--acp'] },
  ];
  return (await Promise.all(candidates.map(async entry => {
    try { await acpCommand(entry.executable, entry.args); return entry; } catch { return null; }
  }))).filter(entry => entry !== null);
}

function binaryRecipe(value:any):AcpBinaryRecipe|undefined{
  if(typeof value?.archive!=='string'||typeof value.cmd!=='string'||typeof value.sha256!=='string'||!/^[a-f0-9]{64}$/i.test(value.sha256))return;
  const command=value.cmd.replaceAll('\\','/').replace(/^\.\//,'');
  if(!validSourcePath(command))return;
  let url:URL;
  try{url=new URL(value.archive);}catch{return;}
  if(url.protocol!=='https:'||url.username||url.password)return;
  const args=value.args??[];
  if(!Array.isArray(args)||args.length>24||args.some(arg=>typeof arg!=='string'||arg.length>1024||/[\x00-\x1f]/.test(arg)))return;
  const pathname=url.pathname.toLowerCase();
  const kind=pathname.endsWith('.zip')?'zip':/\.(tar\.gz|tgz)$/.test(pathname)?'tar.gz':/\.(bz2|tbz2|dmg|pkg|deb|rpm|msi|appimage|xz|7z|tar)$/.test(pathname)?undefined:'raw';
  if(!kind)return;
  return {url:url.href,sha256:value.sha256,command,args,kind};
}

export async function prepareAcpRegistryAgent(id:string,version:string,root:string):Promise<AcpConfig>{
  const entry=(await readAcpRegistry()).find(item=>item.id===id&&item.version===version);
  if(entry?.config)return entry.config;
  if(!entry?.binary)throw new Error('此版本当前没有适用的 ACP 安装包');
  const executable=await installAcpBinary(path.join(root,'acp-registry'),entry.binary);
  return {executable,args:entry.binary.args,env:{},registryId:id,registryVersion:version};
}
