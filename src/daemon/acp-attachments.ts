import { constants } from 'node:fs';
import { open, stat } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import type { z } from 'zod';
import { ACP_MEDIA_LIMIT, type AcpAttachment, type acpImageChunkSchema } from '../shared/acp-workbench';
import { MAX_TEXT_BYTES, projectFilePath } from './files';

type MediaChunk = z.infer<typeof acpImageChunkSchema>;
type Media = { mimeType: string; bytes: number; chunks: Buffer[]; completed: boolean };
type PromptBlock =
  | { type: 'text'; text: string }
  | { type: 'resource_link'; uri: string; name: string }
  | { type: 'image'|'audio'; mimeType: string; data: string }
  | { type: 'resource'; resource: {uri:string;mimeType:string;text:string} };

async function readWorkspaceText(file:string,limit:number):Promise<string>{
  const handle=await open(file,constants.O_RDONLY|constants.O_NONBLOCK);
  try{
    const info=await handle.stat();
    if(!info.isFile()||info.size>limit)throw new Error('请选择不超过 '+limit/1024+' KiB 的 UTF-8 文本文件');
    const buffer=Buffer.alloc(info.size+1);
    let length=0;
    while(length<buffer.length){
      const {bytesRead}=await handle.read(buffer,length,buffer.length-length,length);
      if(!bytesRead)break;
      length+=bytesRead;
    }
    const bytes=buffer.subarray(0,length);
    if(length!==info.size)throw new Error('读取时文件大小发生变化，请重试');
    if(!bytes.includes(0))try{return new TextDecoder('utf-8',{fatal:true}).decode(bytes);}catch{/* Report a consistent error for binary files. */}
    throw new Error('请选择 UTF-8 文本文件');
  }finally{await handle.close();}
}

export class AcpAttachments {
  private readonly uploads = new Map<string, Media>();

  add({ imageId, mimeType, offset, data, last }: MediaChunk) {
    const buffer = Buffer.from(data, 'base64');
    let image = this.uploads.get(imageId);
    if (offset === 0 && (image || this.uploads.size < 8)) {
      image = { mimeType, bytes: 0, chunks: [], completed: false };
      this.uploads.set(imageId, image);
    }
    if (!image || image.mimeType !== mimeType || image.bytes !== offset || image.completed) throw new Error('ACP 附件上传已中断，请重新添加');
    if (image.bytes + buffer.length > ACP_MEDIA_LIMIT) {
      this.uploads.delete(imageId);
      throw new Error('单个媒体附件最多 2 MiB');
    }
    image.chunks.push(buffer);
    image.bytes += buffer.length;
    if (last) {
      const bytes = Buffer.concat(image.chunks);
      const actual = bytes.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10])) ? 'image/png'
        : bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255 ? 'image/jpeg'
        : bytes.subarray(0, 4).toString() === 'RIFF' && bytes.subarray(8, 12).toString() === 'WEBP' ? 'image/webp'
        : ['GIF87a', 'GIF89a'].includes(bytes.subarray(0, 6).toString()) ? 'image/gif'
        : bytes.subarray(0, 4).toString() === 'RIFF' && bytes.subarray(8, 12).toString() === 'WAVE' ? 'audio/wav'
        : bytes.subarray(0, 4).toString() === 'OggS' ? 'audio/ogg'
        : bytes.subarray(0, 4).toString() === 'fLaC' ? 'audio/flac'
        : bytes.subarray(0, 3).toString() === 'ID3' || bytes[0] === 255 && (bytes[1] & 0xe0) === 0xe0 ? 'audio/mpeg' : '';
      if (actual !== mimeType) {
        this.uploads.delete(imageId);
        throw new Error('附件内容与文件格式不匹配');
      }
      image.completed = true;
    }
    return { offset: image.bytes };
  }

  async prompt(cwd: string, text: string, attachments: AcpAttachment[], supported: (type:string)=>boolean) {
    const prompt: PromptBlock[] = text ? [{ type: 'text', text }] : [];
    let mediaBytes = 0;
    for (const attachment of attachments) {
      if (attachment.type !== 'file') {
        if(!supported(attachment.type))throw new Error('当前 Agent 未开放此媒体输入');
        const image = this.uploads.get(attachment.id);
        if (!image?.completed || !image.mimeType.startsWith(attachment.type+'/')) throw new Error('媒体附件已失效，请重新添加');
        mediaBytes += image.bytes;
        if (mediaBytes > 4 * 1024 * 1024) throw new Error('单条消息的媒体附件合计最多 4 MiB');
        prompt.push({ type: attachment.type, mimeType: image.mimeType, data: Buffer.concat(image.chunks).toString('base64') });
      } else {
        const file = await projectFilePath(cwd, attachment.path);
        if (!(await stat(file.absolute)).isFile()) throw new Error('请选择当前工作区中的文件');
        const uri=pathToFileURL(file.absolute).href;
        const location='工作区文件 '+JSON.stringify(file.relative)+'\n绝对路径 '+JSON.stringify(file.absolute);
        let contents:string|undefined;
        if(attachment.embed)contents=await readWorkspaceText(file.absolute,MAX_TEXT_BYTES);
        else if(!attachment.text&&/(?:^|\/)SKILL\.md$/i.test(file.relative)){
          contents=await readWorkspaceText(file.absolute,MAX_TEXT_BYTES).catch(()=>undefined);
        }
        if(contents!==undefined){
          if(supported('embeddedContext')){
            const mimeType=/\.(md|markdown)$/i.test(file.relative)?'text/markdown':'text/plain';
            prompt.push({type:'resource',resource:{uri,mimeType,text:contents}});
          }else{
            prompt.push({type:'text',text:location+'\n文件正文开始\n'+contents+'\n文件正文结束'});
          }
        }else{
          prompt.push({type:'resource_link',uri,name:file.relative});
          // The structured link and its readable path are part of the same reference.
          prompt.push({type:'text',text:location+(attachment.text?'\n选择的片段\n'+attachment.text:'')});
        }
      }
    }
    return prompt;
  }

  remove(attachments: AcpAttachment[] = []) {
    for (const attachment of attachments) if (attachment.type !== 'file') this.uploads.delete(attachment.id);
  }
}
