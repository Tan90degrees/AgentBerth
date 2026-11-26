import { useEffect, useMemo, useState } from 'react';
import type { AcpEvent } from '../shared/acp';
import type { GitDiff, GitStatus, Session } from '../shared/protocol';
import { fileChange } from '../shared/acp-presentation';
import { parseDiff } from '../shared/git-diff';
import { AsyncButton } from './AsyncButton';
import { AcpEmpty, AcpIcon } from './AcpUi';
import { Dialog } from './Dialog';
import { attachToAcp } from './AcpComposer';

export function AcpReview({session,events,onClose,onOpenFile,returnFocus,workspacePath}:{workspacePath?:string;session:Session;events:AcpEvent[];onClose:()=>void;onOpenFile?:(path:string,line?:number)=>void;returnFocus:HTMLElement|null}){
  const [git,setGit]=useState<GitStatus|null>(null),[error,setError]=useState(''),[source,setSource]=useState<'agent'|'git'>('agent');
  const [selection,setSelection]=useState({agent:'',git:''}),[diff,setDiff]=useState<{key:string;result:GitDiff}|null>(null);
  const [gitModes,setGitModes]=useState<Record<string,boolean>>({}),[line,setLine]=useState('');
  const [gitLoading,setGitLoading]=useState(false),[diffError,setDiffError]=useState('');
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
  const files=source==='git'?git?.files??[]:reported;
  const selected=files.find(item=>item.path===selection[source])?.path??files[0]?.path??'';
  const gitFile=git?.files.find(item=>item.path===selected);
  const staged=gitModes[selected]??(!!gitFile&&gitFile.index!==' '&&gitFile.index!=='?'&&gitFile.worktree===' ');
  const diffKey=JSON.stringify([selected,staged]);
  const result=source==='git'&&diff?.key===diffKey?diff.result:null;
  const relative=selected?relativePath(selected):null;
  useEffect(()=>{
    if(source!=='git')return;
    let current=true;setError('');setGitLoading(true);
    void window.berth.rpc<GitStatus>('gitStatus',scope).then(value=>{if(current)setGit(value);})
      .catch(error=>{if(current)setError(String(error));}).finally(()=>{if(current)setGitLoading(false);});
    return ()=>{current=false;};
  },[source,session.id]);
  useEffect(()=>{
    setLine('');setDiffError('');
    if(source!=='git'||!selected)return;
    let current=true;
    setDiff(null);
    void window.berth.rpc<GitDiff>('gitDiff',{...scope,path:selected,staged,projectPath:false}).then(value=>{if(current)setDiff({key:diffKey,result:value});})
      .catch(error=>{if(current)setDiffError(String(error));});
    return ()=>{current=false;};
  },[source,selected,staged,session.id]);
  const file=source==='agent'?reported.find(item=>item.path===selected):undefined;
  const parsed=source==='git'?parseDiff(result?.patch??''):fileChange(file?.oldText,file?.newText??'');
  const rows=parsed.lines.filter(item=>item.newLine!=null||item.oldLine!=null);
  return <Dialog variant="acp-wide" title="审阅改动" onClose={onClose} returnFocus={returnFocus} error={error}>
    <div className="acp-review-tabs" role="group" aria-label="改动来源">
      <button type="button" aria-pressed={source==='agent'} onClick={()=>{setSource('agent');setError('');}}>本轮 Agent 改动 · {reported.length}</button>
      <button type="button" aria-pressed={source==='git'} onClick={()=>{setSource('git');setError('');}}>工作区 Git 差异</button>
    </div>
    <div className="acp-review-layout" key={source} data-acp-motion>
      <nav className="acp-review-files" aria-label="改动文件">
        {files.map(item=><button type="button" key={item.path} aria-pressed={selected===item.path} title={item.path} onClick={()=>setSelection(previous=>({...previous,[source]:item.path}))}><AcpIcon name="file"/><span>{relativePath(item.path)??item.path}</span></button>)}
        {!files.length&&<AcpEmpty icon="file" busy={source==='git'&&gitLoading}>{source==='agent'?'本轮没有报告文件改动':gitLoading?'正在读取工作区…':git?.message??'没有工作区改动'}</AcpEmpty>}
      </nav>
      <section className="acp-review-preview" aria-label="差异预览">
        {selected?<div key={selected} data-acp-motion>
          <header className="acp-diff-header">
            <strong title={selected}>{relative??selected}</strong>
            {source==='git'&&<div className="acp-review-tabs" role="group" aria-label="Git 差异范围">
              <button type="button" aria-pressed={!staged} onClick={()=>setGitModes(previous=>({...previous,[selected]:false}))}>未暂存</button>
              <button type="button" aria-pressed={staged} onClick={()=>setGitModes(previous=>({...previous,[selected]:true}))}>已暂存</button>
            </div>}
          </header>
          {diffError?<p role="alert" className="form-error">{diffError}</p>:!rows.length?<AcpEmpty icon="review" busy={source==='git'&&!result}>{source==='git'?result?.message??(result?'没有文本差异':'正在读取差异…'):'没有文本差异'}</AcpEmpty>:
            <div className="acp-review-lines" aria-label="改动行" key={source==='git'?diffKey:selected} data-acp-motion>
              {rows.slice(0,400).map((row,index)=>{
                const number=row.newLine??row.oldLine,title=`第 ${number} 行：${row.text}`.slice(0,4000);
                return <button key={index} type="button" data-kind={row.kind} aria-pressed={line===title} onClick={()=>setLine(value=>value===title?'':title)}><span aria-hidden="true">{number}</span><b aria-hidden="true">{row.kind==='add'?'+':row.kind==='remove'?'−':' '}</b><code>{row.text}</code></button>;
              })}
            </div>}
          {(result?.truncated||parsed.truncated||rows.length>400)&&<small className="acp-preview-limit">差异预览已截断</small>}
          {source==='agent'&&file?.oldText!=null&&<details className="acp-original-diff"><summary>查看改动前内容</summary><pre>{file.oldText}</pre></details>}
        </div>:<AcpEmpty icon="review">没有选中的文件</AcpEmpty>}
      </section>
    </div>
    <footer><button type="button" className="subtle" data-dismiss="dialog">关闭</button>{onOpenFile&&relative&&<button type="button" className="subtle" onClick={()=>{onOpenFile(relative);onClose();}}>打开文件</button>}<AsyncButton className="primary" disabled={!relative} onError={setError} onAction={async()=>{if(!relative)return;attachToAcp(session.id,{type:'file',path:relative,...(line?{text:line}:{})});onClose();}}>带到输入框</AsyncButton></footer>
  </Dialog>;
}
