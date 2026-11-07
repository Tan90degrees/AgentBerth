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
    baseURL: { type: 'string', title: '模型服务地址', description: '任意 OpenAI 兼容 /chat/completions 端点，例如 https://api.openai.com/v1、DeepSeek、Groq、Ollama 或 LM Studio。', default: 'https://api.openai.com/v1' },
    textModel: { type: 'string', title: '文本模型', description: '用于摄入、编译、问答与体检。', default: 'gpt-4o-mini' },
    visionModel: { type: 'string', title: '视觉模型', description: '用于理解素材中的图片；留空则跳过图片理解。', default: 'gpt-4o-mini' },
    autoCompile: { type: 'boolean', title: '新素材自动编译', description: '新增素材后自动生成待审阅提案（不会自动发布）。', default: true },
    autoApprove: { type: 'boolean', title: '自动发布提案', description: '默认关闭：编译结果需要人工审阅，避免模型误读扩散。', default: false },
    lintMinutes: { type: 'number', title: '自动体检间隔（分钟）', description: '0 表示关闭；建议 60–1440。', default: 0, minimum: 0, maximum: 10080 },
    maxContextPages: { type: 'number', title: '提问时读取的页面数', description: '按关键词与链接相关度取前 N 页。', default: 8, minimum: 1, maximum: 20 },
  },
  views: [{ id: 'wiki', title: '知识库', location: 'sidebar', entry: 'builtin' }],
});
