import { useEffect, useMemo, useRef, useState } from 'react';
import type { GitDiff, GitDiffRequest } from '../shared/protocol';
import { parseDiff } from '../shared/git-diff';
import { previewStyle, usePreviewAppearance } from './preview-settings';

export default function GitDiffPreview({ request, connected, onChange, onBack }: { request: GitDiffRequest; connected: boolean; onChange: (staged: boolean) => void; onBack: () => void }) {
  const [diff, setDiff] = useState<GitDiff | null>(null), [error, setError] = useState(''), [revision, setRevision] = useState(0), [loading, setLoading] = useState(false);
  const generation = useRef(0), appearance = usePreviewAppearance();
  useEffect(() => {
    const update = () => setRevision(value => value + 1);
    window.addEventListener('berth:git-refresh', update);
    window.addEventListener('focus', update);
    return () => { window.removeEventListener('berth:git-refresh', update); window.removeEventListener('focus', update); };
  }, []);
  useEffect(() => {
    const token = ++generation.current; setDiff(null); setError('');
    if (!connected) { setLoading(false); return; }
    setLoading(true);
    void window.berth.rpc<GitDiff>('gitDiff', request).then(value => { if (generation.current === token) setDiff(value); }).catch(reason => { if (generation.current === token) setError(String(reason).replace(/^Error: /, '')); }).finally(() => { if (generation.current === token) setLoading(false); });
    return () => { generation.current++; };
  }, [request.projectId, request.path, request.staged, request.projectPath, connected, revision]);
  const parsed = useMemo(() => parseDiff(diff?.patch ?? ''), [diff?.patch]);
  return <section className="file-preview-pane git-diff-pane" aria-label="Git 差异预览" aria-busy={loading} style={previewStyle(appearance)}>
    <div className="file-preview-tools"><span className="file-relative-path" title={diff?.path ?? request.path}>{diff?.path ?? request.path}</span>
      <div className="file-preview-modes" role="group" aria-label="Git 差异比较"><button aria-pressed={!request.staged} onClick={() => onChange(false)}>未暂存</button><button aria-pressed={request.staged} onClick={() => onChange(true)}>已暂存</button></div>
      <button onClick={onBack}>返回文件预览</button><button className="icon-button" aria-label="刷新 Git 差异" disabled={!connected || loading} onClick={() => setRevision(value => value + 1)}>↻</button>
    </div>
    <p className="diff-comparison-label">{request.staged ? 'HEAD → 暂存区' : '暂存区 → 工作目录'}{diff?.binary ? ' · 二进制文件已更改' : ''}</p>
    {(diff?.truncated || parsed.truncated) && <p className="file-preview-notice" role="status">差异较大，仅显示前一部分；完整内容可在终端使用 git diff 查看。</p>}
    {error ? <div className="file-preview-error" role="alert">{error}<button disabled={!connected} onClick={() => setRevision(value => value + 1)}>重试</button></div> : !diff?.patch ? <div className="file-preview-empty" role="status">{loading ? '正在读取差异…' : !connected ? '后台连接已断开' : diff?.message ?? '没有差异'}</div> : <div className="git-diff-scroll" tabIndex={0} aria-label="文件差异"><div className="diff-lines">{parsed.lines.map((line, index) => <div className={`diff-line diff-${line.kind}`} key={index}><span className="diff-number" aria-hidden="true">{line.oldLine ?? ''}</span><span className="diff-number" aria-hidden="true">{line.newLine ?? ''}</span><span className="diff-sign" aria-hidden="true">{line.kind === 'add' ? '+' : line.kind === 'remove' ? '−' : ' '}</span><span className="diff-text">{line.text || ' '}</span></div>)}</div></div>}
  </section>;
}
