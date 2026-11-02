import { extensionManifestSchema, type ExtensionManifest } from '../shared/extensions';

// The workbench itself is not a plugin. Only optional providers and additive
// extensions are managed by Cordis. Core services are mounted by DaemonServer.
export const builtinExtensions:ExtensionManifest[]=[
  {kind:'agent',id:'agent.codex',name:'Codex',description:'Codex CLI 接入、原生会话历史与 Skills。',dependencies:[],config:{}},
  {kind:'agent',id:'agent.claude',name:'Claude Code',description:'Claude Code 接入、原生会话历史与 Skills。',dependencies:[],config:{}},
  {kind:'agent',id:'agent.opencode',name:'OpenCode',description:'OpenCode 接入、原生会话历史与 Skills。',dependencies:[],config:{}},
  {id:'pet',name:'桌宠',description:'Agent 状态动画、多会话切换和自定义形象。',dependencies:[],config:{}},
].map(value=>extensionManifestSchema.parse({apiVersion:1,version:'1.0.0',entry:'builtin',...value}));
