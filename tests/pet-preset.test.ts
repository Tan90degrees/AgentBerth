import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {mkdtempSync,readFileSync,existsSync,rmSync,writeFileSync} from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {NaiwaPreset,naiwaSource} from '../src/main/pet-preset';
import {PetState} from '../src/main/pet-state';
import {petPreferencesSchema,naiwaClips,petStatuses} from '../src/shared/pet';

const atlas=Buffer.from('RIFF\u0010\u0000\u0000\u0000WEBPtest-atlas'),source={...naiwaSource,sha256:createHash('sha256').update(atlas).digest('hex')};
function fixture(t:import('node:test').TestContext){const folder=mkdtempSync(path.join(os.tmpdir(),'berth-preset-'));t.after(()=>rmSync(folder,{recursive:true,force:true}));return folder;}
test('first explicit preset install coalesces, pins source URLs and keeps an offline verified cache',async t=>{
  const folder=fixture(t),preset=new NaiwaPreset(folder,source),urls:string[]=[];
  const fetcher=async(url:string)=>{urls.push(url);return new Response(url.endsWith('.webp')?atlas:'upstream notice');};
  assert.equal(preset.ready,false);assert.equal(preset.image(),null);
  await Promise.all([preset.install(fetcher),preset.install(fetcher)]);assert.equal(urls.length,3);assert.ok(urls.every(url=>url.startsWith('https://raw.githubusercontent.com/timerring/codex-pet-naiwa/'+source.commit+'/')));
  assert.equal(preset.ready,true);assert.equal(preset.image(),'data:image/webp;base64,'+atlas.toString('base64'));assert.equal(readFileSync(path.join(folder,'LICENSE'),'utf8'),'upstream notice');
  const reloaded=new NaiwaPreset(folder,source);await reloaded.install(async()=>{throw new Error('Offline');});assert.equal(reloaded.image(),preset.image());assert.equal(existsSync(path.join(folder,'spritesheet.webp.tmp')),false);
});
test('corrupt, truncated, oversized and failed downloads never install or overwrite custom images, and explicit retries work',async t=>{
  const folder=fixture(t),preset=new NaiwaPreset(folder,source);writeFileSync(path.join(folder,'working.gif'),'keep custom');
  for(const response of [()=>new Response('corrupt'),()=>new Response(atlas.subarray(0,14)),()=>new Response(null,{status:503}),()=>new Response(atlas,{headers:{'content-length':String(3*1024*1024)}}),()=>new Response(new ReadableStream({start(controller){controller.enqueue(new Uint8Array(2*1024*1024));controller.enqueue(new Uint8Array(1));controller.close();}}))]){
    await assert.rejects(preset.install(async url=>url.endsWith('.webp')?response():new Response('notice')),/下载未完成/);assert.equal(preset.ready,false);assert.equal(existsSync(path.join(folder,'spritesheet.webp')),false);assert.equal(readFileSync(path.join(folder,'working.gif'),'utf8'),'keep custom');
  }
  await preset.install(async url=>new Response(url.endsWith('.webp')?atlas:'notice'));assert.equal(preset.ready,true);
  writeFileSync(path.join(folder,'spritesheet.webp'),'corrupt local cache');assert.equal(new NaiwaPreset(folder,source).ready,false);
});
test('appearance preferences migrate without losing GIFs, reject unavailable selections and retain custom overrides across switches',t=>{
  const folder=fixture(t);writeFileSync(path.join(folder,'settings.json'),JSON.stringify({enabled:true,scale:1.25,selectedSessionId:'session'}));writeFileSync(path.join(folder,'working.gif'),readFileSync('tests/fixtures/pet-working.gif'));
  const state=new PetState(folder);state.loadImages(['working']);assert.equal(state.preferences.appearance,'dafeiyu');assert.equal(state.preferences.customImages,true);assert.equal(state.preferences.selectedSessionId,'session');assert.equal(state.preferences.scale,1.25);
  assert.throws(()=>state.save({...state.preferences,appearance:'naiwa'}),/先下载/);
  state.save({...state.preferences,customImages:false});assert.ok(state.image('working'));assert.equal(state.snapshot().images.working,'working.gif');
  state.importImage('waiting',readFileSync('tests/fixtures/pet-working.gif'),'waiting.gif');assert.equal(state.preferences.customImages,true);
  const reloaded=new PetState(folder);assert.equal(reloaded.preferences.customImages,true);assert.equal(petPreferencesSchema.safeParse({...state.preferences,appearance:'../secret'}).success,false);
  writeFileSync(path.join(folder,'settings.json'),JSON.stringify({...state.preferences,appearance:'naiwa'}));assert.equal(new PetState(folder).preferences.appearance,'dafeiyu');
});
test('all execution states have distinct source rows and the completion clip selects the laughing action',()=>{
  assert.equal(new Set(petStatuses.map(status=>naiwaClips[status].row)).size,6);assert.equal(naiwaClips.completed.row,4);assert.equal(naiwaClips.completed.loop,false);
  for(const clip of Object.values(naiwaClips)){assert.ok(clip.frames>=2&&clip.frames<=8);assert.ok(clip.row>=0&&clip.row<9);assert.ok(clip.duration>=500);}
});
