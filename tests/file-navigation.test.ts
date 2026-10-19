import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseFileLocation, terminalFileLinks, fileMatchScore } from '../src/shared/file-navigation';
import { legacyProfile } from '../src/main/profile';
import path from 'node:path';

test('terminal paths preserve Windows drive letters, quoted spaces, Unicode and line-column positions', () => {
  assert.deepEqual(parseFileLocation('C:\\work\\src\\app.ts:42:5'), { path: 'C:\\work\\src\\app.ts', line: 42, column: 5 });
  assert.deepEqual(parseFileLocation('"src/空 格.ts":12:3'), { path: 'src/空 格.ts', line: 12, column: 3 });
  assert.deepEqual(parseFileLocation('src/main.ts(8,4)'), { path: 'src/main.ts', line: 8, column: 4 });
  assert.deepEqual(parseFileLocation('file:///D:/Code/app.ts:7'), { path: 'D:/Code/app.ts', line: 7, column: 1 });
  const text = '错误 src/main.ts:42:5 and "docs/空 格.md" https://example.com/a.ts';
  const links = terminalFileLinks(text);
  assert.deepEqual(links.map(link => link.text), ['src/main.ts:42:5', '"docs/空 格.md"']);
  for (const link of links) assert.equal(text.slice(link.start, link.end), link.text);
  assert.equal(terminalFileLinks('plain terminal prose').length, 0);
  assert.deepEqual(terminalFileLinks('/src C:\\Work src/').map(item => item.text), ['/src', 'C:\\Work', 'src/']);
  assert.equal(terminalFileLinks('"src/空 格.ts":12:3')[0].text, '"src/空 格.ts":12:3');
  assert.equal(terminalFileLinks('x'.repeat(20000)).length, 0);
  assert.equal(parseFileLocation(terminalFileLinks('at src/app.ts(8,4)')[0].text).line, 8);
});
test('file matching prioritizes exact suffixes over fuzzy subsequences', () => {
  assert.ok(fileMatchScore('src/App.tsx', 'app.tsx') > fileMatchScore('src/Application.tsx', 'app'));
  assert.ok(fileMatchScore('src/renderer/App.tsx', 'srapp') >= 0);
  assert.equal(fileMatchScore('docs/README.md', 'xyz'), -1);
});
test('rebranding retains old installed and development profiles', () => {
  const base = path.resolve('profiles');
  assert.equal(legacyProfile(base, () => false), path.join(base, 'AgentBerth'));
  assert.equal(legacyProfile(base, name => name.endsWith('agentberth')), path.join(base, 'agentberth'));
  assert.equal(legacyProfile(base, () => true), path.join(base, 'AgentBerth'));
});
