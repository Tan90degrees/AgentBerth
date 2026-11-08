export const notesWikiScript = String.raw`
(function(){
  var $=function(id){return document.getElementById(id)};
  var state={tab:'wiki',status:null,pages:[],sources:[],drafts:[],skills:[],answers:[],sessions:[],page:null,source:null,draft:null,draftSlug:'',skill:null,answer:null,task:null,taskOrigin:'',editing:false,newSource:false,newSkill:false,newPage:false,file:'',lint:null};
  var call=function(command,params){return agentberth.call(command,params||{})};
  var esc=function(value){return String(value==null?'':value).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;')};
  var err=function(value){$('error').textContent=String(value&&value.message||value||'')};
  var ok=function(value){return function(result){err('');return result};};
  var val=function(name){var node=document.querySelector('[data-field="'+name+'"]');return node?node.value:''};
  var date=function(value){try{return new Date(value).toLocaleString('zh-CN',{month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit'})}catch(e){return String(value||'')}};
  var kindName={concept:'概念',entity:'实体',source:'来源',comparison:'对比',overview:'总览',note:'笔记'};

  function markdown(text){
    var tick=String.fromCharCode(96),fence=tick+tick+tick;
    var lines=esc(text||'').split(/\r?\n/),out=[],inList=false,inCode=false;
    for(var i=0;i<lines.length;i++){
      var line=lines[i];
      if(line.indexOf(fence)===0){if(inList){out.push('</ul>');inList=false}inCode=!inCode;out.push(inCode?'<pre>':'</pre>');continue}
      if(inCode){out.push(line);continue}
      var link=function(_,target,label){var slug=target.trim().replace(/[^0-9a-z\u4e00-\u9fff._-]/gi,'-');return '<button class="wikilink" data-action="openPage" data-slug="'+esc(slug)+'">'+esc(label||target)+'</button>'};
      line=line.replace(/\[\[([^\]|#]+)(?:#[^\]|]*)?(?:\|([^\]]*))?\]\]/g,link);
      line=line.replace(/\*\*([^*]+)\*\*/g,'<strong>$1</strong>');
      if(/^### /.test(line)){if(inList){out.push('</ul>');inList=false}out.push('<h3>'+line.slice(4)+'</h3>');continue}
      if(/^## /.test(line)){if(inList){out.push('</ul>');inList=false}out.push('<h2>'+line.slice(3)+'</h2>');continue}
      if(/^# /.test(line)){if(inList){out.push('</ul>');inList=false}out.push('<h1>'+line.slice(2)+'</h1>');continue}
      if(/^&gt; ?/.test(line)){if(inList){out.push('</ul>');inList=false}out.push('<blockquote>'+line.replace(/^&gt; ?/,'')+'</blockquote>');continue}
      if(/^[-*] /.test(line)){if(!inList){out.push('<ul>');inList=true}out.push('<li>'+line.slice(2)+'</li>');continue}
      if(inList){out.push('</ul>');inList=false}
      if(line.trim())out.push('<p>'+line+'</p>');
    }
    if(inList)out.push('</ul>');
    return out.join('');
  }
  function empty(text){return '<div class="empty">'+esc(text)+'</div>'}
  function card(title,body,extra){return '<div class="card"><h2>'+esc(title)+'</h2>'+(extra||'')+body+'</div>'}
  function button(action,label,cls,data){return '<button data-action="'+action+'"'+(data||'')+(cls?' class="'+cls+'"':'')+'>'+esc(label)+'</button>'}
  function evidenceBlock(list){
    if(!list||!list.length)return '';
    return '<details class="evidence" open><summary>原始出处（'+list.length+'）</summary>'+list.map(function(e){
      return '<div class="evidence-item"><div class="row" style="justify-content:space-between"><strong>'+esc(e.title||'素材')+'</strong>'+button('openSource','查看素材','',' data-id="'+esc(e.sourceId)+'"')+'</div><blockquote>'+esc(e.context||e.quote)+'</blockquote><small>引文：'+esc(e.quote)+'</small></div>';
    }).join('')+'</details>';
  }
  function captureCard(){
    var sessions=state.sessions||[];
    var options=sessions.length?sessions.map(function(s){return '<option value="'+esc(s.id)+'">'+esc(s.title)+' · '+esc(s.status)+'</option>'}).join(''):'<option value="">（暂无会话，或工作台状态暂不可用）</option>';
    return card('自动采集',
      '<p class="muted">把 <code>.md / .txt</code> 文件放进插件目录的 <code>raw/inbox/</code>，会自动成为不可变素材；相同内容只导入一次，处理后归档到 <code>imported/</code>。</p>'+
      '<label>从工作台会话沉淀<select data-field="session">'+options+'</select></label>'+
      '<div class="row" style="margin-top:8px">'+button('captureSession','存入素材','primary')+button('refreshSessions','刷新会话')+'</div><p id="captureStatus" class="muted"></p>');
  }

  function setTab(name){
    state.tab=name;
    document.querySelectorAll('.tabs [data-tab]').forEach(function(node){node.classList.toggle('active',node.dataset.tab===name)});
    document.querySelectorAll('aside [data-for]').forEach(function(node){node.hidden=node.dataset.for!==name});
    document.querySelectorAll('article [data-panel]').forEach(function(node){node.classList.toggle('active',node.dataset.panel===name)});
    render();
  }
  // Only the active panel is rebuilt: a background refresh must never wipe a
  // form the user is typing into (schema, skill body, review feedback, ...).
  function render(){
    renderStatus();
    if(state.tab==='wiki')renderPage();
    else if(state.tab==='sources')renderSource();
    else if(state.tab==='review')renderReview();
    else if(state.tab==='ask')renderAsk();
    else if(state.tab==='skills')renderSkill();
    else if(state.tab==='settings')renderSettings();
  }
  function renderListsOnly(){renderStatus();renderPageList();renderSourceList();renderDraftList();renderAnswerList();renderSkillList()}

  function renderStatus(){
    var s=state.status;if(!s)return;
    $('statusDot').className='dot'+(s.ready?' ok':'');
    $('statusText').textContent=s.ready?s.pages+' 页 · '+s.sources+' 素材 · '+s.pendingDrafts+' 待审阅':'未配置模型 Key';
    $('draftCount').hidden=!s.pendingDrafts;$('draftCount').textContent=s.pendingDrafts;
  }
  // ---- Pages
  function renderPageList(){
    var q=($('pageSearch').value||'').toLowerCase();
    var rows=state.pages.filter(function(p){return !q||(p.title+' '+p.summary).toLowerCase().indexOf(q)>=0});
    $('pageList').innerHTML=rows.length?rows.map(function(p){
      return '<button class="item'+(state.page===p.slug?' selected':'')+'" data-action="openPage" data-slug="'+esc(p.slug)+'"><strong>'+esc(p.title)+'</strong><span>'+esc(p.summary||'（无摘要）')+' · '+p.backlinks+' 入链</span></button>';
    }).join(''):empty('还没有页面。先添加素材并编译提案。');
  }
  function renderPage(){
    renderPageList();var host=$('pageView');
    if(state.newPage){
      host.innerHTML=card('新建页面','<label>页面名称（slug）<input data-field="slug" placeholder="例如：向量检索"></label><label>标题<input data-field="title"></label><label>一句话摘要<input data-field="summary"></label><label>正文（支持 [[双向链接]]）<textarea data-field="body" rows="14" maxlength="30000"></textarea></label><div class="row" style="margin-top:10px">'+button('savePage','保存页面','primary')+button('cancelPage','取消')+'</div>');return;
    }
    if(!state.page){host.innerHTML=empty('从左侧选择一个页面，或点 ＋ 新建。');return}
    call('get_page',{slug:state.page}).then(function(result){
      if(!result||state.page!==result.page.slug||state.tab!=='wiki')return;
      var p=result.page;
      if(state.editing){
        host.innerHTML=card('编辑「'+p.title+'」','<label>标题<input data-field="title" value="'+esc(p.title)+'"></label><label>摘要<input data-field="summary" value="'+esc(p.summary)+'"></label><label>类型<select data-field="kind">'+Object.keys(kindName).map(function(k){return '<option value="'+k+'"'+(k===p.kind?' selected':'')+'>'+kindName[k]+'</option>'}).join('')+'</select></label><label>正文<textarea data-field="body" rows="18" maxlength="30000">'+esc(p.body)+'</textarea></label><p class="muted">人工编辑的页面不会被自动编译覆盖。</p><div class="row">'+button('savePage','保存','primary')+button('cancelEdit','取消')+'</div>');
        return;
      }
      var meta='<p><span class="badge">'+esc(kindName[p.kind]||p.kind)+'</span>'+(p.humanEdited?'<span class="badge warn">人工编辑</span>':'')+'<span class="badge">'+p.sources.length+' 个来源</span><span class="badge">更新 '+esc(date(p.updatedAt))+'</span></p>';
      var links='<p class="muted">反向链接：'+(result.backlinks.length?result.backlinks.map(function(slug){return '<button class="wikilink" data-action="openPage" data-slug="'+esc(slug)+'">'+esc(slug)+'</button>'}).join('、'):'无')+'</p>';
      var history=result.history.length?'<details><summary>历史版本（'+result.history.length+'）</summary>'+result.history.map(function(h){return '<div class="row"><small>'+esc(date(h.at))+'</small>'+button('revertPage','恢复','',(' data-name="'+esc(h.name)+'" data-slug="'+esc(p.slug)+'"'))+'</div>'}).join('')+'</details>':'';
      host.innerHTML='<div class="card"><div class="row" style="justify-content:space-between"><div><h2>'+esc(p.title)+'</h2><p class="muted">'+esc(p.summary)+'</p></div><div class="row">'+button('editPage','编辑')+button('deletePage','删除','danger')+'</div></div>'+meta+'<hr><div class="markdown">'+markdown(p.body)+'</div>'+links+evidenceBlock(result.excerpts)+history+'</div>';
    }).catch(err);
  }
  // ---- Sources
  function renderSourceList(){
    $('sourceList').innerHTML=state.sources.length?state.sources.map(function(s){
      return '<button class="item'+(state.source===s.id?' selected':'')+'" data-action="openSource" data-id="'+esc(s.id)+'"><strong>'+esc(s.title)+'</strong><span>'+esc(date(s.createdAt))+' · '+s.length+' 字 · '+s.images+' 图 '+(s.compiled?'· 已编译':'· 待编译')+'</span></button>';
    }).join(''):empty('还没有原始素材。');
  }
  function renderSource(){
    renderSourceList();var host=$('sourceView');
    if(state.newSource){
      host.innerHTML=card('新增原始素材','<label>标题<input data-field="title" placeholder="例如：一篇关于向量检索的文章"></label><label>正文（最多约 3 万字）<textarea data-field="text" rows="14" maxlength="30000" placeholder="粘贴文章、会议记录或你的随手笔记…"></textarea></label><label>图片（可选，自动压缩后逐张上传）<input type="file" data-field="images" accept="image/png,image/jpeg,image/webp,image/gif" multiple></label><div id="imagePreview" class="row"></div><p class="muted">文本与图片进入 raw/ 后不可修改；模型只读取它们。</p><div class="row">'+button('saveSource','保存并编译','primary')+button('cancelSource','取消')+'</div><p id="sourceProgress" class="muted"></p>');
      var input=document.querySelector('[data-field="images"]');
      if(input)input.onchange=function(){var files=Array.prototype.slice.call(input.files||[]).slice(0,4),box=$('imagePreview');box.innerHTML='';files.forEach(function(file){compressImage(file,function(image){var img=document.createElement('img');img.src='data:'+image.mime+';base64,'+image.base64;img.className='img-preview';box.appendChild(img)})})};
      return;
    }
    if(!state.source){host.innerHTML=captureCard()+empty('从左侧选择素材，或点 ＋ 新增。');return}
    call('get_source',{id:state.source}).then(function(result){
      if(!result||state.source!==result.id||state.tab!=='sources')return;
      var images=result.images.length?'<p class="muted">附件：'+result.images.length+' 张图片'+(result.hasVision?'（已生成图片理解）':'')+'</p>':'';
      var vision=result.vision?'<h3>图片理解</h3><div class="markdown">'+markdown(result.vision)+'</div>':'';
      host.innerHTML='<div class="card"><div class="row" style="justify-content:space-between"><div><h2>'+esc(result.title)+'</h2><p class="muted">'+esc(date(result.createdAt))+' · 素材 ID '+esc(result.id.slice(0,8))+'</p></div><div class="row">'+button('compileSource','重新编译','primary',' data-id="'+esc(result.id)+'"')+button('deleteSource','删除','danger',' data-id="'+esc(result.id)+'"')+'</div></div>'+images+vision+'<hr><div class="markdown">'+markdown(result.text.slice(0,8000))+'</div></div>';
    }).catch(err);
  }
  function compressImage(file,done){
    var reader=new FileReader();
    reader.onload=function(){
      var image=new Image();
      image.onload=function(){
        var scale=Math.min(1,1024/Math.max(image.width,image.height)),canvas=document.createElement('canvas');
        canvas.width=Math.max(1,Math.round(image.width*scale));canvas.height=Math.max(1,Math.round(image.height*scale));
        canvas.getContext('2d').drawImage(image,0,0,canvas.width,canvas.height);
        var quality=0.78,data=canvas.toDataURL('image/jpeg',quality);
        while(data.length>58000&&quality>0.3){quality-=0.08;data=canvas.toDataURL('image/jpeg',quality)}
        done({mime:'image/jpeg',base64:data.split(',')[1]});
      };
      image.onerror=function(){err('图片读取失败：'+file.name)};
      image.src=reader.result;
    };
    reader.readAsDataURL(file);
  }
  // ---- Review
  function renderDraftList(){
    $('draftList').innerHTML=state.drafts.length?state.drafts.map(function(d){
      var badge=d.status==='pending'?'<span class="badge warn">待审阅</span>':d.status==='approved'?'<span class="badge good">已发布</span>':'<span class="badge">已拒绝</span>';
      return '<button class="item'+(state.draft===d.id?' selected':'')+'" data-action="openDraft" data-id="'+esc(d.id)+'"><strong>'+esc(d.sourceTitle)+' '+badge+'</strong><span>'+esc(date(d.createdAt))+' · '+d.pages.length+' 页</span></button>';
    }).join(''):empty('还没有编译提案。到「素材」添加内容。');
  }
  function renderReview(){
    renderDraftList();var host=$('draftView');
    if(!state.draft){host.innerHTML=empty('选择一个提案查看逐页 diff，批准后才写入 wiki。');return}
    call('get_draft',{id:state.draft}).then(function(draft){
      if(!draft||state.draft!==draft.id||state.tab!=='review')return;
      var pages='<div class="stack">'+draft.pages.map(function(p){return '<div class="row"><button data-action="draftPage" data-slug="'+esc(p.slug)+'" class="grow'+(state.draftSlug===p.slug?' active':'')+'">'+esc(p.title)+' · '+(p.action==='create'?'新建':p.action==='update'?'更新':'跳过')+'</button><small>'+esc(p.summary||'')+'</small></div>'}).join('')+'</div>';
      var contradictions=draft.contradictions.length?'<div class="card"><h3>发现的矛盾</h3><ul>'+draft.contradictions.map(function(c){return '<li>'+esc(c)+'</li>'}).join('')+'</ul></div>':'';
      var feedback=draft.feedback.length?'<p class="muted">历史反馈：'+esc(draft.feedback.join('；'))+'</p>':'';
      var actions=draft.status==='pending'?'<div class="row">'+button('approveDraft','批准并发布','primary')+button('rejectDraft','拒绝','danger')+'</div><label>拒绝反馈（会注入下次编译）<textarea data-field="feedback" rows="2" maxlength="500" placeholder="例如：概述太笼统，需要具体例子"></textarea></label>':'<p class="muted">此提案已处理。</p>';
      host.innerHTML='<div class="card"><div class="row" style="justify-content:space-between"><div><h2>'+esc(draft.sourceTitle)+'</h2><p class="muted">'+esc(draft.summary)+' · 模型 '+esc(draft.model)+' · '+esc(date(draft.createdAt))+'</p></div><span class="badge">'+esc(draft.status)+'</span></div>'+feedback+actions+'</div>'+contradictions+card('页面提案',pages)+'<div id="draftDiff"></div>';
      if(state.draftSlug)loadDraftPage(draft.id,state.draftSlug);
    }).catch(err);
  }
  function loadDraftPage(id,slug){
    call('draft_page',{id:id,slug:slug}).then(function(page){
      if(!page||state.draftSlug!==slug)return;
      var box=$('draftDiff');if(!box)return;
      box.innerHTML='<div class="card"><h3>'+esc(page.title)+' · 变更预览</h3><div class="diff">'+page.diff.map(function(row){return '<div class="'+row.type+'">'+(row.type==='add'?'+ ':row.type==='del'?'- ':'  ')+esc(row.text)+'</div>'}).join('')+'</div></div>';
    }).catch(err);
  }
  // ---- Ask
  function renderAnswerList(){
    $('answerList').innerHTML=state.answers.length?state.answers.map(function(a,i){return '<button class="item'+(state.answer===i?' selected':'')+'" data-action="openAnswer" data-index="'+i+'"><strong>'+esc(a.question)+'</strong><span>'+esc(date(a.at))+' · '+a.citations.length+' 引用</span></button>'}).join(''):empty('还没有提问记录。');
  }
  function renderAsk(){
    renderAnswerList();var host=$('answerView');
    var a=state.answer===null?null:state.answers[state.answer];
    if(!a)return;
    host.innerHTML='<div class="card"><h2>'+esc(a.question)+'</h2><div class="answer markdown">'+markdown(a.answer)+'</div><div class="citations">'+a.citations.map(function(slug){return button('openPage',slug,'',' data-slug="'+esc(slug)+'"')}).join('')+'</div>'+evidenceBlock(a.evidence)+'<div class="row" style="margin-top:10px">'+button('saveAnswer','归档为新页面','primary')+button('openPluginSettings','模型：'+esc(a.model),'ghost')+'</div></div>';
  }
  // ---- Skills
  function renderSkillList(){
    $('skillList').innerHTML=state.skills.length?state.skills.map(function(s){return '<button class="item'+(state.skill===s.name?' selected':'')+'" data-action="openSkill" data-name="'+esc(s.name)+'"><strong>'+esc(s.name)+' '+(s.builtin?'<span class="badge">内置</span>':'<span class="badge good">自定义</span>')+'</strong><span>'+esc(s.description)+'</span></button>'}).join(''):empty('没有 Skill。');
  }
  function renderSkill(){
    renderSkillList();var host=$('skillView');
    var skill=state.skills.find(function(s){return s.name===state.skill});
    if(state.newSkill||skill){
      var name=state.newSkill?'':skill?skill.name:'',description=state.newSkill?'':skill?skill.description:'',kind=skill?skill.kind:'custom',triggers=skill?skill.triggers.join(', '):'';
      host.innerHTML=card(state.newSkill?'新建 Skill':'编辑 Skill',
        '<label>名称（小写字母、数字、横线）<input data-field="name" value="'+esc(name)+'"'+(state.newSkill?'':' readonly')+'></label>'+
        '<label>描述<input data-field="description" value="'+esc(description)+'"></label>'+
        '<label>类型<select data-field="kind">'+['ingest','compile','query','lint','synthesize','custom'].map(function(k){return '<option value="'+k+'"'+(k===kind?' selected':'')+'>'+k+'</option>'}).join('')+'</select></label>'+
        '<label>触发词（逗号分隔）<input data-field="triggers" value="'+esc(triggers)+'"></label>'+
        '<label>指令正文（Markdown，将作为模型 system prompt）<textarea data-field="body" rows="16" maxlength="30000"></textarea></label>'+
        '<p class="muted">同类型的自定义 Skill 会优先于内置版本；用同名保存可覆盖内置指令。</p>'+
        '<div class="row">'+button('saveSkill','保存','primary')+(state.newSkill?'':button('deleteSkill','删除','danger')+button('exportSkill','导出 SKILL.md'))+button('cancelSkill','取消')+'</div><p id="skillStatus" class="muted"></p>');
      var body=document.querySelector('[data-field="body"]');
      if(body)call('get_skill',{name:state.newSkill?'':state.skill}).then(function(value){if(value&&body.isConnected&&!body.value.trim())body.value=value.body}).catch(err);
      return;
    }
    host.innerHTML=card('工作流 Skill','<p>每个 Skill 是一个可编辑的 Markdown 指令模板，对应 LLM Wiki 的 Schema 层：摄入、编译、查询、体检、归档。</p><p class="muted">内置 Skill 可编辑覆盖但不能删除；自定义 Skill 可自由增删改查，导出的 SKILL.md 与工作台 Agent 的技能格式兼容。</p><div class="row">'+button('newSkill','新建 Skill','primary')+'</div><details><summary>导入 SKILL.md</summary><label>粘贴内容<textarea data-field="import" rows="8" maxlength="30000" placeholder="粘贴 SKILL.md 全文（含 --- 头部）"></textarea></label>'+button('importSkill','导入','primary')+'</details><div id="skillExport"></div>');
  }
  // ---- Settings
  function renderSettings(){
    var host=$('settingsView'),s=state.status;if(!s)return;
    var info=card('模型与自动化',
      '<div class="grid2"><div><small>服务地址</small><p>'+esc(s.model.baseURL)+'</p><small>文本模型</small><p>'+esc(s.model.textModel)+'</p></div><div><small>视觉模型</small><p>'+esc(s.model.visionModel||'（未启用）')+'</p><small>API Key</small><p>'+esc(s.model.keyHint)+'</p></div></div>'+
      '<hr><p class="muted">自动编译：'+(s.automation.autoCompile?'开':'关')+' · 自动发布：'+(s.automation.autoApprove?'开':'关（推荐）')+' · 体检间隔：'+(s.automation.lintMinutes||'关闭')+' 分钟 · 上次体检：'+esc(s.lastLint?date(s.lastLint):'尚未运行')+'</p>'+
      '<div class="row">'+button('testConnection','测试连接')+button('openPluginSettings','修改模型配置')+button('runLint','立即体检')+'</div>');
    var key='<div class="card"><h3>API Key（仅存于本机插件私有文件）</h3><label>密钥<input type="password" data-field="apiKey" placeholder="sk-…" autocomplete="off"></label><div class="row" style="margin-top:8px">'+button('setKey','保存密钥','primary')+button('clearKey','清除')+'</div><p class="muted">不会写入插件配置表单，也不会出现在日志里。</p></div>';
    var schema='<div class="card"><h3>Schema 约定</h3><p class="muted">定义页面规范、链接风格与编译边界，会随每次模型调用一起发送。</p><textarea data-field="schema" rows="12" maxlength="30000"></textarea><div class="row" style="margin-top:8px">'+button('saveSchema','保存 Schema','primary')+'</div></div>';
    var file='';
    if(state.file==='schema'){/* schema editor is always visible */}
    else if(state.file){file='<div class="card"><h3>'+esc(state.file==='log'?'log.md':state.file==='index'?'index.md':'体检结果')+'</h3><pre id="fileContent" style="white-space:pre-wrap;max-height:420px;overflow:auto"></pre></div>'}
    var tasks=s.tasks.filter(function(t){return t.status==='queued'||t.status==='running'});
    var progress=tasks.length?'<div class="progress"><span class="spinner"></span>'+esc(tasks[0].label)+' · '+esc(tasks[0].progress)+'</div>':'';
    host.innerHTML=info+progress+key+schema+file;
    if(state.file&&state.file!=='schema')loadFile(state.file);
    var schemaBox=document.querySelector('[data-field="schema"]');
    if(schemaBox)call('schema').then(function(value){if(schemaBox.isConnected&&!schemaBox.value.trim())schemaBox.value=value}).catch(err);
  }
  function loadFile(name){
    if(name==='lint'){call('lint_result').then(function(result){var box=$('fileContent');if(box)box.textContent=result?JSON.stringify(result,null,2):'尚未运行体检。'}).catch(err);return}
    call(name==='log'?'log':'index').then(function(value){var box=$('fileContent');if(box)box.textContent=value||'（空）'}).catch(err);
  }
  // ---- Data
  // Open on a real page instead of an empty detail pane, and never keep a
  // selection that points at a page which has since been deleted.
  function pickPage(){
    if(state.newPage||state.editing)return false;
    if(state.page&&state.pages.some(function(p){return p.slug===state.page}))return false;
    state.page=state.pages.length?state.pages[0].slug:null;
    return true;
  }
  function refreshLists(){
    return Promise.all([call('list_pages'),call('list_sources'),call('list_drafts'),call('list_skills'),call('answers'),call('list_capture_sessions').catch(function(){return []})]).then(function(values){
      state.pages=values[0];state.sources=values[1];state.drafts=values[2];state.skills=values[3];state.answers=values[4];state.sessions=values[5];
      var picked=pickPage();renderListsOnly();
      if(picked&&state.tab==='wiki')renderPage();
    }).catch(err);
  }
  function refreshStatus(){
    return call('status').then(function(value){state.status=value;renderStatus()}).catch(err);
  }
  function startTask(id,origin){
    state.task=id;state.taskOrigin=origin;
    if(origin==='ask')$('askProgress').textContent='正在检索页面并生成回答…';
    pollTask();
  }
  function pollTask(){
    if(!state.task)return;
    call('task',{id:state.task}).then(function(task){
      if(!task||state.task!==task.id)return;
      if(task.status==='queued'||task.status==='running'){
        if(state.taskOrigin==='ask')$('askProgress').textContent=task.progress+'…';
        return;
      }
      var origin=state.taskOrigin;state.task=null;
      if(task.status==='failed'){err(task.error);$('askProgress').textContent='';return}
      if(origin==='ask'){
        if(task.result){state.answers=[task.result].concat(state.answers).slice(0,5);state.answer=0;$('question').value='';renderAsk()}
        $('askProgress').textContent='';
      }else if(origin==='compile'||origin==='review'){
        state.tab='review';setTab('review');return refreshLists().then(refreshStatus);
      }else if(origin==='lint'){
        return refreshStatus();
      }
      return refreshLists();
    }).catch(err);
  }
  // ---- Events
  document.addEventListener('click',function(event){
    var tab=event.target.closest('[data-tab]');
    if(tab){setTab(tab.dataset.tab);return}
    var node=event.target.closest('[data-action]');if(!node)return;
    var action=node.dataset.action,id=node.dataset.id,slug=node.dataset.slug,name=node.dataset.name;
    var go=function(promise,after){promise.then(ok()).then(after||function(){}).catch(err)};
    if(action==='openPage'){state.page=slug;state.editing=false;state.newPage=false;state.tab='wiki';setTab('wiki');return}
    if(action==='newPage'){state.newPage=true;state.page=null;state.editing=false;renderPage();return}
    if(action==='cancelPage'){state.newPage=false;renderPage();return}
    if(action==='editPage'){state.editing=true;renderPage();return}
    if(action==='cancelEdit'){state.editing=false;renderPage();return}
    if(action==='savePage'){var target=state.newPage?val('slug'):state.page;go(call('save_page',{slug:target,title:val('title'),summary:val('summary'),body:val('body'),kind:val('kind')||undefined}),function(){state.newPage=false;state.editing=false;state.page=target;return refreshLists().then(function(){if(state.tab==='wiki')renderPage()})});return}
    if(action==='deletePage'){go(call('delete_page',{slug:state.page}),function(){state.page=null;return refreshLists().then(function(){if(state.tab==='wiki')renderPage()})});return}
    if(action==='revertPage'){go(call('revert_page',{slug:slug,name:node.dataset.name}),function(){return renderPage()});return}
    if(action==='newSource'){state.newSource=true;state.source=null;renderSource();return}
    if(action==='cancelSource'){state.newSource=false;renderSource();return}
    if(action==='openSource'){state.source=id;state.newSource=false;state.tab='sources';setTab('sources');return}
    if(action==='showCapture'){state.source=null;state.newSource=false;state.tab='sources';setTab('sources');return}
    if(action==='refreshSessions'){go(call('list_capture_sessions'),function(list){state.sessions=list;if(state.tab==='sources')renderSource()});return}
    if(action==='captureSession'){
      var sid=val('session');if(!sid){err('请先选择一个会话');return}
      go(call('capture_session',{sessionId:sid}),function(result){
        var box=$('captureStatus');if(box)box.textContent=result.skipped?'会话内容未变化，已跳过。':'已存入 '+result.events+' 条记录，等待编译。';
        return refreshLists();
      });return;
    }
    if(action==='saveSource'){
      var files=Array.prototype.slice.call((document.querySelector('[data-field="images"]')||{}).files||[]).slice(0,4);
      var title=val('title'),text=val('text');
      if(!text.trim()&&!files.length){err('请填写正文或选择图片');return}
      var progress=function(value){var box=$('sourceProgress');if(box)box.textContent=value};
      progress('正在保存素材…');
      call('add_source',{title:title,text:text}).then(function(source){
        var chain=Promise.resolve();
        files.forEach(function(file){chain=chain.then(function(){return new Promise(function(resolve,reject){compressImage(file,function(image){call('add_image',{sourceId:source.id,mime:image.mime,base64:image.base64}).then(resolve,reject)})})})});
        return chain.then(function(){
          progress('图片已保存，正在启动编译…');
          return call('compile',{sourceId:source.id}).then(function(taskId){
            state.newSource=false;state.source=source.id;state.tab='sources';setTab('sources');startTask(taskId,'compile');
            return refreshLists();
          });
        });
      }).catch(function(error){progress('');err(error)});
      return;
    }
    if(action==='compileSource'){go(call('compile',{sourceId:id}),function(taskId){startTask(taskId,'compile')});return}
    if(action==='deleteSource'){go(call('delete_source',{id:id}),function(){state.source=null;return refreshLists().then(function(){if(state.tab==='sources')renderSource()})});return}
    if(action==='openDraft'){state.draft=id;state.draftSlug='';renderReview();return}
    if(action==='draftPage'){state.draftSlug=slug;loadDraftPage(state.draft,slug);document.querySelectorAll('[data-action="draftPage"]').forEach(function(b){b.classList.toggle('active',b.dataset.slug===slug)});return}
    if(action==='approveDraft'){go(call('review_draft',{id:state.draft,action:'approve'}),function(taskId){startTask(taskId,'review')});return}
    if(action==='rejectDraft'){go(call('review_draft',{id:state.draft,action:'reject',feedback:val('feedback')}),function(taskId){startTask(taskId,'review')});return}
    if(action==='ask'){
      var question=$('question').value.trim();if(!question){err('请输入问题');return}
      go(call('ask',{question:question}),function(taskId){$('askProgress').textContent='已提交…';startTask(taskId,'ask')});return;
    }
    if(action==='openAnswer'){state.answer=Number(node.dataset.index);renderAsk();return}
    if(action==='saveAnswer'){
      var a=state.answers[state.answer];if(!a)return;
      go(call('save_answer',{question:a.question,answer:a.answer,citations:a.citations,evidence:(a.evidence||[]).map(function(e){return {sourceId:e.sourceId,quote:e.quote}})}),function(){return refreshLists()});return;
    }
    if(action==='newSkill'){state.newSkill=true;state.skill=null;renderSkill();return}
    if(action==='cancelSkill'){state.newSkill=false;renderSkill();return}
    if(action==='openSkill'){state.skill=name;state.newSkill=false;renderSkill();return}
    if(action==='saveSkill'){
      go(call('save_skill',{name:val('name'),description:val('description'),kind:val('kind'),triggers:val('triggers').split(/[,，]/).map(function(v){return v.trim()}).filter(Boolean),body:val('body')}),function(result){state.skill=result.name;state.newSkill=false;return refreshLists().then(function(){if(state.tab==='skills')renderSkill()})});return;
    }
    if(action==='deleteSkill'){go(call('delete_skill',{name:state.skill}),function(){state.skill=null;return refreshLists().then(function(){if(state.tab==='skills')renderSkill()})});return}
    if(action==='exportSkill'){go(call('export_skill',{name:state.skill}),function(value){var box=$('skillExport');if(!box)return;box.innerHTML='<div class="card"><h3>导出：'+esc(state.skill)+'</h3><textarea rows="12" maxlength="30000" readonly></textarea></div>';box.querySelector('textarea').value=value});return}
    if(action==='importSkill'){go(call('import_skill',{text:val('import')}),function(result){state.skill=result.name;return refreshLists().then(function(){if(state.tab==='skills')renderSkill()})});return}
    if(action==='setKey'){go(call('set_api_key',{value:val('apiKey')}),function(){return refreshStatus().then(function(){if(state.tab==='settings')renderSettings()})});return}
    if(action==='clearKey'){go(call('clear_api_key'),function(){return refreshStatus().then(function(){if(state.tab==='settings')renderSettings()})});return}
    if(action==='testConnection'){go(call('test_connection'),function(value){$('error').textContent='连接成功：'+value});return}
    if(action==='saveSchema'){go(call('save_schema',{value:val('schema')}),function(){$('error').textContent='Schema 已保存'});return}
    if(action==='runLint'){go(call('lint'),function(taskId){startTask(taskId,'lint')});return}
    if(action==='openPluginSettings'){parent.postMessage({kind:'agentberth-plugin-open-settings'},'*');return}
  });
  document.addEventListener('click',function(event){
    var node=event.target.closest('[data-file]');if(!node)return;
    state.file=node.dataset.file;renderSettings();
  });
  $('pageSearch').addEventListener('input',renderPageList);
  $('question').addEventListener('keydown',function(event){if(event.key==='Enter'&&(event.ctrlKey||event.metaKey)){event.preventDefault();var b=$('ask');if(b)b.click()}});

  setTab('wiki');
  refreshStatus().then(refreshLists);
  var ticks=0;
  // refreshLists only repaints the side lists, never the active panel, so a
  // form being edited is safe. Polling it lets inbox imports appear on their
  // own (they do not create a background task and would otherwise be invisible).
  setInterval(function(){refreshStatus();pollTask();ticks++;if(!state.task&&ticks%3===0)refreshLists()},2000);
  setInterval(function(){if(!state.task&&state.tab==='review')refreshLists()},10000);
})();
`;
