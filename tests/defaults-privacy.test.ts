import { test } from 'node:test';
import assert from 'node:assert/strict';
import { globSync, readFileSync } from 'node:fs';
import { DEFAULT_SETTINGS } from '../src/shared/protocol';

test('shipped examples contain only neutral network addresses and no credential defaults', () => {
  const files=[...globSync('src/**/*.{ts,tsx}'),...globSync('docs/**/*.md'),...globSync('examples/**/*.{json,js,cjs,mjs}'),'README.md'];
  for (const file of files) {
    const text=readFileSync(file,'utf8');
    for (const match of text.matchAll(/\b(?:\d{1,3}\.){3}\d{1,3}\b/g)) {
      const address=match[0];
      assert.ok(address.startsWith('127.') || address==='0.0.0.0' || /^(192\.0\.2|198\.51\.100|203\.0\.113)\./.test(address), `Use loopback or RFC documentation addresses in ${file}`);
    }
    assert.ok(!/-----BEGIN (?:OPENSSH|RSA|EC) PRIVATE KEY-----/.test(text),`No private keys in ${file}`);
  }
  assert.equal(DEFAULT_SETTINGS.terminal.executable,'');
  assert.equal(DEFAULT_SETTINGS.defaultCommand,'');
});
