import { StringDecoder } from 'node:string_decoder';

// Same byte/line/tail defaults as ssh-skill's BoundedText.
// The local full-output cache is independent of this model-facing view.
export const OUTPUT_PREVIEW_BYTES=256*1024;
export const OUTPUT_PREVIEW_LINES=4000;
export const OUTPUT_TAIL_BYTES=64*1024;
export interface TextPreview {text:string;omitted:boolean;totalBytes:number;totalLines:number;returnedBytes:number}
function decode(bytes:Buffer):string {
  let start=0;while(start<bytes.length&&(bytes[start]&0xc0)===0x80)start++;
  return new StringDecoder('utf8').write(bytes.subarray(start));
}
const lines=(text:string)=>text.match(/[^\n]*\n|[^\n]+$/g)??[];

/** Tracks exact totals while retaining bounded bytes, never the whole stream. */
export class BoundedText {
  private head=Buffer.alloc(0);
  private tail=Buffer.alloc(0);
  private bytes=0;
  private newlines=0;
  private last='';
  constructor(private maxBytes=OUTPUT_PREVIEW_BYTES,private maxLines=OUTPUT_PREVIEW_LINES,private tailBytes=OUTPUT_TAIL_BYTES) {
    if(maxBytes<1||maxLines<1||tailBytes<0||tailBytes>maxBytes)throw new Error('Invalid output preview limits');
  }
  append(text:string):void {
    if(!text)return;
    const data=Buffer.from(text),needed=Math.max(0,this.maxBytes-this.tailBytes-this.head.length);
    this.bytes+=data.length;this.newlines+=(text.match(/\n/g)??[]).length;this.last=text.at(-1)!;
    if(needed)this.head=Buffer.concat([this.head,data.subarray(0,needed)]);
    if(this.tailBytes&&data.length>needed)this.tail=Buffer.from(Buffer.concat([this.tail,data.subarray(needed)]).subarray(-this.tailBytes));
  }
  preview():TextPreview {
    const totalLines=this.newlines+Number(this.bytes>0&&this.last!=='\n');
    const byteOmitted=this.bytes>this.maxBytes;
    // Decode together when contiguous, so a split UTF-8 scalar is not lost.
    const whole=byteOmitted?'':Buffer.concat([this.head,this.tail]).toString('utf8');
    const omitted=byteOmitted||totalLines>this.maxLines;
    if(!omitted)return {text:whole,omitted:false,totalBytes:this.bytes,totalLines,returnedBytes:Buffer.byteLength(whole)};
    let text=byteOmitted?decode(this.head)+decode(this.tail):whole;
    if(totalLines>this.maxLines&&lines(text).length>this.maxLines){
      const all=lines(text),headCount=Math.ceil(this.maxLines/2),tailCount=Math.floor(this.maxLines/2);
      text=all.slice(0,headCount).join('')+(tailCount?all.slice(-tailCount).join(''):'');
    }
    return {text,omitted:true,totalBytes:this.bytes,totalLines,returnedBytes:Buffer.byteLength(text)};
  }
}
