import { historyNotices } from './history-notices';

export function HistoryDiagnostics({path,warnings}:{path?:string|null;warnings:readonly string[]}) {
  const notices=historyNotices(warnings);
  if(!path&&!notices.length)return null;
  const hints=[notices.some(item=>item.kind==='partial')?'部分记录未显示':'',notices.some(item=>item.kind==='selection')?'检测到多条会话，请确认会话 ID':''].filter(Boolean);
  return <details className="history-diagnostics" aria-label="读取详情">
    <summary>读取详情<span>{hints.join(' · ')||(notices.length?`${notices.length} 项提示`:'来源文件')}</span></summary>
    <div className="history-diagnostics-content">
      {path&&<div className="history-diagnostic-path"><span>来源文件</span><code>{path}</code></div>}
      {notices.map(item=><p key={item.original} title={item.text!==item.original?item.original:undefined}>{item.text}{item.count>1&&<small>（重复 {item.count} 次）</small>}</p>)}
    </div>
  </details>;
}
