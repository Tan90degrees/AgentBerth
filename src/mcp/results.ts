import type { OutputSearch, RemoteCommandResult } from '../shared/protocol';

type ReadCall = { tool: 'terminal_read_output'; arguments: { sessionId:string;runId:string;actionId:string;cursor:number;timeoutMs:number;mode:'summary'|'page';maxChars?:number;search?:OutputSearch } };
const readCall=(sessionId:string,runId:string,actionId:string,cursor:number,timeoutMs:number,mode:'summary'|'page',maxChars?:number):ReadCall=>({tool:'terminal_read_output',arguments:{sessionId,runId,actionId,cursor,timeoutMs,mode,...(maxChars===undefined?{}:{maxChars})}});

/** Capturing output locally never implies loading it all into model context. */
export function commandReply(value:RemoteCommandResult,cursor=0,maxChars?:number) {
  const {output}=value,mode=output.mode??'page';
  if(output.search){
    const s=output.search,details=s.nextOffset===null?null:readCall(value.sessionId,value.runId,value.id,s.startCursor,0,'summary');
    if(details)details.arguments.search={query:s.query,caseSensitive:s.caseSensitive,contextLines:s.contextLines,maxBytes:s.maxBytes,limit:s.limit,offset:s.nextOffset!,endCursor:s.endCursor};
    return {...value,scope:'command' as const,fromCursor:cursor,allOutputInThisResponse:false,continuation:null,details,notice:output.cacheLost?'查询仅覆盖仍保留的缓存。':''};
  }
  const lost=!output.available||(output.cacheLost??(output.truncated&&!output.omitted));
  const continuation=output.available&&value.status==='running'?readCall(value.sessionId,value.runId,value.id,output.nextCursor,output.hasMore?0:25000,mode,mode==='page'?maxChars:undefined):null;
  // An optional pointer is not an instruction to drain the local cache.
  const details=output.available&&(output.omitted||output.hasMore)?readCall(value.sessionId,value.runId,value.id,mode==='page'?output.nextCursor:cursor,0,'page',maxChars):null;
  const allOutputInThisResponse=value.status==='completed'&&cursor===0&&!lost&&!output.omitted&&!output.hasMore;
  const notice=lost?'命令输出缓存已丢失或部分淘汰，不能宣称结果完整，也不要自动重跑命令。'
    :output.omitted?'输出已按字节或行数预算保留首尾，省略中间内容；这是有界结果，不是滚屏丢失。通常直接使用此结果，不要自动读完分页或重跑命令；只有任务确需细节时才使用 details。'
    :output.hasMore?'这是显式请求的明细分页。仅在任务确实需要后续细节时使用 details，不要为了完整性自动读完所有分页，也不要重跑命令。'
    :value.status==='running'?'命令尚未结束；需要继续等待时使用 continuation，只读取新增有界输出，不重复此前内容。'
    :value.status==='unknown'?'命令最终结果未知；以上仅为已捕获输出，不能据此宣称完成或自动重跑。'
    :cursor>0?'已到本轮输出末尾；当前响应只覆盖指定游标之后的范围，不自动读取此前内容。'
    :'以上是本轮命令的已捕获输出，无需再次读屏或重跑。';
  return {scope:'command' as const,fromCursor:cursor,allOutputInThisResponse,continuation,details,notice,...value};
}

export function screenReply(value:Record<string,any>) {
  const command=value.command;
  return {scope:'viewport' as const,allOutputInThisResponse:false,
    continuation:null,
    details:command?readCall(command.sessionId,command.runId,command.id,0,0,'summary'):null,
    notice:command?'这只是终端可见画面，滚屏不等于命令输出丢失。普通命令优先使用已经返回的有界结果；仅确需结果时使用 details 读取首尾摘要，不自动恢复全部输出，也不重新执行命令。'
      :'这只是终端可见画面，没有可靠的命令记录；不要据此断言结果完整或丢失，也不要自动重跑。',...value};
}
