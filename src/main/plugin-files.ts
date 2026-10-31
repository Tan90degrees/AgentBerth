import { realpath, mkdtemp, rm, cp, copyFile } from 'node:fs/promises';
import path from 'node:path';

/** Only Cordis plugins are supported. Single-file Agent import belongs to the previous architecture. */
export async function exportPluginKit(directory:string,resourceRoot:string):Promise<string>{
  const destination=await mkdtemp(path.join(await realpath(directory),'agentberth-cordis-'));
  try{
    await copyFile(path.join(resourceRoot,'docs','CORDIS_PLUGIN_DEVELOPMENT.md'),path.join(destination,'CORDIS_PLUGIN_DEVELOPMENT.md'));
    await cp(path.join(resourceRoot,'examples','cordis-agent'),path.join(destination,'cordis-agent'),{recursive:true});
    return destination;
  }catch(error){await rm(destination,{recursive:true,force:true});throw error;}
}

export function developmentPrompt(guide:string,folder?:string):string{
  return [
    '请为 AgentBerth 编写 Cordis 插件。只接受 agentberth.extension.json + index.cjs（打包 ZIP 或开发目录）。',
    '所有 Agent（包括 Codex、Claude Code、OpenCode、自定义 Agent）均为同级插件，由 ctx.berth.agent({id,definition}) 注册；Skills 与启动、历史、恢复能力在同一插件声明。',
    '不要生成旧版 Agent JSON 配置、自描述单文件导入或独立 Agent 类型管理器，不做旧版兼容。',
    '先询问需要适配的 CLI、启动和恢复命令、原生历史能力及 Skill 的真实目录。不假设私有历史协议，不读取 TUI 屏幕伪造对话。',
    '为所有副作用提供 Cordis 清理函数，稳定保留插件 ID 和 Agent contribution ID。按指南验证启停、配置、热更新和卸载。',
    folder?'插件开发目录：'+folder:'在插件中心 → 已安装插件（或 Agent 接入）安装 ZIP 或加载开发目录。',
    guide,
  ].join('\n\n');
}
