# MVP implementation notes

## Identity

A project owns a canonical directory. A session owns a title, agent type, launch configuration, and one optional current native conversation identity. A project/Agent-scoped catalog retains many native histories independently of that current association. A run owns a concrete PTY PID, timestamps, output, and an exit result. Restarting a session adds a run; it never rewrites the earlier run into a supposedly surviving process.

## Lifetime

The Electron main process starts the daemon with its own executable in `ELECTRON_RUN_AS_NODE` mode, detached with ignored standard streams. The daemon's PTYs and their pipes are not held by Electron or a renderer. Closing a WebSocket removes subscriptions without touching PTYs. A launcher-exit integration test verifies this lifetime using separate OS processes.

A per-data-directory exclusive lock prevents multiple daemons opening the same metadata database. The endpoint has a version and random token; the daemon binds only to IPv4 loopback. Browser-origin WebSocket handshakes and incorrect tokens are rejected. The renderer never receives the token or an unrestricted filesystem API.

GUI shutdown leaves the daemon running by design. Daemon restart changes live statuses to interrupted and does not replay commands. The wire protocol remains compatible with 0.1 and state advertises API capabilities. A legacy connection retains terminal viewing/stopping and shows a deliberate upgrade action. The main process authenticates the endpoint before replacing an idle legacy daemon; current daemons atomically refuse shutdown when live/starting PTYs or pending operations exist. Active tasks are never upgraded automatically.

## Management and preferences

SQLite migration adds nullable session terminal overrides, the shell executable used by each run, and validated global preferences. Existing IDs, native history and screens are preserved. Renaming keeps running processes unchanged; changing launch settings requires an idle session. Project relocation and agent changes clear incompatible native history links without rewriting previous runs.

Starting sessions reserve their identity before asynchronous directory/executable validation. Project edits and transcript imports also reserve their scope, preventing deletion or incompatible edits from racing with pending operations. Deletions use a transaction to remove foreign-key dependents, including archived sessions and older runs beyond the visible history limit, then remove only workbench log segments. No project directory or original agent transcript is deleted.

Terminal selection resolves a direct executable and argument array; custom executable paths are never parsed as shell command strings. Preferences affect future runs while a per-session override takes precedence. Agent commands run inside the chosen interactive shell.

Renderer caches only selected project/session IDs and a validated settings draft with its base preferences. Drafts remain separate from applied daemon settings, survive page changes and launcher restart, and report an actual base conflict when settings changed elsewhere. Corrupt or unavailable browser storage falls back safely. Dialogs protect dirty values, trap keyboard focus, restore the invoking control, and disable input during submission. The current terminal never takes focus from an open dialog or search field.

A global switcher searches metadata without executing commands. Session duplication uses the existing creation API and copies only launch configuration; it starts unchecked and never copies process or native-conversation identity. Clipboard writes pass through a trusted, size-limited IPC endpoint. Failed directory/executable preflight creates a failed run, preserves the error across daemon restarts, and can be corrected and retried without replacing history.

## Terminal reattachment

Each PTY write receives a monotonic sequence number. The daemon feeds an xterm headless instance and broadcasts output after parsing. An attach request subscribes before obtaining a parser barrier. Its screen and sequence describe the same point. The renderer buffers events while restoring the snapshot and applies only later sequence numbers for the same run ID.

Resizing affects both the PTY and the headless terminal. Hidden views are unmounted and detached; the headless instance continues to parse output. UI subscriptions never control PTY reading. A queued parser byte budget can pause PTY reading when the daemon itself is behind; a slow GUI is closed at a bounded WebSocket backlog.

Terminal scrollback, snapshot length, log segment count, JSONL file size, imported history text, active terminals and pending requests all have bounds. Logs use small synchronous appends in this first version; batching/asynchronous disk writes are a future performance improvement for highly chatty workloads.

## Native conversations

Adapters read explicitly chosen Codex/Claude Code JSONL and OpenCode JSON exports. OpenCode exports retain info.id/directory and message info/parts; UTF-8 and PowerShell UTF-16LE are decoded. Working directories must match the project; native IDs must be shell-safe identifiers. The app imports text without editing the original file. Codex response items are preferred over duplicate events; Claude/OpenCode text parts omit tools and reasoning. A manual native ID association provides a resume action without claiming to import message text.

History refresh is explicit. File-format coverage is intentionally bounded: compressed rollouts, branch graphs, tools, images, and reasoning blocks are not reconstructed. SQLite schema 5 migrates the former single snapshot into a project/Agent-scoped native_histories catalog once. Saved history pagination uses timestamp/ID keyset cursors and metadata-only results. Selecting a row previews its cached or plugin-read messages; explicit association chooses the active snapshot. Unlink clears only the session association and preserves the catalog. Project relocation clears incompatible catalog entries.

Optional plugin list capability supplies cursor-based project discovery, query and limit; each returned identity and directory is validated. Existing v1 plugins without list remain usable. Preview/discovery never change an association. Running PTYs permit association/unlink without receiving any command. Starting PTYs briefly reserve identity to keep resume construction consistent; imports reserve association writes, while read-only discovery does not block starting a terminal. Failed reads retain both the current snapshot and cached candidates.

## Validation

The normal test runner uses Electron's Node runtime because native node-pty modules are rebuilt for Electron. The desktop test uses Playwright's Electron driver against the production renderer and real preload / IPC / daemon / PTY chain. CI includes Windows (ConPTY) and Linux (PTY), plus a Windows NSIS artifact build after checks.

## Git workspace

Git is an optional installed CLI accessed by a strict RPC allowlist; arbitrary arguments, force-push and destructive reset actions are not exposed. Porcelain v2 NUL records provide bounded file metadata and branch tracking. The topbar refreshes local metadata on focus and every 15 seconds while visible; no background fetch runs.

Operations carry the displayed root, branch, HEAD and remote branch. Mutations recheck this lease, serialize by common Git directory (including linked worktrees), and use explicit remote names and pinned source commits. Pull fetches a pinned commit then only fast-forwards with autostash disabled. A first push sets upstream only after success. Errors report completed stages without attempting rollback.

The daemon reserves all related registered project paths during operations; changing worktree files additionally requires their PTYs and history readers to be idle. Fetch/push leave live terminals alone. Subprocesses use noninteractive credentials, bounded output and deadlines, and are tracked for full quit cleanup. Ordinary paths and filenames never become shell command strings. Fixture tests use local bare remotes and real Git/PTYs, avoiding user repositories and credentials.
