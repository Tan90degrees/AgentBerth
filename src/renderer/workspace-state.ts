import { useCallback, useRef, useSyncExternalStore } from 'react';
import { API_VERSION, DEFAULT_SETTINGS, type State } from '../shared/protocol';

// The daemon broadcasts a complete snapshot on every change. Keeping it in a
// module-level store (the same pattern Resources.tsx uses for telemetry) lets
// components subscribe to one slice at a time and lets event handlers read the
// current value without closing over a render.

const emptyState = (): State => ({
  projects: [], sessions: [],
  maxActiveTerminals: DEFAULT_SETTINGS.maxActiveTerminals,
  maxSshTerminals: DEFAULT_SETTINGS.maxSshTerminals,
  platform: '', settings: structuredClone(DEFAULT_SETTINGS), apiVersion: API_VERSION,
});

let snapshot: State = emptyState();
const listeners = new Set<() => void>();

export const getWorkspaceState = (): State => snapshot;

/** Subscribe to committed snapshots. Exported for tests and non-React consumers. */
export function subscribeWorkspace(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

const normalize = (value: State): State => ({
  ...value,
  agents: value.agents ?? [],
  apiVersion: value.apiVersion ?? 1,
  maxSshTerminals: value.maxSshTerminals ?? DEFAULT_SETTINGS.maxSshTerminals,
  settings: { ...structuredClone(DEFAULT_SETTINGS), ...value.settings },
  sessions: value.sessions.map(session => ({ ...session, terminal: session.terminal ?? null })),
});

const sameJson = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

// Reuse references for slices that did not actually change so memoized subtrees
// (ProjectTree, TerminalView, ...) are not invalidated by unrelated broadcasts.
export function mergeWorkspaceState(previous: State, value: State): State {
  const next = normalize(value);
  const slices = {
    projects: sameJson(previous.projects, next.projects) ? previous.projects : next.projects,
    sessions: sameJson(previous.sessions, next.sessions) ? previous.sessions : next.sessions,
    agents: sameJson(previous.agents, next.agents) ? previous.agents : next.agents,
    settings: sameJson(previous.settings, next.settings) ? previous.settings : next.settings,
    extensions: sameJson(previous.extensions, next.extensions) ? previous.extensions : next.extensions,
    agentActivities: sameJson(previous.agentActivities, next.agentActivities) ? previous.agentActivities : next.agentActivities,
    recovery: sameJson(previous.recovery, next.recovery) ? previous.recovery : next.recovery,
    windowsPty: sameJson(previous.windowsPty, next.windowsPty) ? previous.windowsPty : next.windowsPty,
  };
  const scalars = previous.apiVersion === next.apiVersion && previous.platform === next.platform
    && previous.maxActiveTerminals === next.maxActiveTerminals && previous.maxSshTerminals === next.maxSshTerminals;
  const unchanged = scalars
    && slices.projects === previous.projects && slices.sessions === previous.sessions
    && slices.agents === previous.agents && slices.settings === previous.settings
    && slices.extensions === previous.extensions && slices.agentActivities === previous.agentActivities
    && slices.recovery === previous.recovery && slices.windowsPty === previous.windowsPty;
  if (unchanged) return previous;
  return { ...next, ...slices };
}

/** Publish a daemon snapshot. Identical snapshots notify nobody. */
export function publishWorkspaceState(value: State): void {
  const next = mergeWorkspaceState(snapshot, value);
  if (next === snapshot) return;
  snapshot = next;
  for (const listener of listeners) listener();
}

export function resetWorkspaceState(): void {
  const next = emptyState();
  if (next === snapshot) return;
  snapshot = next;
  for (const listener of listeners) listener();
}

function shallowEqual(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if (typeof a !== 'object' || typeof b !== 'object' || !a || !b) return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  const left = a as Record<string, unknown>, right = b as Record<string, unknown>;
  const keys = Object.keys(left);
  return keys.length === Object.keys(right).length && keys.every(key => Object.is(left[key], right[key]));
}

/**
 * Subscribe to a derived slice of the daemon snapshot. getSnapshot must return
 * a stable reference, so results are cached per snapshot and shallow-compared:
 * a component selecting `s => s.projects` does not rerender when only telemetry,
 * settings or sessions changed.
 */
export function useWorkspaceState<T>(selector: (state: State) => T): T {
  const select = useRef(selector);
  select.current = selector;
  const cache = useRef<{ source: State; selector: (state: State) => T; value: T } | null>(null);
  const getSnapshot = useCallback(() => {
    const source = getWorkspaceState();
    const previous = cache.current;
    if (previous?.source === source && previous.selector === select.current) return previous.value;
    const selected = select.current(source);
    const value = previous && shallowEqual(previous.value, selected) ? previous.value : selected;
    cache.current = { source, selector: select.current, value };
    return value;
  }, []);
  return useSyncExternalStore(subscribeWorkspace, getSnapshot, getSnapshot);
}

export function useStableCallback<A extends unknown[], R>(fn: (...args: A) => R): (...args: A) => R {
  const current = useRef(fn);
  current.current = fn;
  return useCallback((...args: A) => current.current(...args), []);
}
