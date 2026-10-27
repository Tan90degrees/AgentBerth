import { useEffect, useRef, useState } from 'react';
import type { History, NativeHistoryPage, Session } from '../shared/protocol';
import { HistoryDiagnostics } from './HistoryDiagnostics';

const emptyPage: NativeHistoryPage = { items: [], nextCursor: null, warnings: [] };
const date = (value: string | null) => value ? new Date(value).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }) : '';
export function HistoryPanel({ session, history, label, canHistory, canAssociate, canDiscover, autoRead, supported, disabled, onImport, onRefresh, onManual, onLink, onUnlink, onCopy }: {
  session: Session; history: History | null; label: string; canHistory: boolean; canAssociate: boolean; canDiscover: boolean; autoRead: boolean; supported: boolean; disabled: boolean;
  onImport: () => Promise<void>; onRefresh: () => Promise<void>; onManual: () => void;
  onLink: (id: string) => Promise<History | undefined>; onUnlink: () => Promise<History | undefined>; onCopy: (id: string) => void;
}) {
  const [source, setSource] = useState<'saved' | 'discover'>('saved');
  const [query, setQuery] = useState('');
  const [limit, setLimit] = useState(5);
  const [cursors, setCursors] = useState<(string | null)[]>([null]);
  const [revision, setRevision] = useState(0);
  const [page, setPage] = useState<NativeHistoryPage>(emptyPage);
  const [loading, setLoading] = useState(false);
  const [working, setWorking] = useState(false);
  const [error, setError] = useState('');
  const [preview, setPreview] = useState<History | null>(null);
  const request = useRef(0);
  const listing = useRef<Promise<unknown>>(Promise.resolve());
  useEffect(() => () => { request.current++; }, []);
  useEffect(() => { request.current++; setPreview(null); setWorking(false); setCursors([null]); setRevision(value => value + 1); }, [history]);
  const cursor = cursors.at(-1) ?? null;
  useEffect(() => {
    if (!supported) return;
    let canceled = false;
    setLoading(true); setError('');
    const timer = setTimeout(() => {
      const pending = listing.current.catch(() => {}).then(() => canceled ? undefined : window.berth.rpc<NativeHistoryPage>(source === 'saved' ? 'nativeHistories' : 'discoverNativeHistories', { sessionId: session.id, cursor, limit, query }));
      listing.current = pending;
      void pending.then(value => {
        if (canceled || !value) return;
        if (value.nextCursor && cursors.includes(value.nextCursor)) throw new Error('插件返回了循环分页游标，请更新适配器后刷新');
        setPage(value);
      }).catch(reason => { if (!canceled) { setError(String(reason)); setPage(emptyPage); } }).finally(() => { if (!canceled) setLoading(false); });
    }, 180);
    return () => { canceled = true; clearTimeout(timer); };
  }, [session.id, source, query, limit, cursor, revision, supported]);
  async function show(id: string, refresh = false) {
    const token = ++request.current;
    setWorking(true); setError('');
    try { const value = await window.berth.rpc<History>('nativeHistory', { sessionId: session.id, nativeSessionId: id, refresh }); if (request.current === token) setPreview(value); }
    catch (reason) { if (request.current === token) setError(String(reason)); }
    finally { if (request.current === token) setWorking(false); }
  }
  async function associate(id: string | null) {
    const token = ++request.current;
    setWorking(true); setError('');
    try {
      if (id && source === 'discover') await window.berth.rpc('nativeHistory', { sessionId: session.id, nativeSessionId: id });
      if (request.current !== token) return;
      const value = id ? await onLink(id) : await onUnlink();
      if (value && request.current === token) { setPreview(null); setCursors([null]); setRevision(value => value + 1); }
    }
    catch (reason) { if (request.current === token) setError(String(reason)); }
    finally { if (request.current === token) setWorking(false); }
  }
  const blocked = disabled || working || (source === 'discover' && loading);
  const shown = preview ?? history;
  const selectedId = shown?.nativeSessionId;
  const linked = selectedId === session.nativeSessionId && !!selectedId;
  return <div className="history-panel">
    <div className="panel-toolbar"><span>原生对话历史</span><div>
      <button className="subtle" disabled={blocked || (!session.transcriptPath && !autoRead)} onClick={() => void onRefresh()}>{history?.messages.length || session.transcriptPath ? '刷新记录' : '读取对话'}</button>
      <button className="subtle" disabled={blocked || !canAssociate || (!supported && ['running', 'stopping'].includes(session.latestRun?.status ?? ''))} onClick={onManual}>关联会话 ID</button>
      <button className="subtle" disabled={blocked || !canHistory} onClick={() => void onImport()}>{session.agent.startsWith('agent:') ? '选择记录文件' : session.agent === 'opencode' ? '关联 JSON' : '关联 JSONL'}</button>
    </div></div>
    {supported ? <section className="native-browser" aria-label="原生会话列表">
      <div className="native-browser-controls"><div className="native-sources" role="group" aria-label="历史来源"><button className={source === 'saved' ? 'selected' : ''} aria-pressed={source === 'saved'} disabled={blocked} onClick={() => { setSource('saved'); setCursors([null]); }}>已保存的会话</button>{canDiscover && <button className={source === 'discover' ? 'selected' : ''} aria-pressed={source === 'discover'} disabled={blocked} onClick={() => { setSource('discover'); setCursors([null]); }}>发现会话</button>}</div><input aria-label="搜索原生会话" value={query} maxLength={100} onChange={event => { setQuery(event.target.value); setCursors([null]); }} placeholder="搜索标题或会话 ID" /><button className="subtle" disabled={blocked || loading} onClick={() => { setCursors([null]); setRevision(value => value + 1); }}>刷新列表</button></div>
      <div className="native-list" aria-busy={loading}>
        {loading ? <p className="native-list-hint" role="status">正在读取会话列表…</p> : page.items.map(item => <div className={`native-item ${selectedId === item.nativeSessionId ? 'selected' : ''}`} key={item.nativeSessionId} data-native-id={item.nativeSessionId}>
          <button className="native-preview" disabled={blocked} aria-label={`预览会话 ${item.nativeSessionId}`} onClick={() => void show(item.nativeSessionId)}><strong>{item.title}</strong><code>{item.nativeSessionId}</code></button><time title={item.updatedAt ?? ''}>{date(item.updatedAt)}</time>{session.nativeSessionId === item.nativeSessionId ? <><span className="badge live-badge">已关联</span><button className="subtle" disabled={blocked} aria-label={`解除关联 ${item.nativeSessionId}`} onClick={() => void associate(null)}>解除关联</button></> : <button className="subtle" disabled={blocked || !canAssociate} aria-label={`关联会话 ${item.nativeSessionId}`} onClick={() => void associate(item.nativeSessionId)}>关联</button>}
        </div>)}
        {!loading && !page.items.length && <p className="native-list-hint">{query ? '没有匹配的会话，试试其他标题或 ID。' : source === 'discover' ? '插件没有发现当前项目的会话，可刷新或导入记录文件。' : '尚无保存的会话。可导入多个记录文件、手动关联 ID，或使用发现会话。'}{!canDiscover && !query && '插件实现 list 接口后，还可自动发现多条会话。'}</p>}
      </div>
      <div className="native-pagination"><span>{page.total === undefined ? '' : `共 ${page.total} 条 · `}第 {cursors.length} 页</span><label>每页<select aria-label="原生会话每页条数" value={limit} disabled={blocked} onChange={event => { setLimit(Number(event.target.value)); setCursors([null]); }}>{[5,10,20].map(size => <option key={size} value={size}>{size} 条</option>)}</select></label><button className="subtle" disabled={blocked || loading || cursors.length < 2} onClick={() => setCursors(value => value.slice(0,-1))}>上一页</button><button className="subtle" disabled={blocked || loading || !page.nextCursor} onClick={() => setCursors(value => [...value, page.nextCursor])}>下一页</button></div>
    </section> : <p className="native-list-hint">更新后台后可浏览多条会话、分页和解除关联。</p>}
    {error && <p className="inline-error" role="alert">{error.replace(/^Error: /,'')}</p>}
    {session.nativeSessionId && <div className="history-meta"><div className="history-id"><span>当前关联：</span><code>{session.nativeSessionId}</code><button className="text-button" onClick={() => onCopy(session.nativeSessionId!)}>复制 ID</button>{supported && <button className="text-button" disabled={blocked} onClick={() => void associate(null)}>解除当前关联</button>}</div>{['running', 'stopping'].includes(session.latestRun?.status ?? '') && <small>运行中可更新关联；新的 ID 用于历史查看和下次恢复，不切换当前 CLI。</small>}</div>}
    {preview && <div className="history-meta"><div className="history-id"><span>{linked ? '查看已关联会话' : '预览会话（尚未关联）'}：</span><code>{selectedId}</code>{canHistory && <button className="text-button" disabled={blocked} onClick={() => void show(selectedId!, true)}>刷新此会话</button>}{!linked && <button className="text-button" disabled={blocked || !canAssociate} onClick={() => void associate(selectedId!)}>关联此会话</button>}<button className="text-button" onClick={() => { request.current++; setPreview(null); }}>返回当前关联</button></div></div>}
    <HistoryDiagnostics key={`${session.id}:${source}:${selectedId??''}:${shown?.path??''}`} path={working?null:shown?.path} warnings={[...(supported&&!loading?page.warnings:[]),...(!working?shown?.warnings??[]:[])]} />
    <div className="messages">{working ? <p className="native-list-hint" role="status">正在读取会话…</p> : shown?.messages.length ? shown.messages.map((message,index) => <article className={`message ${message.role}`} key={index}><header><strong>{message.role === 'user' ? '你' : label}</strong><time>{date(message.timestamp)}</time></header><p>{message.text}</p></article>) : <div className="empty-page"><h2>{selectedId ? '尚无对话文本' : '选择一条原生会话'}</h2><p>{selectedId ? '可刷新已关联记录，或选择原生记录文件导入。' : '导入的多个会话会分别保留。点选可预览，点击关联用于下次恢复。'}</p></div>}</div>
  </div>;
}
