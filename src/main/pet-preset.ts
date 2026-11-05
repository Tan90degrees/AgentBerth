import {createHash} from 'node:crypto';
import {mkdirSync,readFileSync,writeFileSync,renameSync,rmSync,statSync} from 'node:fs';
import path from 'node:path';

export const naiwaSource={
  repository:'timerring/codex-pet-naiwa',commit:'3c0cd7ca231f02e0d4d6956fc6ce86eb9f0cfb50',
  asset:'naifrog/spritesheet.webp',sha256:'e86e8b61584df7897ef7a60c3ba6a8dd92a798b3a5bdba5080351a896927f588',
};
type Source=typeof naiwaSource;
type Fetcher=(url:string,init:{signal:AbortSignal})=>Promise<Response>;
const MAX_ATLAS_BYTES=2*1024*1024;

async function bounded(response:Response,max:number){
  if(!response.ok)throw new Error('HTTP '+response.status);
  if(Number(response.headers.get('content-length'))>max){await response.body?.cancel();throw new Error('素材超过大小限制');}
  if(!response.body)throw new Error('素材响应为空');
  const reader=response.body.getReader(),chunks:Uint8Array[]=[];let size=0;
  try{for(;;){const {done,value}=await reader.read();if(done)break;size+=value.byteLength;if(size>max)throw new Error('素材超过大小限制');chunks.push(value);}return Buffer.concat(chunks);}
  catch(error){await reader.cancel().catch(()=>{});throw error;}finally{reader.releaseLock();}
}

/** Download only after an explicit selection. Never execute upstream code. */
export class NaiwaPreset {
  private data:string|null=null;
  private operation:Promise<void>|null=null;
  constructor(private folder:string,private source:Source=naiwaSource){
    try{const file=path.join(folder,'spritesheet.webp');if(statSync(file).size>MAX_ATLAS_BYTES)return;const bytes=readFileSync(file);this.validate(bytes);this.data='data:image/webp;base64,'+bytes.toString('base64');}catch{/* Missing/corrupt cache remains available for explicit repair. */}
  }
  get ready(){return !!this.data;}
  image(){return this.data;}
  private validate(bytes:Buffer){
    if(bytes.length>MAX_ATLAS_BYTES||bytes.toString('ascii',0,4)!=='RIFF'||bytes.toString('ascii',8,12)!=='WEBP'||createHash('sha256').update(bytes).digest('hex')!==this.source.sha256)throw new Error('奶蛙图集校验失败，请重试下载');
  }
  install(fetcher:Fetcher=fetch):Promise<void>{
    if(this.ready)return Promise.resolve();if(this.operation)return this.operation;
    this.operation=this.download(fetcher).finally(()=>{this.operation=null;});return this.operation;
  }
  private async download(fetcher:Fetcher){
    const controller=new AbortController(),signal=AbortSignal.any([controller.signal,AbortSignal.timeout(30000)]),base='https://raw.githubusercontent.com/'+this.source.repository+'/'+this.source.commit+'/';
    const temporary=path.join(this.folder,'spritesheet.webp.tmp');
    try{
      const [image,license,readme]=await Promise.all([this.source.asset,'LICENSE','README.md'].map(async(file,index)=>bounded(await fetcher(base+file,{signal}),index===0?MAX_ATLAS_BYTES:64*1024)));
      this.validate(image);mkdirSync(this.folder,{recursive:true,mode:0o700});
      // The atlas is the commit marker: a failed download leaves the selected
      // appearance, custom GIFs and any previously installed files untouched.
      writeFileSync(path.join(this.folder,'LICENSE'),license,{mode:0o600});writeFileSync(path.join(this.folder,'README.md'),readme,{mode:0o600});
      writeFileSync(path.join(this.folder,'source.json'),JSON.stringify(this.source,null,2),{mode:0o600});
      writeFileSync(temporary,image,{mode:0o600});renameSync(temporary,path.join(this.folder,'spritesheet.webp'));
      this.data='data:image/webp;base64,'+image.toString('base64');
    }catch(error){throw new Error('奶蛙素材下载未完成：'+(error instanceof Error?error.message:String(error)));}
    finally{controller.abort();rmSync(temporary,{force:true});}
  }
}
