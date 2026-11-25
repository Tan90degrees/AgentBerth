import { useEffect, useMemo, useState } from 'react';
import type { AcpEvent } from '../shared/acp';
import type { GitDiff, GitStatus, Session } from '../shared/protocol';
import { fileChange } from '../shared/acp-presentation';
import { parseDiff } from '../shared/git-diff';
import { AsyncButton } from './AsyncButton';
import { Dialog } from './Dialog';
import { attachToAcp } from './AcpComposer';

export function AcpReview({session,events,onClose,onOpenFile,returnFocus,workspacePath}:{workspacePath?:string;session:Session;events:AcpEvent[];onClose:()=>void;onOpenFile?:(path:string,line?:number)=>void;returnFocus:HTMLElement|null}){
  const [git,setGit]=useState<GitStatus|null>(null),[error,setError]=useState(''),[source,setSource]=useState<'agent'|'git'>('agent');
  const [selected,setSelected]=useState(''),[diff,setDiff]=useState<GitDiff|null>(null),[staged,setStaged]=useState(false),[line,setLine]=useState('');
  function relativePath(value:string){
    const file=value.replaceAll('\\','/'),root=workspacePath?.replaceAll('\\','/').replace(/\/$/,'');
    const compare=(input:string)=>root&&/^[A-Za-z]:/.test(root)?input.toLowerCase():input;
    const local=root&&compare(file).startsWith(compare(root)+'/')?file.slice(root.length+1):file;
    if(local.startsWith('/')||/^[A-Za-z]:/.test(local)||local.split('/').includes('..'))return null;
    return local;
  }
  const scope={projectId:session.projectId,worktreePath:session.worktreePath??null};
  const latest=events.findLast(event=>event.kind==='user')?.turnId;
  const reported=useMemo(()=>{
    const changes=new Map<string,{path:string;oldText?:string|null;newText?:string}>();
    for(const event of events){
      if(!latest||event.turnId!==latest||event.kind!=='tool'||!Array.isArray(event.data?.content))continue;
      for(const item of event.data.content){
        if(item?.type==='diff'&&typeof item.path==='string')changes.set(item.path,item);
      }
    }
    return [...changes.values()];
  },[events,latest]);
  useEffect(()=>{
    if(source!=='git')return;
    let current=true;setError('');
    void window.berth.rpc<GitStatus>('gitStatus',scope).then(value=>{if(current)setGit(value);}).catch(error=>{if(current)setError(String(error));});
    return ()=>{current=false;};
  },[source,session.id]);
  useEffect(()=>{
    setLine('');setDiff(null);
    if(source!=='git'||!selected)return;
    let current=true;
    void window.berth.rpc<GitDiff>('gitDiff',{...scope,path:selected,staged,projectPath:false}).then(value=>{if(current)setDiff(value);}).catch(error=>{if(current)setError(String(error));});
    return ()=>{current=false;};
  },[source,selected,staged,session.id]);
  const file=reported.find(item=>item.path===selected);
  const parsed=diff?.patch?parseDiff(diff.patch):fileChange(file?.oldText,file?.newText??'');
  const rows=parsed.lines.filter(item=>item.newLine!=null||item.oldLine!=null).map(item=>({text:item.text,line:item.newLine??item.oldLine,prefix:item.kind==='add'?'+':item.kind==='remove'?'-':' '}));
  return <Dialog title="审阅改动" onClose={onClose} returnFocus={returnFocus} error={error}>
    <div className="acp-review-tabs" role="group" aria-label="改动来源">
      <button aria-pressed={source==='agent'} onClick={()=>{setSource('agent');setSelected('');setError('');}}>本轮 Agent 改动 · {reported.length}</button>
      <button aria-pressed={source==='git'} onClick={()=>{setSource('git');setSelected('');}}>工作区 Git 差异</button>
    </div>
    {source==='agent'&&!reported.length&&<p role="status">本轮没有 Agent 报告的文件改动</p>}
    {source==='git'&&git?.kind!=='repository'&&<p role="status">{git?.message??'正在读取工作区…'}</p>}
    <div className="acp-review-files">{(source==='git'?git?.files??[]:reported).map(item=><button key={item.path} aria-pressed={selected===item.path} onClick={()=>{setSelected(item.path);setError('');}}>{item.path}</button>)}</div>
    {selected&&<>
      {source==='git'?<label className="checkbox-label"><input type="checkbox" checked={staged} onChange={event=>setStaged(event.target.checked)}/>查看已暂存差异</label>:<details><summary>改动前内容</summary><pre>{file?.oldText??'新建文件'}</pre></details>}
      <div className="acp-review-lines" aria-label="改动行">{rows.slice(0,400).map((row,index)=><button key={index} type="button" aria-pressed={line===`第 ${row.line} 行：${row.text}`} onClick={()=>setLine(`第 ${row.line} 行：${row.text}`.slice(0,4000))}><code>{row.line} {row.prefix} {row.text}</code></button>)}</div>
      {source==='git'&&!diff?.patch&&<p role="status">{diff?.message??(diff?'没有差异':'正在读取差异…')}</p>}
      {(diff?.truncated||parsed.truncated||rows.length>400)&&<p role="status">仅显示部分差异，完整文件可在工作区查看</p>}
    </>}
    <footer><button type="button" className="subtle" onClick={onClose}>关闭</button>{onOpenFile&&selected&&<button type="button" onClick={()=>{onOpenFile(selected);onClose();}}>打开文件</button>}<AsyncButton className="primary" disabled={!selected} onError={setError} onAction={async()=>{const path=relativePath(selected);if(!path)throw new Error('此文件位于会话工作区之外');attachToAcp(session.id,{type:'file',path,...(line?{text:line}:{})});onClose();}}>带到输入框</AsyncButton></footer>
  </Dialog>;
}
