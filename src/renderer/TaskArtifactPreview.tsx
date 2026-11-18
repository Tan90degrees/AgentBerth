import { useEffect, useState } from 'react';
import type { FilePreview as Preview } from '../shared/protocol';
import FilePreview from './FilePreview';
import { Dialog } from './Dialog';

export interface TaskArtifactLocation {
  projectId: string;
  worktreePath: string | null;
  path: string;
}

export default function TaskArtifactPreview({ location, close, returnFocus }: {
  location: TaskArtifactLocation;
  close: () => void;
  returnFocus: HTMLElement | null;
}) {
  const [path, setPath] = useState(location.path);
  const [revision, setRevision] = useState(0);
  const [file, setFile] = useState<Preview | null>(null);
  const [error, setError] = useState('');
  const [markdown, setMarkdown] = useState(true);
  const {projectId,worktreePath}=location;
  useEffect(() => {
    let active = true;
    setError('');
    setFile(null);
    void window.berth.rpc<Preview>('previewFile', { projectId, worktreePath, path }).then(result => {
      if (active) setFile(result);
    }).catch(reason => { if (active) setError(String(reason)); });
    return () => { active = false; };
  }, [projectId, worktreePath, path, revision]);

  return <Dialog title="交付文件预览" onClose={close} returnFocus={returnFocus} error={error}>
    <div className="task-artifact-preview">
      {file?.path === path ? <FilePreview file={file} projectId={projectId} worktreePath={worktreePath}
        markdown={markdown} onMarkdown={setMarkdown} onError={setError} onNavigate={setPath}
        onRefresh={() => setRevision(value => value + 1)} /> :
        <div className="file-preview-empty">
          <span>{path}</span>
          {error ? <button className="subtle" onClick={() => setRevision(value => value + 1)}>重试</button> : <p role="status">正在读取文件…</p>}
        </div>}
    </div>
  </Dialog>;
}
