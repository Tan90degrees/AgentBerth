import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { agentDefinitionSchema, type AgentDefinitionConfig } from '../shared/protocol';

/**
 * Wrap a legacy JSON / self-describing script definition as a normal Cordis
 * package. The original adapter stays in its installed data directory, while
 * all future enable/disable/update/uninstall operations use ExtensionRuntime.
 */
export async function stageLegacyAgentExtension(input:AgentDefinitionConfig) {
  const parsed=agentDefinitionSchema.parse(input);
  const {sourceId,...definition}=parsed;
  const identity=sourceId??parsed.plugin?.sourceId??JSON.stringify({name:parsed.name,command:parsed.command});
  const hash=createHash('sha256').update(identity).digest('hex').slice(0,24);
  const id='agent.imported.'+hash;
  const root=await mkdtemp(path.join(os.tmpdir(),'agentberth-agent-extension-'));
  const manifest={
    apiVersion:1,id,name:parsed.name+' 接入',version:'1.0.0',
    kind:'agent',description:'从旧版 Agent 配置或脚本导入；通过 Cordis 统一管理启动、历史和 Skills。',
    entry:'index.cjs',dependencies:['agents'],config:{},views:[],
  };
  try {
    await writeFile(path.join(root,'agentberth.extension.json'),JSON.stringify(manifest,null,2),'utf8');
    await writeFile(path.join(root,'index.cjs'),
      'exports.apply=(ctx)=>ctx.berth.agent('+JSON.stringify({
        id:'main',
        ...(sourceId?{legacySourceId:sourceId}:{}),
        definition,
      })+');\n','utf8');
    return {root,id,cleanup:()=>rm(root,{recursive:true,force:true})};
  }catch(error){await rm(root,{recursive:true,force:true});throw error;}
}
