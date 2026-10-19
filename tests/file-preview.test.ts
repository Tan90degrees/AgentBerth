import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileLanguage, fileSize, isMarkdown, previewLink } from '../src/shared/file-preview';
import { highlightCode } from '../src/renderer/syntax';

test('file languages cover common code, terminal scripts and extensionless build files', () => {
  for (const [filename, language] of [['src/APP.TSX', 'typescript'], ['tool.ps1', 'powershell'], ['Dockerfile.dev', 'dockerfile'], ['Makefile', 'makefile'], ['CMakeLists.txt', 'cmake'], ['.env.local', 'ini'], ['README.md', 'markdown'], ['file.unknown', 'plaintext']]) assert.equal(fileLanguage(filename), language);
  assert.equal(isMarkdown('README.MD'), true); assert.equal(isMarkdown('code.mdx'), false);
  assert.equal(fileSize(1024), '1.0 KB');
});
test('relative Markdown navigation resolves encoded names and anchors without escaping the project', () => {
  assert.deepEqual(previewLink('docs/intro.md', '../src/code.ts'), { path: 'src/code.ts', anchor: '' });
  assert.deepEqual(previewLink('docs/intro.md', '/docs/%E4%B8%AD%E6%96%87.md#标题'), { path: 'docs/中文.md', anchor: '标题' });
  assert.deepEqual(previewLink('docs/intro.md', '#section'), { path: 'docs/intro.md', anchor: 'section' });
  for (const link of ['../../outside', '%2e%2e/%2e%2e/secret', '..%5Csecret', 'javascript:alert(1)', 'data:text/html,hi', 'file:///secret', 'C:\\Windows', '//example.test/image', '%00secret', 'bad%GG']) assert.equal(previewLink('docs/intro.md', link), null, link);
});
test('syntax highlighting emits tokens and keeps embedded HTML inert, including fallback languages', () => {
  assert.match(highlightCode('export const count: number = 42;', 'typescript'), /hljs-keyword/);
  assert.match(highlightCode('$value = Get-Process', 'powershell'), /hljs/);
  for (const language of ['plaintext', 'unknown-language', 'xml']) {
    const html = highlightCode('<img src=x onerror="alert(1)">', language);
    assert.ok(!html.includes('<img')); assert.ok(html.includes('&lt;'));
  }
});

test('full syntax set covers structured configuration and language aliases beyond the common bundle', async () => {
  const { syntaxLanguages } = await import('../src/shared/syntax-languages');
  assert.equal(syntaxLanguages.length, 192);
  for (const [name, language, code] of [
    ['app.json', 'json', '{"enabled":true,"count":42}'],
    ['app.yaml', 'yaml', 'enabled: true\ncount: 42'], ['app.toml', 'ini', '[app]\nenabled = true'],
    ['main.scala', 'scala', 'object Main { val count = 42 }'], ['main.dart', 'dart', 'void main() { final count = 42; }'],
    ['main.hs', 'haskell', 'module Main where\nmain = print 42'], ['main.ex', 'elixir', 'defmodule Main do\nend'],
    ['kernel.cu', 'cpp', '__global__ void kernel() {}'],
  ]) {
    assert.equal(fileLanguage(name), language, name);
    assert.match(highlightCode(code, language), /hljs-/, name);
  }
  assert.equal(fileLanguage('script', '#!/usr/bin/env python3\nprint(42)'), 'python');
  assert.equal(fileLanguage('nginx.conf'), 'nginx');
});
