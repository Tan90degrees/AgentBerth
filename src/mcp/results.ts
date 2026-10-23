import type { RemoteCommandResult } from '../shared/protocol';

type ReadCall = { tool: 'terminal_read_output'; arguments: { sessionId:string;runId:string;actionId:string;cursor:number;timeoutMs:number;maxChars?:number } };
const readCall=(sessionId:string,runId:string,actionId:string,cursor:number,timeoutMs:number,maxChars?:number):ReadCall=>({tool:'terminal_read_output',arguments:{sessionId,runId,actionId,cursor,timeoutMs,...(maxChars===undefined?{}:{maxChars})}});

/** Machine-readable coverage plus the exact next call, alongside the existing
 * result. A short viewport and a paginated command must never look equivalent. */
export function commandReply(value:RemoteCommandResult,cursor=0,maxChars?:number) {
  const {output}=value;
  const lost=!output.available||output.truncated;
  const continuation=output.available&&(output.hasMore||value.status==='running')?readCall(value.sessionId,value.runId,value.id,output.nextCursor,output.hasMore?0:25000,maxChars):null;
  const allOutputInThisResponse=value.status==='completed'&&cursor===0&&!lost&&!output.hasMore;
  const notice=lost?'命令输出缓存已丢失或部分淘汰，不能宣称结果完整，也不要自动重跑命令。'
    :output.hasMore?'本轮命令输出还有后续分页，内容未因滚屏丢失。请使用 continuation 读取同一命令，勿重新执行或 clear。'
    :value.status==='running'?'本轮命令尚未结束。请使用 continuation 等待新增输出，勿以当前画面或首段输出作为完整结果。'
    :value.status==='unknown'?'命令最终结果未知；以上仅为已捕获输出，不能据此宣称完成或自动重跑。'
    :cursor>0?'已到本轮输出末尾；请与之前读取的各页合并，不要只用当前页作为完整结果。'
    :'以上是本轮命令的完整已捕获输出，不受终端可见行数影响；无需再次读屏或重跑。';
  return {...value,scope:'command' as const,fromCursor:cursor,allOutputInThisResponse,continuation,notice};
}

export function screenReply(value:Record<string,any>) {
  const command=value.command;
  return {...value,scope:'viewport' as const,allOutputInThisResponse:false,
    continuation:command?readCall(command.sessionId,command.runId,command.id,0,0):null,
    notice:command?'这只是当前终端可见画面，不是命令的完整输出。滚出视口不等于结果丢失；请使用 continuation 从头读取已捕获的本轮结果，不要重新运行命令。'
      :'这只是当前终端可见画面，没有可可靠关联的命令记录；不能据此断言结果完整或丢失。不要自动重跑。普通 Shell 命令请使用 terminal_execute 记录输出。'};
}
