import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {chat} from '../src/wiki/llm';
import {ModelScheduler} from '../src/wiki/model-scheduler';
import {WikiService} from '../src/wiki/service';
import {WikiStore} from '../src/wiki/store';
import type {WikiConfig} from '../src/wiki/types';
const response=(text='answer')=>new Response(JSON.stringify({choices:[{message:{content:text}}]}));
const config:WikiConfig={baseURL:'http://text.invalid/v1',textModel:'text',visionModel:'vision',autoCompile:false,autoApprove:false,authRequired:false,lintMinutes:0,maxContextPages:8};
async function until(check:()=>boolean){for(let i=0;i<400;i++){if(check())return;await new Promise(resolve=>setTimeout(resolve,5));}throw new Error('Model condition did not settle');}
function fixture(t:import('node:test').TestContext,extra:Partial<WikiConfig>,fetchImpl:typeof fetch){const dir=mkdtempSync(path.join(os.tmpdir(),'wiki-model-')),store=new WikiStore(dir),controller=new AbortController();const service=new WikiService({store,config:{...config,...extra},signal:controller.signal,fetchImpl});t.after(()=>{controller.abort();rmSync(dir,{recursive:true,force:true,maxRetries:5});});return {service,store,controller};}

test('transport retries are bounded, honor Retry-After and never retry auth or malformed model output',async()=>{
 const base={baseURL:config.baseURL,apiKey:'',authRequired:false,model:'text',messages:[],retries:2,retryDelayMs:0};let calls=0;
 assert.equal(await chat({...base,fetchImpl:async()=>++calls<3?new Response('busy',{status:429,headers:{'Retry-After':'0'}}):response()}),'answer');assert.equal(calls,3);
 calls=0;await assert.rejects(chat({...base,fetchImpl:async()=>{calls++;return new Response('unavailable',{status:503});}}),/503/);assert.equal(calls,3);
 for(const status of [400,401,403,404]){calls=0;await assert.rejects(chat({...base,fetchImpl:async()=>{calls++;return new Response('invalid',{status});}}),new RegExp(String(status)));assert.equal(calls,1);}
 calls=0;await assert.rejects(chat({...base,fetchImpl:async()=>{calls++;return new Response('not json');}}),/JSON/);assert.equal(calls,1);
 calls=0;assert.equal(await chat({...base,fetchImpl:async()=>{if(++calls===1)throw new TypeError('network unavailable');return response();}}),'answer');assert.equal(calls,2);
 calls=0;assert.equal(await chat({...base,timeoutMs:5,fetchImpl:async(_url,init)=>{if(++calls===3)return response();return new Promise((_resolve,reject)=>init!.signal!.addEventListener('abort',()=>reject(new Error('timeout')),{once:true}));}}),'answer');assert.equal(calls,3);
 calls=0;await assert.rejects(chat({...base,retries:0,fetchImpl:async()=>{calls++;return new Response('busy',{status:503});}}));assert.equal(calls,1);
});

test('cancellation interrupts retry backoff without sending another request or exposing credentials',async()=>{
 const controller=new AbortController();let calls=0;
 const pending=chat({baseURL:config.baseURL,apiKey:'private-example-key',model:'text',messages:[],retries:8,signal:controller.signal,fetchImpl:async()=>{calls++;return new Response('Bearer private-example-key',{status:429,headers:{'Retry-After':'30'}});}});
 await until(()=>calls===1);controller.abort(new Error('cancelled'));await assert.rejects(pending,/cancelled/);assert.equal(calls,1);
 await assert.rejects(chat({baseURL:config.baseURL,apiKey:'private-example-key',model:'text',messages:[],fetchImpl:async()=>new Response('Bearer private-example-key',{status:401})}),error=>!String(error).includes('private-example-key'));
});

test('one request limiter keeps FIFO slots, cancels waiters and releases slots after failure',async()=>{
 const scheduler=new ModelScheduler(2),controller=new AbortController(),cancelled=new AbortController(),started:number[]=[];let active=0,peak=0;const release:Array<()=>void>=[];
 const work=(i:number)=>scheduler.run(i===2?cancelled.signal:controller.signal,async()=>{started.push(i);active++;peak=Math.max(peak,active);await new Promise<void>(resolve=>release.push(resolve));active--;if(i===0)throw new Error('first failed');return i;});
 const first=work(0).catch(()=>-1),second=work(1),third=work(2).catch(()=>-2),fourth=work(3);assert.deepEqual(started,[0,1]);cancelled.abort();release[0]();await until(()=>started.includes(3));assert.deepEqual(started,[0,1,3]);release[1]();release[2]();assert.deepEqual(await Promise.all([first,second,third,fourth]),[-1,1,-2,3]);assert.equal(peak,2);
});

