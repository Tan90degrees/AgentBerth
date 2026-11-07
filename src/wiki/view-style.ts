export const notesWikiStyle = String.raw`
:root{color-scheme:var(--color-scheme,light)}
*{box-sizing:border-box}
body{font:var(--fs-sm,13px)/1.65 var(--font-sans,system-ui);margin:0!important;padding:0!important;background:var(--surface,#fff);color:var(--text,#202123);height:100vh;overflow:hidden}
button,input,select,textarea{font:inherit;color:var(--text,#202123)}
button{cursor:pointer;border:1px solid var(--border,#e5e5e5);background:transparent;border-radius:var(--radius-sm,6px);padding:6px 11px;transition:background var(--motion-fast,120ms) var(--ease-out,ease)}
button:hover:not(:disabled){background:var(--hover,#eee)}
button:disabled{opacity:.5;cursor:not-allowed}
button.primary{background:var(--primary,#212121);color:var(--on-primary,#fff);border-color:transparent;font-weight:600}
button.primary:hover:not(:disabled){background:var(--primary-hover,#333)}
button.danger{color:var(--danger,#b42b2b);border-color:var(--danger-border,#e8c4c4)}
button.active{background:var(--selected,#e9e9e9);font-weight:600}
button.ghost{border-color:transparent}
input,select,textarea{background:var(--input,#fff);border:1px solid var(--border,#e5e5e5);border-radius:var(--radius-sm,6px);padding:8px 10px;width:100%;outline:none}
input:focus,select:focus,textarea:focus{border-color:var(--focus,#497fb8);box-shadow:0 0 0 2px var(--selection,#dce9f7)}
textarea{resize:vertical;min-height:80px;font-family:var(--font-mono,monospace);font-size:var(--fs-xs,12px);line-height:1.6}
label{display:block;font-size:var(--fs-xs,12px);color:var(--text-secondary,#4d4d4d);margin:10px 0 4px}
small,.muted{font-size:var(--fs-xs,12px);color:var(--text-muted,#6b6b6b)}
code,pre{font-family:var(--font-mono,monospace)}
h1,h2,h3,h4{line-height:1.3;margin:0 0 8px}
h1{font-size:var(--fs-xl,18px)}h2{font-size:var(--fs-lg,16px)}h3{font-size:var(--fs-md,14px)}
p{margin:6px 0}
a{color:var(--link,#275e9c)}
.app{display:flex;flex-direction:column;height:100vh}
.topbar{display:flex;align-items:center;justify-content:space-between;gap:var(--space-4,16px);padding:10px 16px;border-bottom:1px solid var(--border,#e5e5e5);background:var(--surface-muted,#f9f9f9);flex-wrap:wrap}
.brand{display:flex;align-items:center;gap:10px}
.brand-mark{display:grid;place-items:center;width:34px;height:34px;border-radius:var(--radius-md,10px);background:var(--surface,#fff);border:1px solid var(--border,#e5e5e5);color:var(--primary,#212121)}
.brand h1{margin:0;font-size:var(--fs-lg,16px)}
.brand p{margin:0;font-size:var(--fs-xs,12px);color:var(--text-muted,#6b6b6b)}
.tabs{display:flex;gap:4px;flex-wrap:wrap}
.status{display:flex;align-items:center;gap:8px;font-size:var(--fs-xs,12px);color:var(--text-muted,#6b6b6b)}
.dot{width:7px;height:7px;border-radius:50%;background:var(--warning,#b7791f)}
.dot.ok{background:var(--success,#287448)}
main{display:grid;grid-template-columns:270px minmax(0,1fr);flex:1;min-height:0}
aside{border-right:1px solid var(--border,#e5e5e5);overflow:auto;padding:12px;background:var(--surface-muted,#f9f9f9)}
article{overflow:auto;padding:18px 22px;min-width:0}
.panel{display:none}.panel.active{display:block}
.list-head{display:flex;align-items:center;justify-content:space-between;gap:8px;margin-bottom:8px}
.list-head strong{font-size:var(--fs-sm,13px)}
.row{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.row>.grow{flex:1;min-width:120px}
.stack{display:flex;flex-direction:column;gap:8px}
.item{display:block;text-align:left;width:100%;border:1px solid transparent;background:transparent;border-radius:var(--radius-sm,6px);padding:8px 10px;margin-bottom:3px;color:inherit}
.item:hover{background:var(--hover,#eee)}
.item.selected{background:var(--selected,#e9e9e9);border-color:var(--border,#e5e5e5)}
.item strong{display:block;font-size:var(--fs-sm,13px);font-weight:600}
.item span{display:block;font-size:var(--fs-xs,12px);color:var(--text-muted,#6b6b6b);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.badge{display:inline-block;font-size:var(--fs-2xs,10px);padding:1px 6px;border-radius:var(--radius-pill,999px);background:var(--surface-muted,#f4f4f4);border:1px solid var(--border,#e5e5e5);color:var(--text-secondary,#4d4d4d);margin-left:4px}
.badge.warn{background:var(--warning-soft,#fff5e6);border-color:var(--warning-border,#f0d9b5);color:var(--warning,#8a5a00)}
.badge.good{background:var(--success-soft,#eaf6ee);border-color:var(--success-border,#c9e6d3);color:var(--success,#287448)}
.card{border:1px solid var(--border,#e5e5e5);border-radius:var(--radius-md,10px);padding:14px;background:var(--surface,#fff);margin-bottom:12px}
.card h2,.card h3{margin-top:0}
.empty{padding:28px 12px;text-align:center;color:var(--text-muted,#6b6b6b);border:1px dashed var(--border,#e5e5e5);border-radius:var(--radius-md,10px)}
.error{color:var(--danger,#b42b2b);font-size:var(--fs-xs,12px);min-height:18px;margin:6px 0}
.notice{background:var(--success-soft,#eaf6ee);border:1px solid var(--success-border,#c9e6d3);color:var(--success,#287448);border-radius:var(--radius-sm,6px);padding:8px 10px;font-size:var(--fs-xs,12px)}
.markdown{font-size:var(--fs-sm,13px);line-height:1.75;max-width:820px}
.markdown h1,.markdown h2,.markdown h3{margin:18px 0 8px}
.markdown blockquote{margin:8px 0;padding:6px 12px;border-left:3px solid var(--warning,#b7791f);background:var(--warning-soft,#fff5e6);color:var(--text-secondary,#4d4d4d)}
.markdown ul,.markdown ol{padding-left:22px}
.markdown pre{background:var(--surface-muted,#f4f4f4);padding:10px;border-radius:var(--radius-sm,6px);overflow:auto}
.markdown .wikilink{border:0;background:transparent;color:var(--link,#275e9c);padding:0;text-decoration:underline;text-underline-offset:2px}
.markdown .wikilink:hover{background:transparent}
.diff{font-family:var(--font-mono,monospace);font-size:var(--fs-xs,12px);white-space:pre-wrap;border:1px solid var(--border,#e5e5e5);border-radius:var(--radius-sm,6px);overflow:auto;max-height:420px}
.diff div{padding:1px 8px}
.diff .add{background:var(--success-soft,#eaf6ee);color:var(--success,#287448)}
.diff .del{background:var(--danger-soft,#fdeaea);color:var(--danger,#b42b2b)}
.diff .same{color:var(--text-muted,#6b6b6b)}
.answer{white-space:normal;border:1px solid var(--border,#e5e5e5);border-radius:var(--radius-md,10px);padding:14px;background:var(--surface-muted,#f9f9f9)}
.citations{display:flex;gap:6px;flex-wrap:wrap;margin-top:10px}
.citations button{font-size:var(--fs-xs,12px);padding:3px 8px}
.progress{display:flex;align-items:center;gap:8px;font-size:var(--fs-xs,12px);color:var(--text-secondary,#4d4d4d);margin:8px 0}
.spinner{width:10px;height:10px;border:2px solid var(--border,#e5e5e5);border-top-color:var(--primary,#212121);border-radius:50%;animation:spin .8s linear infinite}
@keyframes spin{to{transform:rotate(360deg)}}
.grid2{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:12px}
hr{border:0;border-top:1px solid var(--border,#e5e5e5);margin:16px 0}
details{margin:10px 0}
summary{cursor:pointer;font-size:var(--fs-sm,13px);font-weight:600}
.img-preview{max-width:100%;max-height:180px;border-radius:var(--radius-sm,6px);border:1px solid var(--border,#e5e5e5);margin-top:6px}
@media(max-width:760px){main{grid-template-columns:1fr}aside{border-right:0;border-bottom:1px solid var(--border,#e5e5e5);max-height:220px}.grid2{grid-template-columns:1fr}}
@media(prefers-reduced-motion:reduce){*{animation:none!important;transition:none!important}}
`;
