import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync,rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { CommandOutput } from '../src/daemon/remote-output';
import { outputSearchSchema } from '../src/shared/protocol';

const options=(patch:Record<string,unknown>={})=>outputSearchSchema.parse({query:'error',...patch});
const jsonBytes=(value:unknown)=>Buffer.byteLength(JSON.stringify(value).replace(/[^\x00-\x7f]/g,'\\u0000'));

test('literal cached search finds omitted middle output, merges context and counts matching lines',()=>{
  const cache=new CommandOutput();cache.append(Array.from({length:6000},(_,i)=>i===3000?'ERROR decisive failure':i===3001?'error error again':`line ${i}`).join('\n'));
  assert.ok(!cache.summary().text.includes('decisive'));
  const found=cache.search(options()).search!;assert.equal(found.totalMatches,2);assert.equal(found.returnedMatches,2);assert.equal(found.groups.length,1);assert.deepEqual(found.groups[0].matchLines,[3001,3002]);assert.ok(found.groups[0].text.includes('line 2998'));assert.ok(found.groups[0].text.includes('line 3003'));
  const count=cache.search(options({limit:0})).search!;assert.equal(count.totalMatches,2);assert.equal(count.groups.length,0);assert.equal(count.nextOffset,null);
  assert.equal(cache.search(options({caseSensitive:true})).search!.totalMatches,1);
  cache.append('\n[x].*? literal\nxxxx wildcard\n');assert.equal(cache.search(options({query:'[x].*?'})).search!.totalMatches,1);
});

test('search strips display controls without mutating original output; empty context lines remain aligned',()=>{
  const cache=new CommandOutput(),raw='\nER\x1b[31mROR\x1b[0m 中🙂\n\nafter\n';cache.append(raw);
  const found=cache.search(options({contextLines:1})).search!;assert.equal(found.groups[0].startLine,1);assert.equal(found.groups[0].text,'\nERROR 中🙂\n');assert.equal(cache.read(0,65536).text,raw);
});

test('query pagination freezes the range while output grows and rejects evicted snapshots',()=>{
  const cache=new CommandOutput(200);cache.append('error one\nerror two\nerror three\n');
  const first=cache.search(options({limit:1,contextLines:0})).search!;assert.equal(first.nextOffset,1);
  cache.append('error NEW\n');const second=cache.search(options({limit:1,offset:first.nextOffset,endCursor:first.endCursor,contextLines:0}),first.startCursor).search!;assert.equal(second.totalMatches,3);assert.ok(second.groups[0].text.includes('two'));assert.ok(!second.groups[0].text.includes('NEW'));
  cache.append('x'.repeat(300)+'\nerror retained\n');assert.throws(()=>cache.search(options({endCursor:first.endCursor,offset:1}),first.startCursor),/快照/);
  const retained=cache.search(options());assert.equal(retained.cacheLost,true);assert.equal(retained.search!.totalMatches,1);
});

test('long matching lines keep the hit within a small query budget and do not split Unicode',()=>{
  const cache=new CommandOutput();cache.append('甲🙂'.repeat(50000)+'needle'+'乙🙂'.repeat(50000)+'\n');
  const found=cache.search(options({query:'needle',contextLines:0,maxBytes:4096})).search!;assert.equal(found.totalMatches,1);assert.ok(found.groups[0].text.includes('needle'));assert.ok(!found.groups[0].text.includes('�'));assert.ok(jsonBytes(found)<=4096);assert.equal(found.omitted,true);
  const unicode='中'.repeat(256);const other=new CommandOutput();other.append(unicode.repeat(30)+'\n');assert.ok(jsonBytes(other.search(options({query:unicode,maxBytes:4096})).search!)<=4096);
});

test('disk-backed search crosses read boundaries, respects budgets and reports missing caches',t=>{
  const directory=mkdtempSync(path.join(tmpdir(),'ab-search-')),cache=new CommandOutput(200000,path.join(directory,'cache'));
  t.after(()=>{cache.dispose();rmSync(directory,{recursive:true,force:true});});
  cache.append('a'.repeat(65530)+'ERROR boundary\n'+('error '+'long'.repeat(60)+'\n').repeat(80));
  const found=cache.search(options({limit:100,maxBytes:4096})).search!;assert.equal(found.totalMatches,81);assert.ok(found.returnedMatches>0);assert.ok(jsonBytes(found)<=4096);assert.ok(found.nextOffset!==null);assert.ok(found.groups[0].text.includes('ERROR boundary'));
  const missing=new CommandOutput(10,path.join(directory,'missing','cache'));assert.equal(missing.search(options()).available,false);
});
