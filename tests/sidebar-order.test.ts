import {test} from 'node:test';
import assert from 'node:assert/strict';
import {completeSidebarOrder,loadSidebarOrder,moveSidebarItem,orderSidebarItems,reconcileSidebarOrder} from '../src/renderer/sidebar-order';

const id=(n:number)=>`00000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
const a=id(1),b=id(2),c=id(3),d=id(4),project=id(10);
const storage=(value:unknown)=>({getItem:()=>JSON.stringify(value)});
test('sidebar cache tolerates unavailable storage, malformed values and duplicate IDs',()=>{
  const empty={projects:[],sessions:{}};
  assert.deepEqual(loadSidebarOrder({getItem:()=>{throw new Error('Unavailable');}}),empty);
  for(const text of ['{','[]','null','"invalid"',' '.repeat(1024*1024+1)])assert.deepEqual(loadSidebarOrder({getItem:()=>text}),empty);
  assert.deepEqual(loadSidebarOrder(storage({projects:[a,a,null,'invalid',b],sessions:{invalid:[c],[project]:[c,c,42,d]}})),{projects:[a,b],sessions:{[project]:[c,d]}});
  assert.equal(loadSidebarOrder(storage({projects:Array.from({length:300},(_,i)=>id(i)),sessions:{[project]:Array.from({length:2200},(_,i)=>id(i))}})).projects.length,200);
  assert.equal(loadSidebarOrder(storage({sessions:{[project]:Array.from({length:2200},(_,i)=>id(i))}})).sessions[project].length,2000);
});
test('manual order survives backend activity order and leaves input untouched',()=>{
  const items=[{id:a,status:'running'},{id:c,status:'stopped'},{id:b,status:'running'}],saved=[b,a,c];
  assert.deepEqual(orderSidebarItems(items,saved).map(item=>item.id),saved);
  assert.deepEqual(orderSidebarItems([...items].reverse(),saved).map(item=>item.id),saved);
  assert.deepEqual(items.map(item=>item.id),[a,c,b]);assert.deepEqual(orderSidebarItems(items,[]),items);
});
test('new members lead saved members and unavailable members keep their slots',()=>{
  assert.deepEqual(completeSidebarOrder([c,a,d],[b,a]),[c,d,b,a]);
  assert.deepEqual(orderSidebarItems([{id:a},{id:c}],[b,a,c]).map(item=>item.id),[a,c]);
  const first=reconcileSidebarOrder({projects:[],sessions:{}},[project],[{id:a,projectId:project},{id:b,projectId:project}]);
  const second=reconcileSidebarOrder(first,[project],[{id:c,projectId:project},{id:b,projectId:project},{id:a,projectId:project}]);
  assert.deepEqual(second.sessions[project],[c,a,b]);
  assert.equal(reconcileSidebarOrder(second,[project],[{id:a,projectId:project},{id:b,projectId:project},{id:c,projectId:project}]),second);
  assert.equal(reconcileSidebarOrder(second,[],[]),second,'Filtering/removal must not rewrite the saved sequence');
  assert.deepEqual(loadSidebarOrder(storage(second)),second);
});
test('before/after moves use the full sequence and preserve hidden members',()=>{
  assert.deepEqual(moveSidebarItem([a,b,c,d],[a,b,c,d],d,a,'before'),[d,a,b,c]);
  assert.deepEqual(moveSidebarItem([a,b,c,d],[a,b,c,d],a,c,'after'),[b,c,a,d]);
  assert.deepEqual(moveSidebarItem([a,c],[a,b,c,d],c,a,'before'),[c,a,b,d]);
  assert.deepEqual(moveSidebarItem([a,b,c],[],a,c,'after'),[b,c,a]);
  for(const [source,target] of [[a,a],[d,a],[a,d]])assert.deepEqual(moveSidebarItem([a,b,c],[a,b,c],source,target,'after'),[a,b,c]);
});
