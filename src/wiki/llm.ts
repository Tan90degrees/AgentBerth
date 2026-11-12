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
  authRequired?: boolean;
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
  if (url.username || url.password) throw new Error('请通过 API Key 配置凭据，服务地址不能包含用户名或密码');
  url.hash = '';
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

/** Some compatible proxies send SSE/NDJSON despite stream:false. Decode the
 * whole envelope explicitly so transport errors cannot masquerade as draft JSON. */
interface ChatPayload {
  choices?: { message?: { content?: unknown }; delta?: { content?: unknown }; finish_reason?: string }[];
  error?: { message?: string };
}
function responsePayload(raw: string, contentType: string): ChatPayload {
  try {
    const value: unknown = JSON.parse(raw);
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error();
    return value as ChatPayload;
  } catch { /* Check supported framed responses. */ }
  const sse = /^\s*(?:data:|event:|:)/m.test(raw), ndjson = /ndjson|jsonl/i.test(contentType);
  if (!sse && !ndjson) throw new Error('模型接口未返回合法 JSON；请检查是否使用兼容的 /chat/completions 地址及代理配置');
  const frames = sse ? raw.replaceAll('\r\n', '\n').split(/\n\s*\n/).flatMap(block => {
    const rows = block.split('\n').filter(line => line.startsWith('data:'));
    return rows.length ? [rows.map(line => line.slice(5).trimStart()).join('\n')] : [];
  }) : raw.split(/\r?\n/).filter(line => line.trim());
  const chunks: string[] = [];
  let finished = false, seen = false;
  for (const frame of frames) {
    if (frame.trim() === '[DONE]') { finished = true; continue; }
    let value: ChatPayload;
    try { value = JSON.parse(frame) as ChatPayload; }
    catch { throw new Error('模型接口的流式 JSON 数据不完整或格式无效，请检查服务或代理'); }
    if (!value || typeof value !== 'object') throw new Error('模型接口返回了无效的数据帧');
    if (value.error?.message) return value;
    const choice = value.choices?.[0];
    if (!choice) continue;
    seen = true;
    if (choice.finish_reason === 'length') throw new Error('模型输出达到服务端长度限制而被截断，请提高输出 token 上限或调整模型后重试；原始素材已保留');
    if (choice.finish_reason) finished = true;
    chunks.push(contentText(choice.delta?.content ?? choice.message?.content));
  }
  if (!seen || !finished) throw new Error('模型接口的流式响应未完整结束，素材已保留，请重试');
  return { choices: [{ message: { content: chunks.join('') } }] };
}

export async function chat(options: ChatOptions): Promise<string> {
  if (options.authRequired !== false && !options.apiKey.trim()) throw new Error('请先在「设置」中填写 API Key');
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
      headers: { 'Content-Type': 'application/json', ...(options.authRequired !== false && options.apiKey.trim() ? { Authorization: `Bearer ${options.apiKey}` } : {}) },
      body: JSON.stringify({ model: options.model, messages, temperature: options.temperature ?? 0.2, stream: false }),
      signal: controller.signal,
    });
    if (!response.ok) {
      const detail = redact(await response.text().catch(() => ''), options.apiKey).slice(0, 400);
      throw new Error(`模型请求失败（HTTP ${response.status}）：${detail || '服务未返回错误详情'}`);
    }
    const payload = responsePayload(await response.text(),response.headers.get('content-type')??'');
    if (payload.error?.message) throw new Error('模型服务返回错误：' + redact(payload.error.message, options.apiKey).slice(0, 300));
    if(payload.choices?.[0]?.finish_reason==='length')throw new Error('模型输出达到服务端长度限制而被截断，请提高输出 token 上限或调整模型后重试；原始素材已保留');
    const text = contentText(payload.choices?.[0]?.message?.content).trim();
    if (!text) throw new Error('模型返回了空内容');
    return text;
  } catch (error) {
    if (controller.signal.aborted && !options.signal?.aborted) throw new Error('模型响应超时，请检查服务地址或稍后重试');
    throw new Error(redact(error instanceof Error ? error.message : String(error), options.apiKey));
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
