import type { RemoteCommandOutput } from '../shared/protocol';
import { openSync, closeSync, readSync, writeSync, unlinkSync } from 'node:fs';

export const COMMAND_OUTPUT_CAPACITY = 8 * 1024 * 1024;

/** A bounded command stream; production uses a private local disk ring. Cursors are opaque UTF-16 offsets;
 * readers must pass nextCursor back with the same actionId and runId. */
export class CommandOutput {
  private chunks: { start: number; text: string }[] = [];
  private end = 0;
  private fd: number | null = null;
  private failed = false;
  constructor(private capacity = COMMAND_OUTPUT_CAPACITY, private file?: string) {
    if(file)try{this.fd=openSync(file,'wx+',0o600);}catch{this.failed=true;}
  }
  dispose():void {
    if(this.fd!==null){try{closeSync(this.fd);}catch{}this.fd=null;}
    if(this.file)try{unlinkSync(this.file);}catch{}
    this.chunks=[];
  }
  private unavailable(cursor:number):RemoteCommandOutput {
    return {text:'',nextCursor:cursor,earliestCursor:null,truncated:true,hasMore:false,available:false,format:'terminal'};
  }

  append(text: string): void {
    if (!text) return;
    if(this.file){
      const end=this.end+text.length;
      if(!this.failed)try{
        const retained=text.slice(-this.capacity),buffer=Buffer.from(retained,'utf16le');
        const offset=(end-retained.length)%this.capacity*2,first=Math.min(buffer.length,this.capacity*2-offset);
        const write=(from:number,length:number,position:number)=>{let done=0;while(done<length){const count=writeSync(this.fd!,buffer,from+done,length-done,position+done);if(!count)throw new Error('Incomplete output write');done+=count;}};
        write(0,first,offset);if(first<buffer.length)write(first,buffer.length-first,0);
      }catch{this.failed=true;this.dispose();}
      this.end=end;return;
    }
    const last=this.chunks.at(-1);
    if(last&&last.text.length+text.length<=8192)last.text+=text;
    else this.chunks.push({ start: this.end, text });
    this.end += text.length;
    const floor = Math.max(0, this.end - this.capacity);
    while (this.chunks.length && this.chunks[0].start + this.chunks[0].text.length <= floor) this.chunks.shift();
    const first = this.chunks[0];
    if (first && first.start < floor) {
      let drop = floor - first.start;
      if (/[\uDC00-\uDFFF]/.test(first.text[drop] ?? '')) drop++;
      first.text = first.text.slice(drop); first.start += drop;
    }
  }

  read(cursor: number, maxChars: number): RemoteCommandOutput {
    if (cursor > this.end) throw new Error('输出游标超出当前命令，请使用此 actionId 返回的 nextCursor');
    if(this.file){
      if(this.failed)return this.unavailable(cursor);
      let earliestCursor=Math.max(0,this.end-this.capacity);
      const read=(start:number,length:number)=>{
        const buffer=Buffer.alloc(length*2),offset=start%this.capacity*2,first=Math.min(buffer.length,this.capacity*2-offset);
        const part=(from:number,length:number,position:number)=>{let done=0;while(done<length){const count=readSync(this.fd!,buffer,from+done,length-done,position+done);if(!count)throw new Error('Incomplete output read');done+=count;}};
        part(0,first,offset);if(first<buffer.length)part(first,buffer.length-first,0);return buffer.toString('utf16le');
      };
      try{
        // Ring wrap must never expose half a Unicode scalar.
        if(earliestCursor<this.end&&/[\uDC00-\uDFFF]/.test(read(earliestCursor,1)))earliestCursor++;
        const start=Math.max(cursor,earliestCursor);
        let text=read(start,Math.min(maxChars,this.end-start));
        if(/[\uDC00-\uDFFF]/.test(text[0]??''))throw new Error('输出游标无效，请原样使用 nextCursor');
        if(/[\uD800-\uDBFF]/.test(text.at(-1)??''))text=text.slice(0,-1);
        const nextCursor=start+text.length;
        return {text,nextCursor,earliestCursor,truncated:cursor<earliestCursor,hasMore:nextCursor<this.end,available:true,format:'terminal'};
      }catch(error){if(String(error).includes('游标'))throw error;this.failed=true;this.dispose();return this.unavailable(cursor);}
    }
    const earliestCursor = this.chunks[0]?.start ?? this.end;
    const start = Math.max(cursor, earliestCursor);
    let text = '';
    for (const chunk of this.chunks) {
      if (chunk.start + chunk.text.length <= start) continue;
      text += chunk.text.slice(Math.max(0, start - chunk.start), Math.max(0, start - chunk.start) + maxChars - text.length);
      if (text.length >= maxChars) break;
    }
    // Do not split a Unicode scalar at a response boundary.
    if (/[\uD800-\uDBFF]/.test(text.at(-1) ?? '')) text = text.slice(0,-1);
    if (/[\uDC00-\uDFFF]/.test(text[0] ?? '')) throw new Error('输出游标无效，请原样使用 nextCursor');
    const nextCursor = start + text.length;
    return { text, nextCursor, earliestCursor, truncated: cursor < earliestCursor, hasMore: nextCursor < this.end, available: true, format: 'terminal' };
  }
}
