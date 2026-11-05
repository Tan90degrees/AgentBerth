import type {CopyOptions} from '../shared/isolated-workspaces';
import type {DatabaseSync} from 'node:sqlite';
import {pipelineFilterSchema,type PipelineFilter,type PipelineConfig,type SuperagentSourceEvent} from '../shared/superagent-source';

export interface SourcePolicy {enabled:boolean;projectId:string;coordinatorId:string;executorId:string;coordinatorModel?:string;executorModel?:string;allowedActors:string[];autoApprove:boolean;isolated:boolean;version:string}
export interface PipelineInput {sourceId:string;threadIds:string[];config?:PipelineConfig}
export interface SourcePipeline extends SourcePolicy {id:string;name:string;sourceId:string;threadIds:string[];inputs?:PipelineInput[];filter?:PipelineFilter;workspacePath?:string;workspaceBranch?:string;workspaceKind?:'git'|'copy';copyOptions?:CopyOptions;createdAt:string;updatedAt:string}
export const pipelineInputs=(pipeline:SourcePipeline):PipelineInput[]=>pipeline.inputs??[{sourceId:pipeline.sourceId,threadIds:pipeline.threadIds}];
export function matchesPipelineKeywords(filter:PipelineFilter|undefined,event:SuperagentSourceEvent){
  if(!filter)return true;
  const normalize=(value:string)=>filter.caseSensitive?value:value.toLowerCase(),text=normalize(event.title)+'\n'+normalize(event.text),contains=(word:string)=>text.includes(normalize(word));
  return !filter.excludeKeywords.some(contains)&&(!filter.includeKeywords.length||(filter.mode==='all'?filter.includeKeywords.every(contains):filter.includeKeywords.some(contains)));
}
export function pipelineStore(db:DatabaseSync){
  db.exec('CREATE TABLE IF NOT EXISTS source_pipelines(id TEXT PRIMARY KEY,value TEXT NOT NULL); CREATE TABLE IF NOT EXISTS superagent_meta(id TEXT PRIMARY KEY,value TEXT NOT NULL)');
  if(!db.prepare("SELECT id FROM superagent_meta WHERE id='pipelines-v1'").get()){
    db.exec('BEGIN IMMEDIATE');try{
      for(const row of db.prepare('SELECT id,value FROM source_policies').all()){
        const policy=JSON.parse(String(row.value)),now=new Date().toISOString(),pipeline:SourcePipeline={...policy,id:'legacy:'+row.id,name:'已有来源管道',sourceId:String(row.id),threadIds:[],createdAt:now,updatedAt:now};
        db.prepare('INSERT OR IGNORE INTO source_pipelines VALUES (?,?)').run(pipeline.id,JSON.stringify(pipeline));
      }
      db.prepare("INSERT INTO superagent_meta VALUES ('pipelines-v1','done')").run();db.exec('COMMIT');
    }catch(error){db.exec('ROLLBACK');throw error;}
  }
  const list=():SourcePipeline[]=>db.prepare('SELECT value FROM source_pipelines ORDER BY rowid').all().map(row=>{const pipeline=JSON.parse(String(row.value)) as SourcePipeline;return {...pipeline,inputs:pipelineInputs(pipeline)};});
  const get=(id:string)=>list().find(item=>item.id===id);
  function save(pipeline:SourcePipeline){
    if(pipeline.filter)pipeline={...pipeline,filter:pipelineFilterSchema.parse(pipeline.filter)};
    const previous=get(pipeline.id);if(previous?.workspacePath&&pipeline.projectId!==previous.projectId)throw new Error('管道已有工作区，不能更换项目；请新建管道');
    if(previous?.workspacePath)pipeline={...pipeline,workspacePath:previous.workspacePath,workspaceBranch:previous.workspaceBranch,workspaceKind:previous.workspaceKind};
    db.prepare('INSERT INTO source_pipelines VALUES (?,?) ON CONFLICT(id) DO UPDATE SET value=excluded.value').run(pipeline.id,JSON.stringify(pipeline));return pipeline;
  }
  function match(sourceId:string,event:SuperagentSourceEvent){
    const enabled=list().filter(item=>pipelineInputs(item).some(input=>input.sourceId===sourceId)&&item.enabled);
    if(!enabled.length)throw new Error('信息源尚未绑定或已停用，请在 Superagent → 来源管道配置；插件须保留事件并用原 ID 重试');
    const threads=enabled.filter(item=>pipelineInputs(item).some(input=>input.sourceId===sourceId&&(!input.threadIds.length||input.threadIds.includes(event.threadId)))),matches=threads.filter(item=>!item.allowedActors.length||item.allowedActors.includes(event.actorId));
    return {pipelines:matches.filter(item=>matchesPipelineKeywords(item.filter,event)),filtered:matches.filter(item=>!matchesPipelineKeywords(item.filter,event)),reason:!threads.length?'no_matching_pipeline':!matches.length?'actor_not_allowed':'keyword_filtered'};
  }
  return {list,get,save,match,clearWorkspace:(id:string)=>{const current=get(id);if(current){delete current.workspacePath;delete current.workspaceBranch;delete current.workspaceKind;db.prepare('UPDATE source_pipelines SET value=? WHERE id=?').run(JSON.stringify(current),id);}},delete:(id:string)=>db.prepare('DELETE FROM source_pipelines WHERE id=?').run(id)};
}
