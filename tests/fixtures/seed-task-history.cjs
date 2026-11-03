// Controlled UI fixture only: create a long task transcript without model calls.
const {DatabaseSync}=require('node:sqlite');
const {randomUUID}=require('node:crypto');
const db=new DatabaseSync(process.argv[2]);
try{
  db.exec('PRAGMA busy_timeout=5000;BEGIN IMMEDIATE');
  const insert=db.prepare('INSERT INTO task_messages(ticketId,value) VALUES (?,?)');
  for(let index=0;index<32;index++)insert.run(process.argv[3],JSON.stringify({id:randomUUID(),at:new Date().toISOString(),role:index%2?'assistant':'user',stage:'worker',text:'历史任务消息 '+index+'\n'+('用于验证向上滚动自动加载并保留阅读位置。'.repeat(8))}));
  db.exec('COMMIT');
}finally{db.close();}
