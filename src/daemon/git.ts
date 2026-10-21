import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { lstat, open, readlink, realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import type { GitDiff, GitDiffRequest, GitFile, GitOperation, GitRemoteBranch, GitResult, GitStatus } from '../shared/protocol';
import { resolveExecutable } from './executables';
import { terminalEnvironment } from './paths';

const execute = promisify(execFile);
export const MAX_GIT_FILES = 2000;
const MAX_DIFF_BYTES = 256 * 1024;
function repositoryPath(input: string): string {
  const value = process.platform === 'win32' ? input.replaceAll('\\', '/') : input;
  if (!value || value.includes('\0') || path.isAbsolute(value) || path.win32.isAbsolute(value) || value.split('/').some(part => !part || part === '.' || part === '..' || part.toLowerCase() === '.git')) throw new Error('Git 文件路径无效，请刷新后重试');
  return value;
}
export const gitMessage = (text: string) => text.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '').replace(/(https?:\/\/)[^\s/@]+@/gi, '$1***@').replace(/([?&](?:token|access_token|auth|password|key)=)[^&\s]+/gi, '$1***').slice(-16384);
const empty = (root: string, kind: GitStatus['kind'], message?: string): GitStatus => ({ kind, message, busy: false, root, commonDirectory: '', branch: null, head: null, upstream: null, upstreamRemote: null, upstreamBranch: null, ahead: 0, behind: 0, staged: 0, modified: 0, untracked: 0, conflicts: 0, total: 0, files: [], branches: [], remoteBranches: [], remotes: [], operation: null, fetchedAt: null });
export function parseGitStatus(output: string, root: string): GitStatus {
  const result = empty(root, 'repository');
  const records = output.split('\0');
  for (let i=0;i<records.length;i++) {
    const record = records[i];
    if (record.startsWith('# branch.oid ')) result.head = /^[a-f0-9]{40,64}$/.test(record.slice(13)) ? record.slice(13) : null;
    else if (record.startsWith('# branch.head ')) result.branch = record.slice(14) === '(detached)' ? null : record.slice(14);
    else if (record.startsWith('# branch.upstream ')) result.upstream = record.slice(18);
    else if (record.startsWith('# branch.ab ')) { const match = /\+(\d+) -(\d+)/.exec(record); if (match) { result.ahead = Number(match[1]); result.behind = Number(match[2]); } }
    else if (['1','2','u','?'].includes(record[0])) {
      const type = record[0], xy = type === '?' ? '??' : record.split(' ')[1];
      const file: GitFile = { path: type === '?' ? record.slice(2) : record.split(' ').slice(type === '1' ? 8 : type === '2' ? 9 : 10).join(' '), index: xy[0], worktree: xy[1], conflict: type === 'u' };
      if (type === '2') file.originalPath = records[++i];
      result.total++;
      if (type === '?') result.untracked++;
      else if (type === 'u') result.conflicts++;
      else { if (xy[0] !== '.') result.staged++; if (xy[1] !== '.') result.modified++; }
      if (result.files.length < MAX_GIT_FILES) result.files.push(file);
    }
  }
  return result;
}
class GitCommandError extends Error {
  constructor(readonly code: number | null, readonly output: string) { super(gitMessage(output) || `Git 退出码 ${code ?? '未知'}`); }
}
export class GitWorkspace {
  private binary: Promise<string> | null = null;
  private active = new Map<AbortController, Promise<unknown>>();
  private statuses = new Map<string, Promise<GitStatus>>();
  private locks = new Set<string>();
  private closing = false;
  constructor(private networkTimeout = 120000) {}
  private executable(): Promise<string> {
    return this.binary ??= resolveExecutable('git').catch(() => { this.binary = null; throw new Error('找不到 Git，请安装 Git for Windows 或将 git 加入 PATH 后刷新'); });
  }
  private async command(cwd: string, args: string[], network = false, input?: string, allowedExitCodes = [0]): Promise<string> {
    if (this.closing) throw new Error('后台正在退出');
    const binary = await this.executable();
    if (this.closing) throw new Error('后台正在退出');
    if (this.active.size >= 24) throw new Error('Git 正在处理其他请求，请稍后刷新');
    const controller = new AbortController();
    const task = new Promise<string>((resolve,reject) => {
      const env = terminalEnvironment();
      for (const key of Object.keys(env)) if (/^GIT_(?:DIR|WORK_TREE|COMMON_DIR|INDEX_FILE|OBJECT_DIRECTORY|ALTERNATE_OBJECT_DIRECTORIES|CONFIG_COUNT|CONFIG_KEY_\d+|CONFIG_VALUE_\d+|CONFIG_PARAMETERS|NAMESPACE|PREFIX|CEILING_DIRECTORIES|DISCOVERY_ACROSS_FILESYSTEM)$/i.test(key)) delete env[key];
      Object.assign(env, { GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'Never', SSH_ASKPASS_REQUIRE: 'never', LC_ALL: 'C', LANG: 'C' });
      if (!network) env.GIT_OPTIONAL_LOCKS = '0';
      const child = spawn(binary, ['--no-pager','-c','color.ui=false','-c','core.quotepath=false','-C',cwd,...args], { env, shell: false, windowsHide: true, detached: process.platform !== 'win32', stdio: ['pipe','pipe','pipe'] });
      child.stdin.on('error', () => {});
      child.stdin.end(input);
      const stdout: Buffer[] = [], stderr: Buffer[] = []; let bytes=0; let failure: Error | null=null; let killing: Promise<void> | null=null;
      const kill = () => killing ??= (async()=>{
        if (!child.pid) return;
        if (process.platform === 'win32') { try { await execute(path.join(process.env.SystemRoot ?? 'C:\\Windows','System32','taskkill.exe'),['/PID',String(child.pid),'/T','/F'],{windowsHide:true,timeout:3000}); } catch { child.kill(); } }
        else { try { process.kill(-child.pid,'SIGKILL'); } catch {} }
      })();
      const fail = (error: Error) => { failure ??= error; void kill(); };
      const abort = () => fail(new Error('Git 操作已取消，后台正在退出'));
      controller.signal.addEventListener('abort',abort,{once:true});
      const timer=setTimeout(()=>fail(new Error(network ? 'Git 远端操作超时，请检查网络和认证；可在终端完成登录后重试' : '读取 Git 状态超时，请稍后刷新')),network ? this.networkTimeout : 10000);
      const consume = (target: Buffer[],chunk: Buffer) => { bytes+=chunk.length; if(bytes>8*1024*1024) fail(new Error('Git 返回内容过多，请在终端检查仓库状态')); else target.push(chunk); };
      child.stdout.on('data',(data:Buffer)=>consume(stdout,data));child.stderr.on('data',(data:Buffer)=>consume(stderr,data));
      child.on('error',error=>{failure??=new Error(`无法运行 Git：${error.message}`);});
      child.on('close',code=>{ clearTimeout(timer); controller.signal.removeEventListener('abort',abort); void (async()=>{ if(killing)await killing; if(failure)throw failure; const out=Buffer.concat(stdout).toString('utf8'),err=Buffer.concat(stderr).toString('utf8');if(code===null||!allowedExitCodes.includes(code))throw new GitCommandError(code,err+'\n'+out);return out+(network && err ? '\n'+err : ''); })().then(resolve,reject); });
    }).finally(()=>this.active.delete(controller));
    this.active.set(controller,task);return task;
  }
  status(cwd: string): Promise<GitStatus> {
    const pending=this.statuses.get(cwd);if(pending)return pending;
    const task=this.inspect(cwd).finally(()=>this.statuses.delete(cwd));this.statuses.set(cwd,task);return task;
  }
  async ignored(cwd: string, paths: string[]): Promise<{ paths: Set<string>; available: boolean; warning?: string }> {
    if (!paths.length) return { paths: new Set(), available: true };
    try {
      const output = await this.command(cwd, ['check-ignore', '-z', '--stdin'], false, paths.join('\0') + '\0', [0, 1]);
      return { paths: new Set(output.split('\0').filter(Boolean).map(value => value.replace(/\/$/, ''))), available: true };
    } catch (error) {
      if (error instanceof GitCommandError && /not a git repository/i.test(error.output)) return { paths: new Set(), available: false };
      return { paths: new Set(), available: false, warning: 'Git 忽略状态暂不可用；仍可浏览和预览文件。' };
    }
  }
  private async inspect(cwd: string): Promise<GitStatus> {
    try {
      const root=await realpath((await this.command(cwd,['rev-parse','--show-toplevel'])).replace(/\r?\n$/,''));
      const [porcelain, refs, remotes, gitDirText, commonText, remoteRefs, fetchConfig] = await Promise.all([
        this.command(root,['status','--porcelain=v2','--branch','-z','--untracked-files=all']),
        this.command(root,['for-each-ref','--format=%(refname:lstrip=2)%00%(upstream:remotename)%00%(upstream:remoteref)%00%(upstream)','refs/heads/']),
        this.command(root,['remote']),this.command(root,['rev-parse','--absolute-git-dir']),this.command(root,['rev-parse','--git-common-dir']),
        this.command(root,['for-each-ref','--format=%(refname)%00%(symref)%00%(objectname)']),
        this.command(root,['config','--null','--get-regexp','^remote\\..*\\.fetch$'], false, undefined, [0,1]),
      ]);
      const result=parseGitStatus(porcelain,root),gitDir=path.resolve(root,gitDirText.replace(/\r?\n$/,''));
      result.commonDirectory=await realpath(path.resolve(root,commonText.replace(/\r?\n$/,'')));
      const rows=refs.trimEnd().split('\n').filter(Boolean).map(line=>line.split('\0'));
      result.branches=rows.map(row=>row[0]).slice(0,500);
      const branch=rows.find(row=>row[0]===result.branch);
      result.upstreamRemote=branch?.[1] || null;result.upstreamBranch=branch?.[2]?.replace(/^refs\/heads\//,'') || null;
      result.remotes=remotes.trim().split(/\r?\n/).filter(Boolean);
      const exclusions = new Map<string, string[]>();
      const mappings: { remote: string; source: string; destination: string }[] = [];
      for (const record of fetchConfig.split('\0').filter(Boolean)) {
        const newline = record.indexOf('\n'), key = record.slice(0, newline), spec = record.slice(newline + 1).replace(/^\+/, '');
        const remote = result.remotes.find(name => key === `remote.${name}.fetch`);
        if (!remote) continue;
        if (spec.startsWith('^')) { exclusions.set(remote, [...(exclusions.get(remote) ?? []), spec.slice(1)]); continue; }
        const colon = spec.indexOf(':');
        if (colon > 0 && spec.startsWith('refs/heads/')) mappings.push({ remote, source: spec.slice(0, colon), destination: spec.slice(colon + 1) });
      }
      const remoteBranches: GitRemoteBranch[] = [], seen = new Set<string>();
      const localUpstreams = new Map<string, string[]>();
      for (const row of rows) {
        if (!row[3]) continue;
        const key = row[1] + '\0' + row[2] + '\0' + row[3];
        localUpstreams.set(key, [...(localUpstreams.get(key) ?? []), row[0]]);
      }
      for (const line of remoteRefs.trimEnd().split('\n').filter(Boolean)) {
        const [ref, symbolic, head] = line.split('\0');
        if (symbolic || !/^[a-f0-9]{40,64}$/.test(head)) continue;
        for (const mapping of mappings) {
          const wildcard = mapping.destination.indexOf('*');
          let source: string;
          if (wildcard < 0) { if (ref !== mapping.destination) continue; source = mapping.source; }
          else {
            const prefix = mapping.destination.slice(0, wildcard), suffix = mapping.destination.slice(wildcard + 1);
            if (!ref.startsWith(prefix) || !ref.endsWith(suffix) || ref.length < prefix.length + suffix.length) continue;
            source = mapping.source.replace('*', ref.slice(prefix.length, suffix ? -suffix.length : undefined));
          }
          const name = source.slice('refs/heads/'.length);
          const key = mapping.remote + '\0' + ref;
          const excluded = (exclusions.get(mapping.remote) ?? []).some(rule => { const star = rule.indexOf('*'); return star < 0 ? source === rule : source.startsWith(rule.slice(0, star)) && source.endsWith(rule.slice(star + 1)); });
          if (!name || seen.has(key) || excluded) continue;
          seen.add(key);
          remoteBranches.push({ ref, remote: mapping.remote, branch: name, head, localBranches: localUpstreams.get(mapping.remote + '\0' + source + '\0' + ref) ?? [] });
        }
      }
      remoteBranches.sort((a,b) => a.remote.localeCompare(b.remote) || a.branch.localeCompare(b.branch));
      result.remoteBranches = remoteBranches.slice(0, 2000);
      result.remoteBranchesTruncated = remoteBranches.length > 2000;

      for(const [file,label] of [['rebase-merge','变基'],['rebase-apply','变基'],['MERGE_HEAD','合并'],['CHERRY_PICK_HEAD','拣选'],['REVERT_HEAD','还原']]) { try {await stat(path.join(gitDir,file));result.operation=label;break;}catch{} }
      try { result.fetchedAt=(await stat(path.join(gitDir,'FETCH_HEAD'))).mtime.toISOString(); } catch {}
      result.busy=this.locks.has(process.platform==='win32'?result.commonDirectory.toLowerCase():result.commonDirectory);
      return result;
    } catch(error) {
      if(error instanceof GitCommandError && /not a git repository|must be run in a work tree/i.test(error.output))return empty(cwd,'not-repository','此项目不在 Git 工作区中');
      return empty(cwd,'unavailable',gitMessage(error instanceof Error?error.message:String(error)));
    }
  }
  private requireRepository(status: GitStatus): void { if(status.kind!=='repository')throw new Error(status.message || '无法读取 Git 仓库'); }
  async diff(cwd: string, request: GitDiffRequest): Promise<GitDiff> {
    const status = await this.status(cwd); this.requireRepository(status);
    const input = repositoryPath(request.path);
    const filename = repositoryPath(request.projectPath ? path.relative(status.root, path.resolve(await realpath(cwd), input)).split(path.sep).join('/') : input);
    const file = status.files.find(item => item.path === filename);
    let patch = '', binary = false, truncated = false;
    if (!request.staged && file?.index === '?') {
      const absolute = path.resolve(status.root, filename), parent = await realpath(path.dirname(absolute));
      const relative = path.relative(status.root, parent);
      if (relative === '..' || relative.startsWith('..' + path.sep) || path.isAbsolute(relative)) throw new Error('文件位于仓库之外');
      const info = await lstat(absolute);
      let content: string;
      if (info.isSymbolicLink()) content = await readlink(absolute);
      else {
        if (!info.isFile()) throw new Error('只能查看文件差异');
        const handle = await open(absolute, 'r');
        try {
          const buffer = Buffer.alloc(MAX_DIFF_BYTES + 1), { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
          truncated = bytesRead > MAX_DIFF_BYTES;
          const bytes = buffer.subarray(0, Math.min(bytesRead, MAX_DIFF_BYTES));
          binary = bytes.includes(0);
          try { content = new TextDecoder('utf-8', { fatal: true }).decode(bytes, { stream: truncated }); } catch { binary = true; content = ''; }
        } finally { await handle.close(); }
      }
      if (!binary && content) {
        const lines = content.split('\n'); if (lines.at(-1) === '') lines.pop();
        patch = `diff --git a/${filename} b/${filename}\nnew file mode ${info.isSymbolicLink() ? '120000' : '100644'}\n--- /dev/null\n+++ b/${filename}\n@@ -0,0 +1,${lines.length} @@\n` + lines.map(line => '+' + line).join('\n') + '\n' + (!content.endsWith('\n') ? '\\ No newline at end of file\n' : '');
      }
    } else {
      patch = await this.command(status.root, ['--literal-pathspecs', 'diff', '--no-ext-diff', '--no-textconv', '--no-color', '--unified=3', '--src-prefix=a/', '--dst-prefix=b/', ...(request.staged ? ['--cached'] : []), '--', filename, ...(file?.originalPath ? [file.originalPath] : [])]);
      binary = /^Binary files .* differ$/m.test(patch) || /^GIT binary patch$/m.test(patch);
    }
    if (patch.length > MAX_DIFF_BYTES) { patch = patch.slice(0, MAX_DIFF_BYTES); truncated = true; }
    return { path: filename, staged: request.staged, patch, binary, truncated, ...(!patch ? { message: binary ? '二进制文件已更改，无法显示文本差异。' : file?.index === '?' ? '新文件为空，暂存后可提交。' : '当前比较中没有差异。' } : {}) };
  }
  private verify(status: GitStatus, expected: GitOperation['expected']): void {
    this.requireRepository(status);
    if(status.root!==expected.root || status.branch!==expected.branch || status.head!==expected.head)throw new Error('分支、提交或仓库已变化，请刷新后重新操作');
  }
  private requireReady(status: GitStatus): void {
    if(status.conflicts)throw new Error('工作区存在冲突，请先在终端解决冲突后重试');
    if(status.operation)throw new Error(`仓库正在${status.operation}，请先在终端完成或取消该操作`);
  }
  async operate(cwd: string, request: GitOperation): Promise<GitResult> {
    let status=await this.inspect(cwd);this.verify(status,request.action==='fetch'?{...request.expected,branch:status.branch,head:status.head}:request.expected);
    const key=process.platform==='win32'?status.commonDirectory.toLowerCase():status.commonDirectory;
    if(this.locks.has(key))throw new Error('此仓库正在进行 Git 操作，请稍后重试');
    if(this.locks.size>=2)throw new Error('已有两个 Git 操作在执行，请稍后重试');
    this.locks.add(key);const output: string[]=[];let completed='';
    try {
      // Re-read after acquiring our repository lock; a preceding operation may
      // have completed while the initial inspection was in flight.
      status = await this.inspect(cwd);
      this.verify(status, request.action === 'fetch' ? { ...request.expected, branch: status.branch, head: status.head } : request.expected);
      if (request.action === 'stage' || request.action === 'unstage') {
        if (!request.paths?.length) throw new Error('请先选择文件');
        const selected = [...new Set(request.paths.map(repositoryPath))].map(filename => {
          const file = status.files.find(item => item.path === filename);
          if (!file || (request.action === 'unstage' && (file.index === '.' || file.index === '?')) || (request.action === 'stage' && file.worktree === '.' && !file.conflict)) throw new Error('所选文件状态已变化，请刷新后重新选择');
          return file;
        });
        const paths = [...new Set(selected.flatMap(file => file.originalPath && (request.action === 'unstage' ? file.index === 'R' : file.worktree === 'R') ? [file.path, file.originalPath] : [file.path]))];
        if (request.action === 'stage') await this.command(status.root, ['--literal-pathspecs', 'add', '--all', '--', ...paths], true);
        else if (status.head) await this.command(status.root, ['--literal-pathspecs', 'reset', '--quiet', status.head, '--', ...paths], true);
        else await this.command(status.root, ['--literal-pathspecs', 'rm', '--cached', '--force', '--quiet', '--ignore-unmatch', '--', ...paths], true);
        completed = `已${request.action === 'stage' ? '暂存' : '取消暂存'} ${selected.length} 个文件`;
      } else if (request.action === 'commit') {
        this.requireReady(status);
        if (!status.staged) throw new Error('没有已暂存的更改，请先暂存要提交的文件');
        if (!request.message?.trim()) throw new Error('请填写提交信息');
        output.push(await this.command(status.root, ['commit', '--file=-', '--cleanup=strip'], true, request.message.trim() + '\n'));
        completed = '已提交暂存的更改';
      } else if (request.action === 'switchRemote') {
        this.requireReady(status);
        const target = status.remoteBranches?.find(item => item.ref === request.remoteRef && item.remote === request.remote && item.branch === request.branch);
        if (!target) throw new Error('远端分支已变化或未获取，请获取远端后重新选择');
        if (!request.remoteHead || request.remoteHead !== target.head) throw new Error('远端分支提交已变化，请刷新后重新选择');
        const local = request.localBranch || (target.localBranches.includes(target.branch) ? target.branch : target.localBranches[0]) || target.branch;
        if (local === 'HEAD' || local.startsWith('-') || local.startsWith('@{-')) throw new Error('本地分支名称无效');
        await this.command(status.root, ['check-ref-format', '--branch', local]);
        const exists = (await this.command(status.root, ['for-each-ref', '--format=%(refname)', 'refs/heads/' + local])).split(/\r?\n/).includes('refs/heads/' + local);
        if (exists) {
          if (!target.localBranches.includes(local)) throw new Error(`本地分支 ${local} 已存在且未跟踪 ${target.remote}/${target.branch}；请更换本地分支名称，或在本地分支列表中切换`);
          await this.command(status.root, ['switch', '--no-guess', '--', local], true);
          completed = `已切换到 ${local}（跟踪 ${target.remote}/${target.branch}）`;
        } else {
          await this.command(status.root, ['switch', '--track', '--create', local, '--', target.ref], true);
          completed = `已创建并切换到 ${local}（跟踪 ${target.remote}/${target.branch}）`;
        }
      } else if(request.action==='switch') {
        this.requireReady(status);
        if(!request.branch || !status.branches.includes(request.branch))throw new Error('请选择已有的本地分支，刷新后重试');
        await this.command(status.root,['switch','--',request.branch],true);
        completed=`已切换到 ${request.branch}`;
      } else {
        const remote=request.remote;
        if(!remote || !status.remotes.includes(remote))throw new Error('请选择仓库中已配置的远端');
        if(request.action!=='fetch') {
          if(!status.branch || !status.head)throw new Error('游离 HEAD 或尚无提交，不能同步或推送；请先在终端建立分支和提交');
          if(status.operation || status.conflicts)throw new Error('仓库有未完成的合并或冲突，请先在终端处理');
          if(status.upstream && status.upstreamRemote!==remote)throw new Error(`当前分支跟踪 ${status.upstream}，请选择其远端`);
        }
        if(['pull','sync'].includes(request.action))this.requireReady(status);
        const target=status.upstreamBranch || status.branch;
        if(request.action!=='fetch' && request.branch!==target)throw new Error('远端目标分支已变化，请刷新后重新操作');
        if(request.action==='pull' && !status.upstream)throw new Error('当前分支没有远端上游，请先推送发布此分支');
        if(request.action==='fetch' || (status.upstream && ['pull','sync'].includes(request.action))) {
          output.push(await this.command(status.root,['fetch',...(request.action==='fetch'?['--prune']:[]),'--no-auto-gc','--no-tags','--no-recurse-submodules','--',remote,...(request.action==='fetch'?[]:['refs/heads/'+target])],true));
          completed='已获取远端更新';
          const fresh=await this.inspect(cwd);this.verify(fresh,request.action==='fetch'?{...request.expected,branch:fresh.branch,head:fresh.head}:request.expected);status=fresh;
          if(request.action!=='fetch' && (fresh.upstreamRemote!==remote || fresh.upstreamBranch!==target))throw new Error('上游配置已变化，请刷新重试');
          if(['pull','sync'].includes(request.action)) {
            this.requireReady(status);
            const fetched=(await this.command(status.root,['rev-parse','--verify','FETCH_HEAD'])).trim();
            if(!/^[a-f0-9]{40,64}$/.test(fetched))throw new Error('获取的远端提交无效，请刷新重试');
            output.push(await this.command(status.root,['-c','merge.autoStash=false','merge','--ff-only','--no-edit','--no-autostash',fetched],true));
            completed='已快进拉取远端提交';status=await this.inspect(cwd);this.requireRepository(status);
            if(status.branch!==request.expected.branch)throw new Error('拉取后分支发生变化，请刷新检查');
          }
        }
        if(request.action==='push' || (request.action==='sync' && (!status.upstream || status.ahead>0))) {
          const before=await this.inspect(cwd);this.verify(before,{root:status.root,branch:status.branch,head:status.head});
          if(before.upstreamRemote!==status.upstreamRemote || before.upstreamBranch!==status.upstreamBranch)throw new Error('上游配置已变化，请刷新重试');
          status=before;
          if(status.operation || status.conflicts)throw new Error('仓库有未完成的合并或冲突，请先在终端处理');
          // Pin the source commit so concurrent CLI commits cannot be pushed implicitly.
          output.push(await this.command(status.root,['-c',`remote.${remote}.mirror=false`,'push','--porcelain','--no-follow-tags','--recurse-submodules=no','--',remote,`${status.head}:refs/heads/${target}`],true));
          completed=completed ? completed+'，已推送本地提交' : '已推送本地提交';
          if(!status.upstream) {
            const fresh=await this.inspect(cwd);this.verify(fresh,{root:status.root,branch:status.branch,head:status.head});
            await this.command(status.root,['config',`branch.${status.branch}.remote`,remote],true);
            await this.command(status.root,['config',`branch.${status.branch}.merge`,'refs/heads/'+target],true);
            completed+='并设置上游';
          }
        }
      }
      const updated=await this.inspect(cwd);
      updated.busy=false;
      return {status:updated,message:completed,output:gitMessage(output.join('\n'))};
    } catch(error) {
      const detail=gitMessage(error instanceof Error?error.message:String(error));
      const hint=/would be overwritten/i.test(detail)?'操作会覆盖本地改动，Git 已拒绝；请先提交或用 git stash 保存相关改动后重试。\n':/not possible to fast-forward|cannot fast-forward/i.test(detail)?'本地与远端已分叉，无法快进；请在终端合并或变基后重试。\n':'';
      throw new Error((completed?completed+'；后续步骤未完成：':'')+hint+detail);
    }
    finally { this.locks.delete(key); }
  }
  async close(): Promise<void> {this.closing=true;for(const controller of this.active.keys())controller.abort();await Promise.allSettled([...this.active.values()]);}
}
