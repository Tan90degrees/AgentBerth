// Self-contained AgentBerth protocol v1 adapter. Import this script directly.
// Example format: PROJECT/agent-session.json and PROJECT/agent-sessions/*.json.
// Each JSON: { cwd, nativeSessionId, title?, messages: [{ role, text, timestamp? }] }.
// Adapt the reader and resume syntax to the actual CLI before shipping.
const fs = require('node:fs/promises');
const path = require('node:path');
const validId = value => typeof value === 'string' && /^[a-zA-Z0-9_-]{1,128}$/.test(value);
const same = (a,b) => process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
async function read(file, projectPath) {
  const info = await fs.stat(file);
  if (!info.isFile() || info.size > 16 * 1024 * 1024) throw new Error('Transcript must be a file under 16 MiB');
  const data = JSON.parse((await fs.readFile(file,'utf8')).replace(/^\uFEFF/,''));
  if (!validId(data.nativeSessionId) || !Array.isArray(data.messages) || typeof data.cwd !== 'string' || !path.isAbsolute(data.cwd)) throw new Error('Invalid transcript identity or messages');
  if (!same(await fs.realpath(data.cwd),await fs.realpath(projectPath))) throw new Error('Transcript belongs to a different project');
  return data;
}
async function catalog(projectPath) {
  const files = [path.join(projectPath,'agent-session.json')];
  const directory = path.join(projectPath,'agent-sessions');
  try { for (const item of await fs.readdir(directory,{withFileTypes:true})) if (item.isFile() && item.name.endsWith('.json')) files.push(path.join(directory,item.name)); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  files.sort();
  const byId = new Map(); let bytes = 0; let skipped = 0;
  for (const file of files.slice(0,1000)) {
    try {
      const info = await fs.stat(file); bytes += info.size;
      if (bytes > 64 * 1024 * 1024) { skipped++; break; }
      const data = await read(file,projectPath);
      const title = String(data.title || data.messages.find(message => message.role === 'user')?.text || data.nativeSessionId).slice(0,200);
      const item = { cwd:data.cwd,nativeSessionId:data.nativeSessionId,title,updatedAt:info.mtime.toISOString(),path:file };
      const previous = byId.get(item.nativeSessionId);
      if (!previous || item.updatedAt > previous.updatedAt) byId.set(item.nativeSessionId,item);
    } catch (error) { if (error.code !== 'ENOENT') skipped++; }
  }
  const items = [...byId.values()].sort((a,b) => b.updatedAt.localeCompare(a.updatedAt) || a.nativeSessionId.localeCompare(b.nativeSessionId));
  return {items,warnings:skipped || files.length>1000 ? ['Some records were invalid or exceeded the example scan budget; select a file explicitly if missing.'] : []};
}
let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => { input += chunk; if (input.length > 65536) process.exit(2); });
process.stdin.on('end', async () => {
  try {
    const request = JSON.parse(input);
    if (request.version !== 1) throw new Error('Unsupported protocol version');
    let result;
    if (request.method === 'describe') {
      result = {version:1,id:'my-agent',name:'我的 Agent',command:'my-agent',capabilities:{history:true,resume:true,list:true}};
    } else if (request.method === 'list') {
      const {cursor,limit,query} = request.pagination;
      if (!Number.isInteger(limit) || limit < 1 || limit > 50 || typeof query !== 'string') throw new Error('Invalid pagination');
      const all = await catalog(request.projectPath);
      const items = all.items.filter(item => (item.title+' '+item.nativeSessionId).toLowerCase().includes(query.toLowerCase()));
      let offset = 0;
      if (cursor !== null) {
        const after = JSON.parse(Buffer.from(cursor,'base64url').toString());
        if (after.query !== query || after.projectPath !== request.projectPath) throw new Error('Cursor expired; refresh the list');
        offset = items.findIndex(item => item.nativeSessionId === after.id && item.updatedAt === after.updatedAt)+1;
        if (!offset) throw new Error('Records changed; refresh the list');
      }
      const page = items.slice(offset,offset+limit), last = page.at(-1);
      const nextCursor = offset+limit<items.length ? Buffer.from(JSON.stringify({id:last.nativeSessionId,updatedAt:last.updatedAt,query,projectPath:request.projectPath})).toString('base64url') : null;
      result = {version:1,items:page,nextCursor,total:items.length,warnings:all.warnings};
    } else if (request.method === 'history') {
      let file = request.path;
      if (!file) {
        const {items} = await catalog(request.projectPath);
        const id = request.session.nativeSessionId;
        if (!id && items.length !== 1) throw new Error('Choose a conversation from the list before reading history');
        file = (id ? items.find(item => item.nativeSessionId === id) : items[0])?.path;
        if (!file) throw new Error('Conversation not found; refresh the list or select its transcript');
      }
      const data = await read(file,request.projectPath);
      if (request.session.nativeSessionId && !request.path && data.nativeSessionId !== request.session.nativeSessionId) throw new Error('Conversation ID mismatch');
      const messages = []; let bytes = 0;
      for (const message of data.messages.filter(message => ['user','assistant'].includes(message.role) && typeof message.text === 'string').slice(-1000).reverse()) {
        const item = {role:message.role,text:message.text.slice(0,32768),timestamp:typeof message.timestamp === 'string' ? message.timestamp : null};
        bytes += Buffer.byteLength(JSON.stringify(item));
        if (bytes > 512*1024) break;
        messages.unshift(item);
      }
      result = {version:1,cwd:data.cwd,nativeSessionId:data.nativeSessionId,path:file,messages,warnings:bytes>512*1024?['Only recent conversation text is shown.']:[]};
    } else if (request.method === 'resume') {
      const id = request.session.nativeSessionId;
      if (!validId(id)) throw new Error('Invalid native session ID');
      result = {version:1,command:request.session.command+' --resume '+id};
    } else throw new Error('Unsupported method');
    process.stdout.write(JSON.stringify(result));
  } catch (error) { console.error(error.message); process.exitCode = 1; }
});
