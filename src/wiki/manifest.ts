import { extensionManifestSchema } from '../shared/extensions';

// The API key is deliberately NOT a manifest config field: ExtensionManager
// renders config as plain text inputs. It lives in the plugin's private
// credentials.json and is edited from the wiki view's Settings tab.
export const notesWikiManifest = extensionManifestSchema.parse({
  apiVersion: 1,
  version: '1.0.0',
  entry: 'builtin',
  id: 'notes-wiki',
  name: '笔记 Wiki',
  icon: 'book',
  description: '以 LLM Wiki 方式编译笔记：原始素材只读、模型维护双向链接页面、编译结果人工审阅，可接入文本与视觉模型并自定义工作流 Skill。',
  dependencies: [],
  config: {
    authRequired: { type: 'boolean', title: '服务需要 API Key', description: '本地 Ollama、LM Studio 等无鉴权服务可关闭；公网服务通常需要开启。', default: true },
    baseURL: { type: 'string', title: '文本模型服务地址', description: '任意 OpenAI 兼容 /chat/completions 端点，例如 https://api.openai.com/v1、DeepSeek、Groq、Ollama 或 LM Studio。', default: 'https://api.openai.com/v1' },
    textModel: { type: 'string', title: '文本模型', description: '用于摄入、编译、问答与体检。', default: 'gpt-4o-mini' },
    visionBaseURL: { type: 'string', title: '图片模型服务地址', description: '留空使用文本模型服务地址；填写独立地址时使用独立的图片 API Key。', default: '' },
    visionAuthRequired: { type: 'boolean', title: '独立图片服务需要 API Key', default: true },
    llmRetries: { type: 'number', title: 'LLM 调用重试次数', description: '额外重试次数，仅重试限流、网络和服务端临时错误；0 表示不重试。', default: 2, minimum: 0, maximum: 8 },
    llmConcurrency: { type: 'number', title: 'LLM 最大并发请求数', default: 2, minimum: 1, maximum: 16 },
    visionModel: { type: 'string', title: '视觉模型', description: '用于理解素材中的图片；留空则跳过图片理解。', default: 'gpt-4o-mini' },
    autoCompile: { type: 'boolean', title: '新素材自动编译', description: '新增素材后自动生成待审阅提案（不会自动发布）。', default: true },
    allowAgentAccess: { type: 'boolean', title: '允许 Agent 读取全局知识库', description: '默认关闭。启用后，所有连接工作台 MCP 的 Agent 均可读取此知识库的页面、原始素材及问答任务；知识库不按项目隔离。', default: false },
    allowAgentQueries: { type: 'boolean', title: '允许 Agent 调用模型提问', description: '需先允许 Agent 读取。启用后，Agent 可使用本机配置的模型凭据发起请求并产生费用。', default: false },
    lintMinutes: { type: 'number', title: '自动体检间隔（分钟）', description: '0 表示关闭；建议 60–1440。', default: 0, minimum: 0, maximum: 10080 },
    maxContextPages: { type: 'number', title: '提问时读取的页面数', description: '按关键词与链接相关度取前 N 页。', default: 8, minimum: 1, maximum: 20 },
  },
  views: [{ id: 'wiki', title: '知识库', location: 'sidebar', entry: 'builtin' }],
});
