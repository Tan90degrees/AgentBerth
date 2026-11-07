// The notes wiki keeps Markdown as the source of truth. Every derived field
// (index, log, link graph, drafts) can be rebuilt from these documents.
export type PageKind = 'concept' | 'entity' | 'source' | 'comparison' | 'overview' | 'note';
export type SkillKind = 'ingest' | 'compile' | 'query' | 'lint' | 'synthesize' | 'custom';

export interface WikiPage {
  slug: string;
  title: string;
  summary: string;
  kind: PageKind;
  sources: string[];
  tags: string[];
  body: string;
  humanEdited: boolean;
  hash: string;
  createdAt: string;
  updatedAt: string;
}

export interface WikiSource {
  id: string;
  title: string;
  text: string;
  images: string[];
  vision: string;
  compiled: boolean;
  hash: string;
  createdAt: string;
}

export interface WikiSkill {
  name: string;
  description: string;
  kind: SkillKind;
  triggers: string[];
  body: string;
  builtin: boolean;
  updatedAt: string;
}

export interface DraftPage {
  slug: string;
  title: string;
  summary: string;
  kind: PageKind;
  body: string;
  sources: string[];
  tags: string[];
  previous: string | null;
  action: 'create' | 'update' | 'skip';
}

export interface WikiDraft {
  id: string;
  sourceId: string | null;
  sourceTitle: string;
  createdAt: string;
  model: string;
  summary: string;
  pages: DraftPage[];
  contradictions: string[];
  feedback: string[];
  status: 'pending' | 'approved' | 'rejected';
  resolvedAt?: string;
}

export interface WikiTask {
  id: string;
  kind: 'compile' | 'ask' | 'lint' | 'vision';
  label: string;
  status: 'queued' | 'running' | 'done' | 'failed';
  progress: string;
  startedAt: string;
  finishedAt?: string;
  error?: string;
  result?: unknown;
}

export interface WikiLint {
  at: string;
  orphans: string[];
  brokenLinks: { from: string; to: string }[];
  missingSummary: string[];
  contradictions: { page: string; text: string }[];
  stale: string[];
  suggestions: string[];
}

export interface WikiAnswer {
  question: string;
  answer: string;
  citations: string[];
  pages: string[];
  model: string;
  at: string;
}

export interface WikiStatus {
  pages: number;
  sources: number;
  pendingDrafts: number;
  skills: number;
  links: number;
  orphans: number;
  model: { baseURL: string; textModel: string; visionModel: string; keyConfigured: boolean; keyHint: string };
  automation: { autoCompile: boolean; autoApprove: boolean; lintMinutes: number };
  lastLint: string | null;
  tasks: WikiTask[];
  ready: boolean;
}

export interface WikiConfig {
  baseURL: string;
  textModel: string;
  visionModel: string;
  autoCompile: boolean;
  autoApprove: boolean;
  lintMinutes: number;
  maxContextPages: number;
}
