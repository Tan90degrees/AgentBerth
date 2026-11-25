import {useEffect,useState} from 'react';

interface Props {sessionId:string;mediaId:string;mimeType:string;type:string;uri?:string}
type Chunk={mimeType:string;total:number;data:string};
type Download={url:string;mimeType:string;kind:'image'|'audio'|'text'|'file';text?:string};

export function AcpMediaView({sessionId,mediaId,mimeType,type,uri}:Props){
  const preview=/^image\/(png|jpeg|webp|gif)$/i.test(mimeType)&&type==='image'?'image'
    :/^audio\/(wav|mpeg|mp3|ogg|mp4|webm|flac)$/i.test(mimeType)&&type==='audio'?'audio'
    :mimeType==='text/plain'?'text':'file';
  const [requested,setRequested]=useState(preview==='image'||preview==='audio'),[result,setResult]=useState<Download>(),[error,setError]=useState('');
  useEffect(()=>{
    if(!requested)return;
    let active=true,objectUrl:string|undefined;
    setError('');setResult(undefined);
    const load=async()=>{
      const chunks:ArrayBuffer[]=[];
      let offset=0,total=0;
      do{
        const chunk=await window.berth.rpc<Chunk>('acpMedia',{sessionId,mediaId,offset});
        if(!active)return;
        if(!chunk.data||chunk.mimeType!==mimeType||chunk.total>8*1024*1024||offset>0&&total!==chunk.total)throw new Error('附件数据已变化');
        const data=atob(chunk.data),bytes=new Uint8Array(data.length);
        for(let index=0;index<data.length;index++)bytes[index]=data.charCodeAt(index);
        chunks.push(bytes.buffer);offset+=chunk.data.length;total=chunk.total;
      }while(offset<total);
      const blob=new Blob(chunks,{type:preview==='file'?'application/octet-stream':mimeType});
      const text=preview==='text'?await blob.text():undefined;
      if(!active)return;
      objectUrl=URL.createObjectURL(blob);
      setResult({url:objectUrl,mimeType,kind:preview,text});
    };
    void load().catch(error=>{if(active)setError(String(error));});
    return()=>{active=false;if(objectUrl)URL.revokeObjectURL(objectUrl);};
  },[mediaId,mimeType,preview,requested,sessionId]);
  const basename=(uri?.split(/[\\/]/).at(-1)||'Agent 附件').replace(/[?#].*$/,'').replace(/[<>:"|?*\x00-\x1f]/g,'_').slice(0,150);
  return <div className="acp-media">
    {error?<span role="status">{error}</span>:result?.kind==='image'?<img className="acp-content-image" src={result.url} alt="Agent 返回的图片"/>
      :result?.kind==='audio'?<audio className="acp-content-audio" src={result.url} controls preload="metadata"/>
      :result?.kind==='text'?<pre>{result.text}</pre>
      :!requested?<button type="button" className="conversation-action" onClick={()=>setRequested(true)}>{preview==='text'?'预览文本':'读取附件'}{uri?' · '+basename:''}</button>
      :!result?<span role="status">正在读取附件…</span>:null}
    {result&&<a className="conversation-action" href={result.url} download={basename}>保存附件</a>}
  </div>;
}
