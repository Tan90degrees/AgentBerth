import { methods as workspaceMethods } from '../plugins/workspace';
import { methods as agentsMethods } from '../plugins/agents';
import { methods as sshMethods } from '../plugins/ssh';
import { methods as gitMethods } from '../plugins/git';
import { methods as filesMethods } from '../plugins/files';
import { methods as resourcesMethods } from '../plugins/resources';
import { extensionManifestSchema, type ExtensionManifest } from '../shared/extensions';

// The host owns persistence, transport and the extension manager. All product
// features are ordinary Cordis plugins and can be removed and reinstalled.
export const builtinExtensions:ExtensionManifest[]=[
  {id:'workspace',name:'项目与终端',description:'项目树、会话、PTY、运行记录和退出恢复。',dependencies:[],config:{}},
  {id:'appearance',name:'外观主题',description:'深色、浅色及跟随系统的主题切换。',dependencies:[],config:{}},
  {id:'agents',name:'Agent 与 Skills',description:'Agent 类型、原生历史、恢复、自动适配和同类型的 Skills。',dependencies:['workspace'],config:{}},
  {kind:'agent',id:'agent.codex',name:'Codex 接入',description:'Codex 会话、原生历史及同一接入的 Skills。',dependencies:['agents'],config:{}},
  {kind:'agent',id:'agent.claude',name:'Claude Code 接入',description:'Claude Code 会话、原生历史、桌宠适配及 Skills。',dependencies:['agents'],config:{}},
  {kind:'agent',id:'agent.opencode',name:'OpenCode 接入',description:'OpenCode 会话、原生历史、桌宠适配及 Skills。',dependencies:['agents'],config:{}},
  {id:'ssh',name:'SSH 与 MCP',description:'独立 SSH、四工具 MCP、目录传输及独立 SSH 窗口。',dependencies:['workspace'],config:{}},
  {id:'files',name:'文件浏览与预览',description:'目录树、多文件预览、语法高亮和 Markdown。',dependencies:['workspace'],config:{}},
  {id:'git',name:'Git 管理',description:'分支、同步、暂存、提交和差异预览。',dependencies:['workspace','files'],config:{}},
  {id:'resources',name:'资源监视',description:'会话、项目和工作台的 CPU 与内存占用。',dependencies:['workspace'],config:{}},
  {id:'pet',name:'桌宠',description:'Agent 状态动画、多会话切换和自定义形象。',dependencies:['agents'],config:{}},
].map(value=>extensionManifestSchema.parse({apiVersion:1,version:'1.0.0',entry:'builtin',...value}));
const methodOwners=new Map<string,string>(Object.entries({workspace:workspaceMethods,agents:agentsMethods,ssh:sshMethods,git:gitMethods,files:filesMethods,resources:resourcesMethods}).flatMap(([id,methods])=>methods.map(method=>[method,id] as [string,string])));
export const featureForMethod=(method:string):string|undefined=>methodOwners.get(method);
