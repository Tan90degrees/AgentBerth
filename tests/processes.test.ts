import { test } from 'node:test';
import assert from 'node:assert/strict';
import { terminateWindowsTree } from '../src/daemon/processes';

const gone=()=>{throw Object.assign(new Error('gone'),{code:'ESRCH'});};
test('Windows stop verifies actual exit when taskkill races a dead process or misses ConPTY exit',async()=>{
  let calls=0;
  await terminateWindowsTree(123,()=>true,{kill:async()=>{calls++;throw new Error('process not found');},probe:gone});
  assert.equal(calls,1);
  let probes=0;
  await terminateWindowsTree(123,()=>true,{kill:async()=>{throw new Error('taskkill timeout');},probe:()=>{if(++probes>1)gone();return true;}});
  assert.equal(probes,2,'A timed out kill may finish just after its error; confirm exit rather than leaving a stale running record');
});
test('Windows stop preserves errors if process existence cannot be confirmed and skips released ownership',async()=>{
  const failure=new Error('access denied');
  await assert.rejects(terminateWindowsTree(123,()=>true,{kill:async()=>{throw failure;},probe:()=>{throw Object.assign(new Error('permission'),{code:'EPERM'});}}),error=>error===failure);
  await terminateWindowsTree(123,()=>false,{kill:async()=>{throw new Error('must not kill');},probe:()=>{throw new Error('must not probe');}});
  let owned=true;
  await terminateWindowsTree(123,()=>owned,{kill:async()=>{owned=false;throw failure;},probe:()=>{throw new Error('released terminal must not be probed');}});
});
test('a failed taskkill never marks a still-living process as stopped',async()=>{
  const failure=new Error('taskkill failed');let probes=0;
  await assert.rejects(terminateWindowsTree(123,()=>true,{kill:async()=>{throw failure;},probe:()=>{probes++;return true;}}),error=>error===failure);
  assert.ok(probes>1,'Termination failure waits for bounded exit confirmation, but cannot invent a stopped state');
});
