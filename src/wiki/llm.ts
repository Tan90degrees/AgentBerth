// A deliberately small OpenAI-compatible client. AgentBerth does not ship an
// LLM SDK; the wiki talks to any endpoint that implements /chat/completions
// (OpenAI, DeepSeek, Groq, vLLM, LM Studio, Ollama's OpenAI shim, ...).
export interface LlmImage { mime: string; base64: string }
export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string | ({ type: 'text'; text: string } | { type: 'image_url'; image_url: { url: string } })[];
}
export interface ChatOptions {
  baseURL: string;
  apiKey: string;
  model: string;
  messages: ChatMessage[];
  images?: LlmImage[];
  temperature?: number;
  timeoutMs?: number;
  signal?: AbortSignal;
  fetchImpl?: typeof fetch;
}

export function completionUrl(baseURL: string): string {
  const value = String(baseURL ?? '').trim().replace(/\/+$/, '');
  if (!value) throw new Error('请先在设置中填写模型服务地址');
  let url: URL;
  try { url = new URL(value); } catch { throw new Error('模型服务地址不是有效的 URL'); }
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error('模型服务地址只支持 HTTP / HTTPS');
  if (url.pathname.endsWith('/chat/completions')) { url.search = ''; return url.toString(); }
  url.pathname = url.pathname.replace(/\/+$/, '') + '/chat/completions';
  url.search = '';
  return url.toString();
}

export function userMessage(text: string, images: LlmImage[] = []): ChatMessage {
  if (!images.length) return { role: 'user', content: text };
  return {
    role: 'user',
    content: [
      { type: 'text', text },
      ...images.map(image => ({ type: 'image_url' as const, image_url: { url: `data:${image.mime};base64,${image.base64}` } })),
    ],
  };
}

/** Model proxies sometimes echo request headers in their error body. Never let
 * the API key travel back through task errors, lint suggestions or the view. */
function redact(text: string, apiKey: string): string {
  let value = String(text ?? '');
  if (apiKey) value = value.split(apiKey).join('[已隐藏]');
  return value.replace(/Bearer\s+[A-Za-z0-9._+/\-=]+/gi, 'Bearer [已隐藏]');
}

function contentText(value: unknown): string {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return value.map(part => typeof part === 'object' && part && 'text' in part ? String((part as { text: unknown }).text ?? '') : '').join('');
  return '';
}

export async function chat(options: ChatOptions): Promise<string> {
  if (!options.apiKey.trim()) throw new Error('请先在「设置」中填写 API Key');
  if (!options.model.trim()) throw new Error('请先在「设置」中填写模型名称');
  const url = completionUrl(options.baseURL);
  const messages = options.messages.slice();
  if (options.images?.length && messages.length) {
    const last = messages.at(-1)!;
    if (last.role === 'user') messages[messages.length - 1] = userMessage(contentText(last.content), options.images);
  }
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(new Error('模型响应超时')), options.timeoutMs ?? 110000);
  const onAbort = () => controller.abort(options.signal?.reason);
  options.signal?.addEventListener('abort', onAbort, { once: true });
  if (options.signal?.aborted) controller.abort(options.signal.reason);
  try {
    const response = await (options.fetchImpl ?? fetch)(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${options.apiKey}` },
      body: JSON.stringify({ model: options.model, messages, temperature: options.temperature ?? 0.2, stream: false }),
      signal: controller.signal,
    });
    if (!response.ok) {
      const detail = redact((await response.text().catch(() => '')).slice(0, 400), options.apiKey);
      throw new Error(`模型请求失败（HTTP ${response.status}）：${detail || '服务未返回错误详情'}`);
    }
    const payload = await response.json() as { choices?: { message?: { content?: unknown } }[]; error?: { message?: string } };
    if (payload.error?.message) throw new Error('模型服务返回错误：' + redact(payload.error.message.slice(0, 300), options.apiKey));
    const text = contentText(payload.choices?.[0]?.message?.content).trim();
    if (!text) throw new Error('模型返回了空内容');
    return text;
  } catch (error) {
    if (controller.signal.aborted && !options.signal?.aborted) throw new Error('模型响应超时，请检查服务地址或稍后重试');
    throw error;
  } finally {
    clearTimeout(timeout);
    options.signal?.removeEventListener('abort', onAbort);
  }
}

export function maskedKey(apiKey: string): string {
  if (!apiKey) return '未配置';
  if (apiKey.length <= 8) return '已配置 · 已隐藏';
  return `已配置 ····${apiKey.slice(-4)}`;
}
