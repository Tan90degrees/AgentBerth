import {extensionManifestSchema} from '../../shared/extensions';

export const harnessManifest=extensionManifestSchema.parse({
  apiVersion:1,id:'deepseek-harness',name:'DeepSeek Harness',version:'1.0.0',entry:'builtin',
  description:'嵌入 Harness 原生 Web 工作台，使用本机安装、配置与登录状态。',dependencies:['workspace'],
  config:{
    executable:{type:'string',title:'启动程序',default:'npx'},
    args:{type:'string',title:'启动参数（JSON 数组）',default:'["--yes","@deepseek-ai/dsh","web","--no-open","--host","127.0.0.1","--port","0"]'},
  },
  views:[{id:'web',title:'DeepSeek Harness',location:'sidebar',web:{command:'web',project:false}},{id:'guide',title:'使用说明',location:'settings',entry:'builtin'}],
});
