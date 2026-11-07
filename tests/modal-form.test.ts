import {test} from 'node:test';
import assert from 'node:assert/strict';
import {modalFormInitial, modalFormValue, SESSION_KINDS, type ModalFormValues, type Modal} from '../src/renderer/modal-form';

const sessionValues = {
  title: '调试会话', agent: 'shell', command: 'npm run dev', terminal: null,
  startNow: false, remote: null, worktreePath: null, service: true,
} as const;

const blank = (): ModalFormValues => ({
  name: '', folder: '', title: '', agent: 'codex', command: '', terminal: null,
  startNow: true, remote: null, worktreePath: null, service: false, nativeId: '',
});

test('project form keeps only name and folder; unrelated fields stay at defaults', () => {
  const form = modalFormInitial('editProject', { project: { name: '泊栈', folder: 'C:/work/berth' } });
  assert.equal(form.name, '泊栈');
  assert.equal(form.folder, 'C:/work/berth');
  assert.equal(form.title, '');
  assert.equal(form.agent, 'codex');
  assert.equal(form.nativeId, '');
  assert.deepEqual(modalFormValue('project', form), JSON.stringify({ name: '泊栈', folder: 'C:/work/berth' }));
});

test('single-value dialogs route value to their own field only', () => {
  const renameProject = modalFormInitial('renameProject', { value: '新项目名' });
  assert.equal(renameProject.name, '新项目名');
  assert.equal(renameProject.title, '');
  assert.equal(renameProject.nativeId, '');
  assert.equal(modalFormValue('renameProject', renameProject), JSON.stringify('新项目名'));

  const renameSession = modalFormInitial('renameSession', { value: '新会话名' });
  assert.equal(renameSession.title, '新会话名');
  assert.equal(renameSession.name, '');
  assert.equal(modalFormValue('renameSession', renameSession), JSON.stringify('新会话名'));

  const link = modalFormInitial('link', { value: 'native-123' });
  assert.equal(link.nativeId, 'native-123');
  assert.equal(link.title, '');
  assert.equal(modalFormValue('link', link), JSON.stringify('native-123'));
});

test('session form preserves every submitted field and uses the same shape for SSH dialogs', () => {
  const form = modalFormInitial('editSession', { session: { ...sessionValues } });
  assert.equal(form.title, '调试会话');
  assert.equal(form.command, 'npm run dev');
  assert.equal(form.startNow, false);
  assert.equal(form.service, true);
  assert.equal(form.remote, null);
  assert.deepEqual(Object.keys(JSON.parse(modalFormValue('session', form))), [
    'title', 'agent', 'command', 'terminal', 'startNow', 'remote', 'worktreePath', 'service',
  ]);
  assert.equal(SESSION_KINDS.size, 4);
  for (const kind of ['session', 'editSession', 'sshSession', 'editSshSession'] as Modal[]) {
    assert.ok(SESSION_KINDS.has(kind));
    assert.equal(modalFormValue(kind, form), modalFormValue('session', form));
  }
});

test('dirty detection is stable: clean initially, dirty on change, clean again when reverted', () => {
  const form = blank();
  const initial = modalFormValue('session', form);
  assert.notEqual(initial, '');
  assert.equal(modalFormValue('session', form), initial);

  const edited = { ...form, title: '改过的名字' };
  assert.notEqual(modalFormValue('session', edited), initial);
  assert.equal(modalFormValue('session', { ...edited, title: form.title }), initial, 'reverting the edit restores a clean form');
  assert.equal(modalFormValue('project', { ...form, title: '改过的名字' }), modalFormValue('project', form), 'project forms ignore session fields');
});

test('confirmation-only dialogs have no form snapshot, so Escape closes immediately', () => {
  const form = blank();
  for (const kind of ['deleteSession', 'deleteProject', 'stop', 'restart'] as Modal[]) {
    assert.equal(modalFormValue(kind, form), '', kind);
  }
  assert.equal(modalFormValue('deleteSession', { ...form, name: 'anything' }), '');
});

test('a new project starts from empty name/folder but a fresh session defaults to immediate start', () => {
  const project = modalFormInitial('project', { project: { name: '', folder: '' } });
  assert.equal(modalFormValue('project', project), JSON.stringify({ name: '', folder: '' }));
  const session = modalFormInitial('session', { session: { ...sessionValues, startNow: true } });
  assert.equal(session.startNow, true);
  const untouched = modalFormInitial('deleteProject', {});
  assert.equal(untouched.name, '');
  assert.equal(untouched.startNow, true);
});
