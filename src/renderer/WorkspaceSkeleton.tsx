export function WorkspaceSkeleton() {
  return <div className="workspace-skeleton" role="status" aria-label="正在连接工作空间">
    <div className="skeleton-topline"><span className="skeleton-line w-40" /><span className="skeleton-line w-20" /></div>
    <div className="skeleton-card">
      <div className="skeleton-tabs"><span className="skeleton-line w-20" /><span className="skeleton-line w-20" /><span className="skeleton-line w-20" /></div>
      <div className="skeleton-body">
        <span className="skeleton-line w-55" />
        <span className="skeleton-line w-85" />
        <span className="skeleton-line w-70" />
        <span className="skeleton-line w-40" />
      </div>
    </div>
    <p className="skeleton-caption">正在连接你的工作空间…</p>
  </div>;
}
