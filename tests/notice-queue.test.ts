import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dismissNotice, pushNotice, type Notice } from '../src/renderer/notice-queue';

const action = (label: string) => ({ label, onAction: () => {} });

test('plain notices remain available in the notification center', () => {
  let list: Notice[] = pushNotice([], '已复制');
  const first = list[0].id;
  list = pushNotice(list, '已保存');
  assert.equal(list.length, 2);
  assert.equal(list[1].text, '已保存');
  assert.notEqual(list[1].id, first);
});

test('a later plain notice cannot swallow a pending undo', () => {
  let list: Notice[] = pushNotice([], '已删除「会话 A」', action('撤销'));
  const undoId = list[0].id;
  list = pushNotice(list, '路径已复制');
  assert.deepEqual(list.map(item => item.text), ['已删除「会话 A」', '路径已复制']);
  assert.equal(list[0].action?.label, '撤销');
  list = pushNotice(list, '原生会话已关联');
  assert.equal(list.length, 3, 'messages remain in history after popup collapse');
  assert.equal(list[0].id, undoId, 'the undo slot must survive');
  assert.equal(list[2].text, '原生会话已关联');
});

test('actionable notices remain available until dismissed', () => {
  let list: Notice[] = pushNotice([], '已删除「A」', action('撤销'));
  list = pushNotice(list, '已删除「B」', action('撤销'));
  assert.deepEqual(list.map(item => item.text), ['已删除「A」', '已删除「B」']);
  list = pushNotice(list, '已删除「C」', action('撤销'));
  assert.deepEqual(list.map(item => item.text), ['已删除「A」', '已删除「B」', '已删除「C」']);
  list = pushNotice(list, '已复制');
  assert.equal(list.length, 4);
  assert.equal(list[3].text, '已复制');
});

test('dismissing one notice leaves the others in place', () => {
  let list: Notice[] = pushNotice([], '已删除「A」', action('撤销'));
  list = pushNotice(list, '已删除「B」', action('撤销'));
  const keep = list[1].id;
  list = dismissNotice(list, list[0].id);
  assert.equal(list.length, 1);
  assert.equal(list[0].id, keep);
  assert.equal(dismissNotice(list, keep).length, 0);
});

test('empty messages do not erase notification history', () => {
  let list: Notice[] = pushNotice([], '已删除「A」', action('撤销'));
  list = pushNotice(list, '已复制');
  list = pushNotice(list, '');
  assert.equal(list.length, 2);
  assert.equal(list[0].text, '已删除「A」');
  assert.equal(list[0].action?.label, '撤销');
});
