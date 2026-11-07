import type { Agent, RemoteConfig, TerminalConfig } from '../shared/protocol';

export type Modal = 'project' | 'editProject' | 'deleteProject' | 'session' | 'editSession' | 'sshSession' | 'editSshSession' | 'deleteSession' | 'stop' | 'link' | 'restart' | 'renameSession' | 'renameProject';
export type ModalTarget = { projectId: string; sessionId?: string } | null;

export type ProjectFormValues = { name: string; folder: string };
export type SessionFormValues = {
  title: string; agent: Agent; command: string; terminal: TerminalConfig | null;
  startNow: boolean; remote: RemoteConfig | null; worktreePath: string | null; service: boolean;
};
export type ModalInitial = { project?: ProjectFormValues; session?: SessionFormValues; value?: string };
export type ModalRequest = { kind: Modal; target: ModalTarget; initial: ModalInitial; token: number };

export type ModalFormValues = {
  name: string; folder: string; title: string; agent: Agent; command: string;
  terminal: TerminalConfig | null; startNow: boolean; remote: RemoteConfig | null;
  worktreePath: string | null; service: boolean; nativeId: string;
};

export const SESSION_KINDS = new Set<Modal>(['session', 'editSession', 'sshSession', 'editSshSession']);

/** Serialize only the fields that belong to the open form. Dialogs without a form return ''. */
export function modalFormValue(kind: Modal, values: ModalFormValues): string {
  if (kind === 'project' || kind === 'editProject') return JSON.stringify({ name: values.name, folder: values.folder });
  if (SESSION_KINDS.has(kind)) return JSON.stringify({ title: values.title, agent: values.agent, command: values.command, terminal: values.terminal, startNow: values.startNow, remote: values.remote, worktreePath: values.worktreePath, service: values.service });
  if (kind === 'link') return JSON.stringify(values.nativeId);
  if (kind === 'renameSession') return JSON.stringify(values.title);
  if (kind === 'renameProject') return JSON.stringify(values.name);
  return '';
}

/** Initial form values for a dialog, derived from what the caller wants to edit. */
export function modalFormInitial(kind: Modal, initial: ModalInitial): ModalFormValues {
  const single = initial.value ?? '';
  return {
    name: initial.project?.name ?? (kind === 'renameProject' ? single : ''),
    folder: initial.project?.folder ?? '',
    title: initial.session?.title ?? (kind === 'renameSession' ? single : ''),
    agent: initial.session?.agent ?? 'codex',
    command: initial.session?.command ?? '',
    terminal: initial.session?.terminal ?? null,
    startNow: initial.session?.startNow ?? true,
    remote: initial.session?.remote ?? null,
    worktreePath: initial.session?.worktreePath ?? null,
    service: initial.session?.service ?? false,
    nativeId: kind === 'link' ? single : '',
  };
}
