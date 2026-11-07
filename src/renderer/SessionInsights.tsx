import { useEffect, useRef, useState } from 'react';
import type { AgentDefinition, DeletionUndo, History, Run, Session, WindowsPty } from '../shared/protocol';
import { HistoryPanel } from './HistoryPanel';
import { RunHistory } from './RunHistory';

export interface SessionInsightsProps {
  session: Session;
  projectPath: string;
  definition?: AgentDefinition;
  label: string;
  tab: 'history' | 'runs';
  apiVersion: number;
  connected: boolean;
  canHistory: boolean;
  canResume: boolean;
  disabled: boolean;
  windowsPty?: WindowsPty;
  fontSize: number;
  viewingRunId: string | null;
  insightsRevision: number;
  onViewingRun: (runId: string | null, sessionId: string) => void;
  onDeleted: (undo: DeletionUndo | null, label: string, previousRunId?: string | null) => void;
  onTabChange: (tab: 'history' | 'runs') => void;
  onManualLink: () => void;
  onCopyText: (text: string, label: string) => void;
  onNotice: (message: string) => void;
  onError: (message: string) => void;
}

/**
 * Conversation history and run logs own their loading state here. Loading a
 * transcript used to set seven pieces of App state, reconciling the sidebar,
 * terminal and top bar on every refresh; now only this panel rerenders.
 * App keeps `viewingRun` because the terminal state button can open a run.
 */
export function SessionInsights(props: SessionInsightsProps) {
  const { session, projectPath, definition, label, tab, apiVersion, connected, canHistory, canResume, disabled, windowsPty, fontSize, viewingRunId, insightsRevision } = props;
  const [history, setHistory] = useState<History | null>(null);
  const [runs, setRuns] = useState<Run[]>([]);
  const [runsLoading, setRunsLoading] = useState(false);
  const [runsError, setRunsError] = useState('');
  const [runsRevision, setRunsRevision] = useState(0);
  const [runOutput, setRunOutput] = useState<string | null>(null);
  const [runOutputError, setRunOutputError] = useState('');
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const report = useRef(props.onError);
  report.current = props.onError;

  useEffect(() => {
    if (!connected) { setRunsLoading(false); setRunsError('后台连接已断开，请重新连接后重试。'); return; }
    let canceled = false;
    setHistory(null); setRunsError(''); setRunOutputError(''); setRunOutput(null);
    if (tab === 'history') {
      void window.berth.rpc<History>('history', { sessionId: session.id })
        .then(value => { if (!canceled) setHistory(value); })
        .catch(reason => { if (!canceled) report.current(String(reason)); });
    } else {
      setRunsLoading(true);
      void window.berth.rpc<Run[]>('runs', { sessionId: session.id }).then(async value => {
        if (canceled) return;
        setRuns(value);
        if (viewingRunId) {
          if (!value.some(run => run.id === viewingRunId)) { setRunOutputError('运行记录已不存在'); return; }
          try {
            const text = await window.berth.rpc<string>('output', { runId: viewingRunId });
            if (!canceled) setRunOutput(text);
          } catch (reason) { if (!canceled) setRunOutputError(String(reason)); }
        }
      }).catch(reason => { if (!canceled) setRunsError(String(reason)); })
        .finally(() => { if (!canceled) setRunsLoading(false); });
    }
    return () => { canceled = true; };
  }, [session.id, session.agent, session.transcriptPath, session.nativeSessionId, session.latestRun?.status, session.latestRun?.id, projectPath, tab, connected, viewingRunId, runsRevision, insightsRevision]);

  const rpc = async <T,>(method: 'linkNativeSession' | 'unlinkNativeSession' | 'importHistory' | 'refreshHistory' | 'deleteRun' | 'clearFinishedRuns', params: Record<string, unknown>): Promise<T | undefined> => {
    try { return await window.berth.rpc<T>(method, params); }
    catch (reason) { if (mounted.current) report.current(String(reason)); return undefined; }
  };

  async function importHistory() {
    try {
      const file = await window.berth.chooseTranscript();
      if (!file || !mounted.current) return;
      const result = await rpc<History>('importHistory', { sessionId: session.id, path: file });
      if (result && mounted.current) { setHistory(result); props.onTabChange('history'); }
    } catch (reason) { if (mounted.current) report.current(String(reason)); }
  }
  async function refreshHistory() {
    const result = await rpc<History>('refreshHistory', { sessionId: session.id });
    if (result && mounted.current) setHistory(result);
  }

  if (tab === 'history') {
    const plugin = definition?.plugin;
    const canAssociate = canHistory || canResume || !!plugin?.list;
    const canDiscover = !!plugin?.list || (apiVersion >= 35 && ['codex', 'claude'].includes(session.agent)) || (apiVersion >= 38 && (session.agent === 'opencode' || !!definition?.integration));
    const autoRead = !!plugin?.history || (!!session.nativeSessionId && (['claude', 'opencode'].includes(session.agent) || !!definition?.integration));
    return <div id="workspace-panel-history" className="workspace-panel history-workspace-panel" role="tabpanel" aria-labelledby="workspace-tab-history">
      <HistoryPanel key={`${session.id}:${projectPath}:${JSON.stringify(plugin)}`} session={session} history={history} label={label} canHistory={canHistory} canAssociate={canAssociate} canDiscover={canDiscover} autoRead={autoRead} supported={apiVersion >= 11} disabled={disabled}
        onImport={importHistory} onRefresh={refreshHistory} onManual={props.onManualLink}
        onCopy={id => props.onCopyText(id, '原生会话 ID')}
        onLink={async nativeSessionId => {
          const result = await rpc<History>('linkNativeSession', { sessionId: session.id, nativeSessionId });
          if (result && mounted.current) { setHistory(result); props.onNotice('原生会话已关联'); }
          return result;
        }}
        onUnlink={async () => {
          const result = await rpc<History>('unlinkNativeSession', { sessionId: session.id });
          if (result && mounted.current) { setHistory(result); props.onNotice('已解除关联，历史记录保留'); }
          return result;
        }} />
    </div>;
  }

  return <div id="workspace-panel-runs" className="workspace-panel history-workspace-panel" role="tabpanel" aria-labelledby="workspace-tab-runs">
    <RunHistory key={session.id} runs={runs} loading={runsLoading} error={runsError} outputError={runOutputError}
      onRetry={() => setRunsRevision(value => value + 1)} outputRunId={viewingRunId} output={runOutput}
      windowsPty={windowsPty} fontSize={fontSize} disabled={disabled || apiVersion < 10} onError={props.onError}
      onView={runId => { setRunOutput(null); props.onViewingRun(runId, session.id); }}
      onDelete={async runId => {
        // Remember the output the user was reading so undo can reopen exactly
        // that run instead of an arbitrary row from the restore payload.
        const previousRunId = viewingRunId;
        // Older daemons return null: the delete succeeds but offers no undo receipt.
        const result = await rpc<DeletionUndo | null>(runId ? 'deleteRun' : 'clearFinishedRuns', runId ? { runId } : { sessionId: session.id });
        if (result === undefined) return false;
        // The delete still offers undo after navigation, but its late response
        // must not close the output now being read in another session.
        if (mounted.current) {
          props.onViewingRun(null, session.id); setRunOutput(null); setRunsRevision(value => value + 1);
        }
        props.onDeleted(result, result?.label ?? (runId ? `运行 ${runId.slice(0, 8)}` : '已结束的运行记录'), previousRunId);
        return true;
      }} />
  </div>;
}
