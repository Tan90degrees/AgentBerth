export const notesWikiMarkup = String.raw`
<div class="app">
  <header class="topbar">
    <div class="brand"><span class="brand-mark" aria-hidden="true"><svg width="19" height="19" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M4 5.5A2.5 2.5 0 0 1 6.5 3H19v16H6.5A2.5 2.5 0 0 0 4 21.5z"/><path d="M8 7h7M8 11h7M8 15h4"/></svg></span><div><h1>笔记 Wiki</h1><p>原始素材 → 编译提案 → 可引用知识</p></div></div>
    <nav class="tabs" aria-label="笔记视图">
      <button data-tab="wiki" class="active">页面</button>
      <button data-tab="sources">素材</button>
      <button data-tab="review">审阅 <span id="draftCount" class="badge" hidden>0</span></button>
      <button data-tab="ask">提问</button>
      <button data-tab="skills">Skill</button>
      <button data-tab="settings">设置</button>
      <button data-tab="tasks">任务 <span id="taskCount"></span></button>
      <button data-tab="trash">回收站</button>
    </nav>
    <div class="status"><span id="statusDot" class="dot"></span><span id="statusText">加载中…</span></div>
  </header>
  <p id="error" class="error" role="alert" style="margin:0 16px"></p>
  <div id="uxNotice" class="notice ux-notice" role="status" hidden></div>
  <div id="draftShelf" class="draft-shelf"></div><small id="draftSaveState" role="status"></small>
  <div id="setupGuide" class="notice setup-guide" hidden><strong>开始使用知识库</strong><p>① 配置模型并测试连接 → ② 导入第一份素材 → ③ 审阅后发布。</p><button data-action="openPluginSettings">配置地址、模型与鉴权</button><button data-tab="sources">导入素材</button></div>
  <main>
    <aside>
      <section data-for="wiki">
        <div class="list-head"><strong>Wiki 页面</strong><button id="newPage" data-action="newPage" class="ghost" aria-label="新建页面">＋</button></div>
        <input id="pageSearch" placeholder="全文搜索页面…" aria-label="搜索页面" maxlength="200">
        <label>类型<select id="pageKind"><option value="">全部类型</option><option value="concept">概念</option><option value="entity">实体</option><option value="source">来源</option><option value="comparison">对比</option><option value="overview">总览</option><option value="note">笔记</option></select></label><input id="pageTag" placeholder="按标签筛选" aria-label="标签筛选">
        <div id="pageList" style="margin-top:8px"></div>
      </section>
      <section data-for="sources" hidden>
        <div class="list-head"><strong>原始素材</strong><button id="newSource" data-action="newSource" class="ghost" aria-label="新建素材">＋</button></div>
        <p class="muted">素材只读，模型据此编译页面。</p>
        <button data-action="showCapture" class="ghost" style="width:100%;margin-bottom:8px">自动采集 / 会话沉淀</button>
        <div id="sourceList"></div>
      </section>
      <section data-for="review" hidden>
        <div class="list-head"><strong>编译提案</strong><button id="runLint" data-action="runLint" class="ghost" aria-label="知识库体检">体检</button></div>
        <p class="muted">模型只生成提案，批准后才写入 wiki。</p>
        <div id="draftList"></div>
      </section>
      <section data-for="ask" hidden>
        <div class="list-head"><strong>最近提问</strong></div>
        <input id="answerSearch" placeholder="搜索全部问答历史" aria-label="搜索问答历史">
        <div id="answerList"></div>
      </section>
      <section data-for="skills" hidden>
        <div class="list-head"><strong>工作流 Skill</strong><button id="newSkill" data-action="newSkill" class="ghost" aria-label="新建 Skill">＋</button></div>
        <p class="muted">Markdown 指令模板，可增删改查。</p>
        <div id="skillList"></div>
      </section>
      <section data-for="settings" hidden>
        <div class="list-head"><strong>知识库文件</strong></div>
        <div class="stack">
          <button data-file="index">查看 index.md</button>
          <button data-file="log">查看 log.md</button>
          <button data-file="schema">编辑 Schema</button>
          <button data-file="lint">体检结果</button>
          <button id="openPluginSettings" data-action="openPluginSettings">插件设置</button>
        </div>
        <p class="muted" style="margin-top:12px">模型地址、模型名与自动化开关：点「插件设置」会直接在本页弹出修改面板，无需跳转。</p>
      </section>
    </aside>
    <article>
      <section class="panel active" data-panel="wiki"><div id="pageView"></div></section>
      <section class="panel" data-panel="sources"><div id="sourceView"></div></section>
      <section class="panel" data-panel="review"><div id="draftView"></div></section>
      <section class="panel" data-panel="ask" id="askPanel">
        <div class="card"><h2>基于 Wiki 提问</h2><p class="muted">回答只依据检索到的页面，并在结论后附上 [[引用]]；好答案可归档成新页面。</p>
          <textarea id="question" data-field="question" rows="3" maxlength="2000" placeholder="例如：现有笔记里，关于 X 有哪些互相矛盾的说法？"></textarea>
          <div class="row" style="margin-top:8px"><button id="ask" data-action="ask" class="primary">提问</button><span id="askProgress" class="muted"></span></div>
        </div>
        <div id="answerView"></div>
      </section>
      <section class="panel" data-panel="skills"><div id="skillView"></div></section>
      <section class="panel" data-panel="settings"><div id="settingsView"></div></section>
      <section class="panel" data-panel="tasks"><h2>任务中心</h2><p class="muted">可取消或重试任务；后台重启后会保留记录，并提示重试未完成任务。</p><div id="taskView"></div></section>
      <section class="panel" data-panel="trash"><h2>回收站</h2><div id="trashView"></div></section>
    </article>
  </main>
</div>
<div id="uxDialog" hidden></div>
`;
