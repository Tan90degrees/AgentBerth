import {test} from 'node:test';
import assert from 'node:assert/strict';
import {DEFAULT_SETTINGS, type State} from '../src/shared/protocol';
import {getWorkspaceState, mergeWorkspaceState, publishWorkspaceState, resetWorkspaceState, subscribeWorkspace} from '../src/renderer/workspace-state';

const snapshot = (over: Partial<State> = {}): State => ({
  projects: [], sessions: [],
  maxActiveTerminals: 16, maxSshTerminals: 8,
  platform: 'win32', settings: structuredClone(DEFAULT_SETTINGS), apiVersion: 51,
  ...over,
});
const project = (id: string) => ({ id, name: id, path: 'C:/work/' + id, createdAt: '2026-01-01T00:00:00.000Z' }) as unknown as State['projects'][number];
const session = (id: string) => ({ id, projectId: 'a', title: id, agent: 'shell', command: '', createdAt: '2026-01-01T00:00:00.000Z' }) as unknown as State['sessions'][number];
const agents = [{ id: 'x', name: 'X', command: 'x', resumeCommand: '', plugin: null }] as unknown as State['agents'];

test('normalize fills protocol defaults without mutating the incoming snapshot', () => {
  const raw = snapshot({ agents: undefined, apiVersion: undefined as unknown as number, maxSshTerminals: undefined as unknown as number, settings: { fontSize: 15 } as State['settings'], sessions: [session('s1')] });
  const merged = mergeWorkspaceState(snapshot(), raw);
  assert.deepEqual(merged.agents, []);
  assert.equal(merged.apiVersion, 1);
  assert.equal(merged.maxSshTerminals, DEFAULT_SETTINGS.maxSshTerminals);
  assert.equal(merged.settings.fontSize, 15);
  assert.equal(merged.settings.defaultAgent, DEFAULT_SETTINGS.defaultAgent);
  assert.equal(merged.sessions[0].terminal, null);
  assert.equal(raw.sessions[0].terminal, undefined, 'the daemon payload must stay untouched');
});

test('identical broadcasts keep the exact same object reference', () => {
  const first = mergeWorkspaceState(snapshot(), snapshot({ projects: [project('a')] }));
  const second = mergeWorkspaceState(first, snapshot({ projects: [project('a')] }));
  assert.equal(second, first);
});

test('one changed slice keeps every other slice reference stable', () => {
  const common = { projects: [project('a')], agents, settings: { ...structuredClone(DEFAULT_SETTINGS), fontSize: 14 } };
  const first = mergeWorkspaceState(snapshot(), snapshot(common));
  const second = mergeWorkspaceState(first, snapshot({ ...common, sessions: [session('s1')] }));
  assert.notEqual(second, first);
  assert.equal(second.projects, first.projects);
  assert.equal(second.agents, first.agents);
  assert.equal(second.settings, first.settings);
  assert.notEqual(second.sessions, first.sessions);
  assert.equal(second.sessions[0].terminal, null);
});

test('scalar changes still produce a fresh snapshot', () => {
  const first = mergeWorkspaceState(snapshot(), snapshot());
  const second = mergeWorkspaceState(first, snapshot({ apiVersion: 52 }));
  assert.equal(second.apiVersion, 52);
  assert.equal(second.projects, first.projects);
});

test('publish notifies only on real changes and unsubscribe is honored', () => {
  resetWorkspaceState();
  let calls = 0;
  const unsubscribe = subscribeWorkspace(() => { calls += 1; });
  publishWorkspaceState(snapshot({ projects: [project('a')] }));
  assert.equal(calls, 1);
  assert.equal(getWorkspaceState().projects.length, 1);
  publishWorkspaceState(snapshot({ projects: [project('a')] }));
  assert.equal(calls, 1, 'an identical broadcast must not wake subscribers');
  publishWorkspaceState(snapshot({ projects: [project('a'), project('b')] }));
  assert.equal(calls, 2);
  assert.equal(getWorkspaceState().projects.length, 2);
  unsubscribe();
  publishWorkspaceState(snapshot({ projects: [project('c')] }));
  assert.equal(calls, 2);
  resetWorkspaceState();
  assert.deepEqual(getWorkspaceState().projects, []);
});
