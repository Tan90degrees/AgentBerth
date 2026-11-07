import {test} from 'node:test';
import assert from 'node:assert/strict';
import {completeActivityOrder,loadActivityOrder,moveActivityItem,orderActivityItems,reconcileActivityOrder} from '../src/renderer/activity-order';
const a='pet:main',b='superagent:tasks',c='deepseek-harness:web';
const storage=(value:unknown)=>({getItem:()=>JSON.stringify(value)??null});
test('activity order tolerates unavailable and malformed storage',()=>{
 assert.deepEqual(loadActivityOrder({getItem:()=>{throw new Error('Unavailable');}}),{items:[]});
 for(const value of ['{','[]','null','"invalid"'])assert.deepEqual(loadActivityOrder({getItem:()=>value}),{items:[]});
 assert.deepEqual(loadActivityOrder(storage([a,a,'invalid',b])),{items:[a,b]});
});
test('activity order is stable across plugin snapshot changes',()=>{
 assert.deepEqual(completeActivityOrder([c,a,b],[b,a]),[b,a,c]);
 assert.deepEqual(orderActivityItems([{id:a},{id:c},{id:b}],[b,a]).map(x=>x.id),[b,a,c]);
 const previous={items:[b,a]},next=reconcileActivityOrder(previous,[c,a,b]);assert.deepEqual(next.items,[b,a,c]);
 assert.equal(reconcileActivityOrder(next,[c,a,b]),next);
 // Disabled views remain known to the manifest snapshot and keep their place.
 const withDisabled=reconcileActivityOrder(next,[b,a,c]);assert.deepEqual(withDisabled.items,[b,a,c]);
 assert.deepEqual(orderActivityItems([{id:a},{id:c}],[...withDisabled.items]).map(x=>x.id),[a,c]);
});
test('drag reorder supports before/after and ignores invalid targets',()=>{
 assert.deepEqual(moveActivityItem([a,b,c],[a,b,c],c,a,'before'),[c,a,b]);
 assert.deepEqual(moveActivityItem([a,b,c],[a,b,c],a,c,'after'),[b,c,a]);
 assert.deepEqual(moveActivityItem([a,c],[a,b,c],c,a,'before'),[c,a]);
 assert.deepEqual(moveActivityItem([a,b,c],[],a,a,'after'),[a,b,c]);
 assert.deepEqual(moveActivityItem([a,b,c],[b,a,c],c,a,'before'),[b,c,a]);
});
