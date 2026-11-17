export const glassStyle=String.raw`
:root[data-palette=glass] .app,:root[data-palette=glass] body{background:radial-gradient(ellipse at 12% 4%,#63b8e52b,transparent 54%),radial-gradient(ellipse at 95% 76%,#b398ee26,transparent 54%),var(--bg)}
:root[data-palette=glass] .sidebar,:root[data-palette=glass] .topbar,:root[data-palette=glass] aside,:root[data-palette=glass] .dialog,:root[data-palette=glass] .notification-panel,:root[data-palette=glass] .quick-switcher,:root[data-palette=glass] .agent-input-card,:root[data-palette=glass] .board-card,:root[data-palette=glass] .pipeline-card,:root[data-palette=glass] .task-menu>div,:root[data-palette=glass] .task-confirm{background:var(--panel);border-color:var(--border);box-shadow:inset 0 1px 0 #ffffff24,0 6px 22px var(--shadow-color)}
:root[data-palette=glass] .app>.main{background:transparent}
/* Backdrop filtering creates a stacking context; keep toolbar popovers above content. */
:root[data-palette=glass] .topbar{z-index:10}
@supports(backdrop-filter:blur(1px)){
 :root[data-palette=glass] .sidebar,:root[data-palette=glass] .topbar,:root[data-palette=glass] aside,:root[data-palette=glass] .dialog,:root[data-palette=glass] .notification-panel,:root[data-palette=glass] .quick-switcher,:root[data-palette=glass] .task-menu>div,:root[data-palette=glass] .task-confirm{backdrop-filter:blur(12px) saturate(135%)}
}
@supports not (backdrop-filter:blur(1px)){:root[data-palette=glass]{--panel:var(--bg)!important;--surface:var(--bg)!important;--sidebar:var(--bg)!important}}
@media(prefers-reduced-transparency:reduce){:root[data-palette=glass]{--panel:var(--bg)!important;--surface:var(--bg)!important;--sidebar:var(--bg)!important}:root[data-palette=glass] *{backdrop-filter:none!important}:root[data-palette=glass] .app,:root[data-palette=glass] body{background:var(--bg)}}
`;
