export type UpdateAction = 'state' | 'check' | 'download' | 'cancel' | 'apply' | 'automatic';
export interface AppUpdateState {
  supported: boolean;
  phase: 'idle' | 'checking' | 'current' | 'available' | 'downloading' | 'extracting' | 'ready' | 'applying' | 'runtime_required' | 'error';
  currentVersion: string; latestVersion: string | null; downloaded: number; total: number;
  notes: string; releaseUrl: string; message: string; checkedAt: string | null; automatic: boolean; backendPending: boolean;
}
export interface UpdateWindow { bounds: { x: number; y: number; width: number; height: number }; maximized: boolean; visible: boolean; minimized: boolean }
export interface UpdateResume { storage: Record<string, string>; main: UpdateWindow | null; ssh: UpdateWindow | null; sshSession: string }
