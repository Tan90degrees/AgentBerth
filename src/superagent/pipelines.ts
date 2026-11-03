import type {DatabaseSync} from 'node:sqlite';
import type {SuperagentSourceEvent} from '../shared/superagent-source';

export interface SourcePolicy {enabled:boolean;projectId:string;coordinatorId:string;executorId:string;coordinatorModel?:string;executorModel?:string;allowedActors:string[];autoApprove:boolean;isolated:boolean;version:string}
export interface SourcePipeline extends SourcePolicy {id:string;name:string;sourceId:string;threadIds:string[];createdAt:string;updatedAt:string}
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
  const list=():SourcePipeline[]=>db.prepare('SELECT value FROM source_pipelines ORDER BY rowid').all().map(row=>JSON.parse(String(row.value)));
  const get=(id:string)=>list().find(item=>item.id===id);
  const overlaps=(a:string[],b:string[])=>!a.length||!b.length||a.some(value=>b.includes(value));
  function save(pipeline:SourcePipeline){
    if(pipeline.enabled){const conflict=list().find(item=>item.id!==pipeline.id&&item.enabled&&item.sourceId===pipeline.sourceId&&overlaps(item.threadIds,pipeline.threadIds)&&overlaps(item.allowedActors,pipeline.allowedActors));if(conflict)throw new Error('与管道「'+conflict.name+'」的接收范围重叠；请指定不同的来源会话 ID 或人员，避免一条请求重复开工');}
    db.prepare('INSERT INTO source_pipelines VALUES (?,?) ON CONFLICT(id) DO UPDATE SET value=excluded.value').run(pipeline.id,JSON.stringify(pipeline));return pipeline;
  }
  function match(sourceId:string,event:SuperagentSourceEvent){
    const enabled=list().filter(item=>item.sourceId===sourceId&&item.enabled);
    if(!enabled.length)throw new Error('信息源尚未绑定或已停用，请在 Superagent → 来源管道配置；插件须保留事件并用原 ID 重试');
    const threads=enabled.filter(item=>!item.threadIds.length||item.threadIds.includes(event.threadId)),matches=threads.filter(item=>!item.allowedActors.length||item.allowedActors.includes(event.actorId));
    return {pipeline:matches.length===1?matches[0]:undefined,candidate:threads.length===1?threads[0]:undefined,reason:matches.length>1?'ambiguous_pipeline':!threads.length?'no_matching_pipeline':'actor_not_allowed'};
  }
  return {list,get,save,match,delete:(id:string)=>db.prepare('DELETE FROM source_pipelines WHERE id=?').run(id)};
}
