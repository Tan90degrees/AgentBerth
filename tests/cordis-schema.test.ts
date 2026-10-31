import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import os from 'node:os';
import path from 'node:path';
import { Store } from '../src/daemon/store';

test('Cordis-only store rejects old databases without migrating or deleting them', t=>{
  const root=mkdtempSync(path.join(os.tmpdir(),'berth-schema-refusal-'));
  t.after(()=>rmSync(root,{recursive:true,force:true,maxRetries:5,retryDelay:100}));
  const file=path.join(root,'berth.sqlite');
  const db=new DatabaseSync(file);
  db.exec('CREATE TABLE previous_data(value TEXT); INSERT INTO previous_data(value) VALUES (\'retained\'); PRAGMA user_version=5;');
  db.close();
  assert.throws(()=>new Store(root),/旧版 AgentBerth 数据.*清除旧数据目录/);
  const reopened=new DatabaseSync(file);
  assert.equal(reopened.prepare('SELECT value FROM previous_data').get()?.value,'retained');
  assert.equal(Number(reopened.prepare('PRAGMA user_version').get()?.user_version),5);
  reopened.close();
});

test('fresh stores carry schema 6 and reopen normally', t=>{
  const root=mkdtempSync(path.join(os.tmpdir(),'berth-schema-fresh-'));
  t.after(()=>rmSync(root,{recursive:true,force:true,maxRetries:5,retryDelay:100}));
  let store=new Store(root);
  store.createProject('fresh',root);
  store.close();
  assert.equal(existsSync(path.join(root,'berth.sqlite')),true);
  const db=new DatabaseSync(path.join(root,'berth.sqlite'));
  assert.equal(Number(db.prepare('PRAGMA user_version').get()?.user_version),6);
  db.close();
  store=new Store(root);
  assert.equal(store.state().projects.length,1);
  store.close();
});
