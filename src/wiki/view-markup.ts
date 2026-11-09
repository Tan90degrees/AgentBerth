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
    </nav>
    <div class="status"><span id="statusDot" class="dot"></span><span id="statusText">加载中…</span></div>
  </header>
  <p id="error" class="error" role="alert" style="margin:0 16px"></p>
  <main>
    <aside>
      <section data-for="wiki">
        <div class="list-head"><strong>Wiki 页面</strong><button id="newPage" data-action="newPage" class="ghost" aria-label="新建页面">＋</button></div>
        <input id="pageSearch" placeholder="搜索标题或摘要…" aria-label="搜索页面" maxlength="200">
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
      <section class="panel" data-panel="ask">
        <div class="card"><h2>基于 Wiki 提问</h2><p class="muted">回答只依据检索到的页面，并在结论后附上 [[引用]]；好答案可归档成新页面。</p>
          <textarea id="question" rows="3" maxlength="2000" placeholder="例如：现有笔记里，关于 X 有哪些互相矛盾的说法？"></textarea>
          <div class="row" style="margin-top:8px"><button id="ask" data-action="ask" class="primary">提问</button><span id="askProgress" class="muted"></span></div>
        </div>
        <div id="answerView"></div>
      </section>
      <section class="panel" data-panel="skills"><div id="skillView"></div></section>
      <section class="panel" data-panel="settings"><div id="settingsView"></div></section>
    </article>
  </main>
</div>
`;
