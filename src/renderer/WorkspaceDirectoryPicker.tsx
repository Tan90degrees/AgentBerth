import { useEffect, useState } from 'react';
import type { WorkspaceDirectoryPage } from '../shared/workspace-server';

export function WorkspaceDirectoryPicker({ initial, onSelect, onClose }: {initial?:string;onSelect:(path:string)=>void;onClose:()=>void}){
  const [path,setPath]=useState(initial?.startsWith('/')?initial:undefined);
  const [page,setPage]=useState<WorkspaceDirectoryPage>();
  const [error,setError]=useState('');
  const [loading,setLoading]=useState(true);
  useEffect(()=>{
    let alive=true;
    setLoading(true);setError('');
    void window.berth.rpc<WorkspaceDirectoryPage>('workspaceDirectories',{path}).then(value=>{
      if(alive)setPage(value);
    }).catch(error=>{if(alive)setError(String(error));}).finally(()=>{if(alive)setLoading(false);});
    return()=>{alive=false;};
  },[path]);
  return <section className="workspace-directory-picker" aria-label="服务器目录" aria-busy={loading}>
    <header><button type="button" className="subtle" disabled={loading||!page?.parent} onClick={()=>setPath(page?.parent??undefined)}>上一级</button><code title={page?.path}>{page?.path??path??'主目录'}</code><button type="button" className="text-button" onClick={onClose}>关闭</button></header>
    {error ? <div role="status">{error} <button type="button" className="text-button" disabled={path===undefined} onClick={()=>setPath(undefined)}>返回主目录</button></div> :
      <div className="workspace-directory-list">{page?.directories.map(item=><button key={item.path} type="button" className="subtle" disabled={loading} onClick={()=>setPath(item.path)}>{item.name}</button>)}
      {!loading&&!page?.directories.length&&<span>没有子目录</span>}</div>}
    <div className="workspace-directory-footer">{page?.truncated&&<span>目录较多，可直接填写完整路径</span>}<button type="button" className="primary" disabled={loading||!page||!!error} onClick={()=>page&&onSelect(page.path)}>选择当前目录</button></div>
  </section>;
}