test('text and image endpoints and credentials are independent, including local vision without authentication',async t=>{
 const requests:Array<{url:string;auth:string|null;model:string}>=[];
 const {service,store}=fixture(t,{authRequired:true,visionBaseURL:'http://vision.invalid/v1',visionAuthRequired:true},async(url,init)=>{requests.push({url:String(url),auth:new Headers(init?.headers).get('Authorization'),model:JSON.parse(String(init?.body)).model});return response();});
 await service.setApiKey('text-example-secret');await assert.rejects(service.testConnection('vision'),/API Key/);assert.equal(requests.length,0,'text key must never travel to a separate image endpoint');
 await service.setApiKey('vision-example-secret','vision');await service.testConnection();await service.testConnection('vision');
 assert.deepEqual(requests,[{url:'http://text.invalid/v1/chat/completions',auth:'Bearer text-example-secret',model:'text'},{url:'http://vision.invalid/v1/chat/completions',auth:'Bearer vision-example-secret',model:'vision'}]);
 assert.ok(!JSON.stringify(service.status()).includes('example-secret'));await service.clearApiKey('vision');assert.equal(store.credentials().apiKey,'text-example-secret');
 service.config.visionAuthRequired=false;await service.testConnection('vision');assert.equal(requests.at(-1)!.auth,null);
 service.config.visionBaseURL='';await service.testConnection('vision');assert.equal(requests.at(-1)!.auth,'Bearer text-example-secret','old shared configuration remains supported');
});

test('configured concurrency allows two model tasks while a third stays queued and cancellation does not submit it',async t=>{
 const gates:Array<()=>void>=[];let calls=0;
 const {service}=fixture(t,{llmConcurrency:2},async()=>{calls++;await new Promise<void>(resolve=>gates.push(resolve));return response();});
 const first=service.ask('one'),second=service.ask('two'),third=service.ask('three');assert.equal(calls,2);assert.equal(service.taskStatus(third)!.status,'queued');service.cancelTask(third);gates.forEach(resolve=>resolve());await until(()=>service.taskStatus(first)!.status==='done'&&service.taskStatus(second)!.status==='done');assert.equal(calls,2);assert.equal(service.answers().length,2);assert.equal(service.status().model.llmConcurrency,2);
});

test('image workers run concurrently within the global limit and retain the original image order',async t=>{
 let inFlight=0,peak=0,visionCalls=0;const gates:Array<()=>void>=[];
 const {service,store}=fixture(t,{llmConcurrency:2},async(_url,init)=>{const body=JSON.parse(String(init?.body));if(body.model==='vision'){const index=visionCalls++;inFlight++;peak=Math.max(peak,inFlight);await new Promise<void>(resolve=>gates[index]=resolve);inFlight--;return response('image-'+index);}
  return response(JSON.stringify({summary:'result',concepts:[],claims:[],contradictions:[],pages:[{slug:'combined',title:'combined',kind:'note',summary:'',body:'all images',sources:[],tags:[]}]}));});
 const image={mime:'image/png',base64:Buffer.from('image bytes').toString('base64')},source=await service.addSource({title:'images',text:'all figures',images:[image,image,image]});const task=service.compile(source.id);await until(()=>visionCalls===2);gates[1]();await until(()=>visionCalls===3);gates[2]();gates[0]();await until(()=>['done','failed'].includes(service.taskStatus(task)!.status));assert.equal(service.taskStatus(task)!.status,'done',service.taskStatus(task)!.error);assert.equal(peak,2);const vision=store.getSource(source.id)!.vision;assert.ok(vision.indexOf('image-0')<vision.indexOf('image-1')&&vision.indexOf('image-1')<vision.indexOf('image-2'));
});


test('automatic compilation fills configured slots and cancelling sources prevents paid replay',async t=>{
 let calls=0;const {service}=fixture(t,{autoCompile:true,llmConcurrency:2},async(_url,init)=>{calls++;return new Promise((_resolve,reject)=>init!.signal!.addEventListener('abort',()=>reject(new Error('cancelled')),{once:true}));});
 await service.addSource({title:'first',text:'first full source'});await service.addSource({title:'second',text:'second full source'});service.tick();await until(()=>calls===2);assert.equal(calls,2);assert.equal(service.taskList().filter(task=>task.status==='running').length,2);
 service.taskList().forEach(task=>service.cancelTask(task.id));await until(()=>{try{service.assertWorkspaceIdle();return true;}catch{return false;}});service.tick();assert.equal(calls,2);assert.ok(service.taskList().every(task=>task.status==='cancelled'));
});


test('stopping the plugin persists interrupted compile as manual retry instead of replaying paid requests',async t=>{
 let calls=0;const options={...config,autoCompile:true,llmConcurrency:2};
 const {store,service,controller}=fixture(t,options,async(_url,init)=>{calls++;return new Promise((_resolve,reject)=>init!.signal!.addEventListener('abort',()=>reject(new Error('plugin stopped')),{once:true}));});
 await service.addSource({title:'pending compile',text:'full retained source'});service.tick();await until(()=>calls===1);controller.abort();await until(()=>service.taskList().every(task=>task.status==='failed'&&task.manualRetry===true));
 const restarted=new AbortController();t.after(()=>restarted.abort());let replays=0;
 const reopened=new WikiService({store:new WikiStore(store.root),config:options,signal:restarted.signal,fetchImpl:async()=>{replays++;return response();}});reopened.tick();await new Promise(resolve=>setImmediate(resolve));assert.equal(replays,0);assert.equal(reopened.listSources().length,1);
});
