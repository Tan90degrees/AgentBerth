const fs = require('node:fs');
const path = require('node:path');
exports.apply = (ctx, config) => {
  const file = path.join(ctx.berth.dataDirectory, 'receipts.json');
  let receipts = {};
  try { receipts = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  const source = ctx.berth.source({
    id: 'local', name: '本地模拟源', description: '只用于验证协议；通过 emit 命令提交事件。',
    // These values belong to each pipeline, not to this plugin's global config.
    pipelineConfigSchema: {
      requiredText: {type:'string',title:'消息需包含',description:'仅此管道的来源规则；留空不过滤。',default:''},
      minLength: {type:'number',title:'最短正文长度',minimum:0,maximum:16000,default:0},
      allowMessages: {type:'boolean',title:'接收消息',default:true},
      textField: {type:'string',title:'匹配字段',enum:['text','title'],default:'text'},
    },
    match(event, {config}, signal) {
      if(signal.aborted)throw new Error('来源已停止');
      return config.allowMessages && event.text.length >= config.minLength && (!config.requiredText || event[config.textField].includes(config.requiredText));
    },
    async listThreads(signal) {
      if (signal.aborted) throw new Error('来源已停止');
      return [{id:'thread-1',name:'本地演示会话'}, {id:'thread-2',name:'另一组演示会话'}];
    },
    async reply(message, signal) {
      if (signal.aborted) throw new Error('来源已停止');
      // A real adapter must implement this same deduplication against its
      // channel's durable receipt. No real message is sent by this example.
      if (receipts[message.idempotencyKey]) return { receipt: receipts[message.idempotencyKey].receipt };
      const receipt = 'local:' + message.idempotencyKey;
      receipts[message.idempotencyKey] = { ...message, receipt };
      fs.writeFileSync(file + '.tmp', JSON.stringify(receipts, null, 2));
      fs.renameSync(file + '.tmp', file);
      if (config.loseAck) throw new Error('模拟：消息已接收，但回执丢失');
      return { receipt };
    },
  });
  ctx.berth.command({
    name: 'emit', description: '向 Superagent 提交一个本地模拟事件。未映射项目时应保留原事件 ID 重试。',
    inputSchema: { type: 'object', additionalProperties: false, properties: {
      id: { type: 'string', minLength: 1, maxLength: 200 }, threadId: { type: 'string', minLength: 1, maxLength: 500 },
      actorId: { type: 'string', minLength: 1, maxLength: 200 }, title: { type: 'string', minLength: 1, maxLength: 100 },
      text: { type: 'string', minLength: 1, maxLength: 16000 },
    }, required: ['id', 'threadId', 'actorId', 'title', 'text'] },
  }, event => source.emit(event));
};
