import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { TerminalActivity } from '../src/renderer/terminal-activity';
import { DaemonServer } from '../src/daemon/server';
import { DaemonConnection } from '../src/main/connection';
import type { Project, Run, Session, ServerEvent } from '../src/shared/protocol';

const session = (id: string, runId: string) => ({ id, latestRun: { id: runId } as Run });
test('unread output is independent of running status, viewed terminals, duplicates and old runs', () => {
  const activity = new TerminalActivity();
  activity.reconcile([session('local','run-a'), session('ssh','run-b')]);
  assert.equal(activity.snapshot().size,0,'starting a run is not new output');
  activity.view(['local']);
  assert.equal(activity.output({sessionId:'local',runId:'run-a',seq:1}),false);
  assert.equal(activity.output({sessionId:'ssh',runId:'run-b',seq:1}),true);
  assert.equal(activity.output({sessionId:'ssh',runId:'run-b',seq:2}),false,'streaming updates do not rerender the sidebar');
  assert.deepEqual([...activity.snapshot()],['ssh']);
  assert.equal(activity.output({sessionId:'local',runId:'stale',seq:99}),false);
  assert.equal(activity.view(['local','ssh']),true,'both split panes can be viewed at once');
  assert.equal(activity.snapshot().size,0);
  activity.view([]); // History/preview/settings, hidden or unfocused window.
  assert.equal(activity.output({sessionId:'ssh',runId:'run-b',seq:2}),false,'replayed output does not restore a reminder');
  assert.equal(activity.output({sessionId:'local',runId:'run-a',seq:2}),true);
  assert.equal(activity.output({sessionId:'ssh',runId:'run-b',seq:3}),true);
  assert.equal(activity.reconcile([session('local','run-a'),session('ssh','run-b')]),false,'stop/state refresh retains unread final output');
  const snapshot = activity.snapshot();
  assert.equal(activity.reconcile([session('local','run-new')]),true,'restart and deletion remove stale reminders');
  assert.equal(activity.snapshot().size,0);
  assert.equal(snapshot.size,2,'previous React snapshot remains unchanged');
  assert.equal(activity.output({sessionId:'local',runId:'run-a',seq:100}),false);
  assert.equal(activity.output({sessionId:'local',runId:'run-new',seq:1}),true);
});

async function eventually(check: () => boolean, message: string) {
  const deadline = Date.now()+8000;
  while(Date.now()<deadline) { if(check())return; await new Promise(resolve=>setTimeout(resolve,30)); }
  assert.fail(message);
}

test('unattached clients get one content-free reminder, rearmed by viewing, with independent client state', {timeout:25000}, async t => {
  const folder=mkdtempSync(path.join(os.tmpdir(),'berth-output-reminder-'));
  const server=new DaemonServer(path.join(folder,'data'));
  const runtime=await server.listen(), events:ServerEvent[]=[], otherEvents:ServerEvent[]=[];
  const observer=await DaemonConnection.open(runtime,event=>events.push(event));
  const writer=await DaemonConnection.open(runtime,event=>otherEvents.push(event));
  t.after(async()=>{observer.close();writer.close();await server.close();rmSync(folder,{recursive:true,force:true,maxRetries:5});});
  const project=await writer.rpc<Project>('createProject',{name:'activity',path:folder});
  const target=await writer.rpc<Session>('createSession',{projectId:project.id,title:'background',agent:'shell'});
  const run=await writer.rpc<Run>('start',{sessionId:target.id,cols:80,rows:24});
  const notices=()=>events.filter(value=>value.event==='terminalActivity'&&value.data.sessionId===target.id);
  await writer.rpc('attach',{sessionId:target.id});
  await writer.rpc('input',{sessionId:target.id,runId:run.id,data:'echo BACKGROUND_NOTICE\r'});
  await eventually(()=>notices().length===1,'background output did not notify the unattached client');
  assert.equal(events.some(value=>value.event==='output'),false,'background content must not be streamed');
  const notice=notices()[0];
  assert.equal(notice.event,'terminalActivity');
  assert.deepEqual(Object.keys(notice.data).sort(),['runId','seq','sessionId']);
  await writer.rpc('input',{sessionId:target.id,runId:run.id,data:'echo SECOND_NOTICE\r'});
  await eventually(()=>otherEvents.some(value=>value.event==='output'&&value.data.text.includes('SECOND_NOTICE')),'attached client did not receive live output');
  assert.equal(notices().length,1,'continuous output only lights the reminder once');
  await observer.rpc('attach',{sessionId:target.id});
  await observer.rpc('detach',{sessionId:target.id});
  const afterDetach=events.length;
  await writer.rpc('input',{sessionId:target.id,runId:run.id,data:'echo REARMED_NOTICE\r'});
  await eventually(()=>notices().length===2,'viewing did not rearm the next reminder');
  assert.equal(events.slice(afterDetach).some(value=>value.event==='output'),false,'detached client gets no streamed content');
  await writer.rpc('resize',{sessionId:target.id,runId:run.id,cols:90,rows:28});
  assert.equal(notices().length,2,'resize boundaries are not output reminders');
});
