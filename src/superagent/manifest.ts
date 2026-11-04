import { extensionManifestSchema } from '../shared/extensions';

export const superagentManifest=extensionManifestSchema.parse({apiVersion:1,version:'1.0.0',entry:'builtin',...{id:'superagent',name:'Superagent',description:'通过 ACP Agent 协调与执行任务，按管道隔离工作区并管理审批。',dependencies:['agents','acp','worktrees'],config:{maxConcurrent:{type:'number',title:'并行任务数',default:2,minimum:1,maximum:4},rules:{type:'string',title:'任务规则（最多 4000 字）',default:'仅在请求范围内工作。不得自动推送、合并或向外部渠道发送消息。'}},views:[{id:'tasks',title:'Superagent',location:'sidebar',entry:'builtin'}]}});
