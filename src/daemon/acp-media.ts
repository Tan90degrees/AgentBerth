import {createHash} from 'node:crypto';
import {acpRecord} from '../shared/acp-stream';
import type {Store} from './store';

const maxEncodedAsset = 8 * 1024 * 1024;
const inlineLimit = 24 * 1024;
const mediaMime = /^[a-z0-9][a-z0-9.+-]{0,79}\/[a-z0-9][a-z0-9.+-]{0,79}$/i;

export function acpMediaBlock(store:Store,sessionId:string,block:unknown):Record<string,unknown>|undefined{
  if(!acpRecord(block))return;
  const embedded=block.type==='resource'&&acpRecord(block.resource)?block.resource:undefined;
  const binary=block.type==='image'||block.type==='audio'?block.data:embedded?.blob;
  if(typeof binary==='string'){
    const mimeType=String(embedded?.mimeType??block.mimeType??'application/octet-stream').toLowerCase();
    if(!binary.length||binary.length>maxEncodedAsset||!mediaMime.test(mimeType)||binary.length%4||/[^A-Za-z0-9+/=]/.test(binary)
      ||binary.slice(0,-2).includes('=')||Buffer.from(binary,'base64').toString('base64')!==binary){
      return {type:block.type,mimeType,omitted:true};
    }
    const mediaId=createHash('sha256').update(mimeType).update('\0').update(binary).digest('hex');
    if(!store.saveAcpMedia(sessionId,mediaId,mimeType,binary))return {type:block.type,mimeType,omitted:true};
    return {type:block.type,mimeType,mediaId,...(typeof embedded?.uri==='string'?{uri:embedded.uri.slice(0,2000)}:{})};
  }
  if(Buffer.byteLength(JSON.stringify(block))>inlineLimit){
    const mimeType='text/plain';
    const value=typeof embedded?.text==='string'?embedded.text:typeof block.text==='string'?block.text:undefined;
    if(value!==undefined){
      const base64=Buffer.from(value).toString('base64'),mediaId=createHash('sha256').update(mimeType).update('\0').update(base64).digest('hex');
      if(base64.length<=maxEncodedAsset&&store.saveAcpMedia(sessionId,mediaId,mimeType,base64)){
        return {type:block.type,mimeType,mediaId,...(typeof embedded?.uri==='string'?{uri:embedded.uri.slice(0,2000)}:{})};
      }
    }
    return {type:block.type,omitted:true};
  }
  return block;
}
