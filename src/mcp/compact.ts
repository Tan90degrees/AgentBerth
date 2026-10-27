/** Compact metadata only: output budgets and actual terminal text are unchanged. */
export function compactReply(value:any):any {
  if(!value||typeof value!=='object'||!value.scope)return value;
  const pick=(source:any,keys:string[])=>Object.fromEntries(keys.filter(key=>source[key]!==undefined).map(key=>[key,source[key]]));
  const info=value.info?pick(value.info,['connection','owner','phase','cwd','commandTracking',...(value.info.error?['error']:[])]):undefined;
  if(value.scope==='command')return {...pick(value,['scope','id','sessionId','runId','status','exitCode','elapsedMs','requestMs','fromCursor','allOutputInThisResponse','output','harness']),...(info?{info}:{}),...((value.output?.search||value.output?.mode==='page')&&value.details?{details:value.details}:{})};
  return {...pick(value,['scope','text','cursor','cols','rows','command','harness']),...(info?{info}:{})};
}
