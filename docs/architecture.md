# MVP implementation notes

## Identity

A project owns a canonical directory. A session owns a title, agent type, launch configuration, and an optional native conversation identity. A run owns a concrete PTY PID, timestamps, output, and an exit result. Restarting a session adds a run; it never rewrites the earlier run into a supposedly surviving process.

## Lifetime

The Electron main process starts the daemon with its own executable in `ELECTRON_RUN_AS_NODE` mode, detached with ignored standard streams. The daemon's PTYs and their pipes are not held by Electron or a renderer. Closing a WebSocket removes subscriptions without touching PTYs. A launcher-exit integration test verifies this lifetime using separate OS processes.

A per-data-directory exclusive lock prevents multiple daemons opening the same metadata database. The endpoint has a version and random token; the daemon binds only to IPv4 loopback. Browser-origin WebSocket handshakes and incorrect tokens are rejected. The renderer never receives the token or an unrestricted filesystem API.

GUI shutdown leaves the daemon running by design. Daemon restart changes live statuses to interrupted and does not replay commands. Protocol upgrades must include a deliberate drain/upgrade strategy; version 1 does not automatically replace an existing process.

## Terminal reattachment

Each PTY write receives a monotonic sequence number. The daemon feeds an xterm headless instance and broadcasts output after parsing. An attach request subscribes before obtaining a parser barrier. Its screen and sequence describe the same point. The renderer buffers events while restoring the snapshot and applies only later sequence numbers for the same run ID.

Resizing affects both the PTY and the headless terminal. Hidden views are unmounted and detached; the headless instance continues to parse output. UI subscriptions never control PTY reading. A queued parser byte budget can pause PTY reading when the daemon itself is behind; a slow GUI is closed at a bounded WebSocket backlog.

Terminal scrollback, snapshot length, log segment count, JSONL file size, imported history text, active terminals and pending requests all have bounds. Logs use small synchronous appends in this first version; batching/asynchronous disk writes are a future performance improvement for highly chatty workloads.

## Native conversations

The initial adapters read explicitly chosen Codex and Claude Code JSONL files. Working directories must match the project; native IDs must be shell-safe identifiers. The app imports text without editing the original file. Codex response items are preferred over duplicate message events. Claude text blocks are displayed while tool payloads are excluded.

History refresh is explicit. File-format coverage is intentionally bounded: compressed rollouts, branch graphs, tools, images, and reasoning blocks are not reconstructed. Future automatic discovery must account for concurrent sessions in the same directory instead of binding whichever file happens to have the newest modification time.

## Validation

The normal test runner uses Electron's Node runtime because native node-pty modules are rebuilt for Electron. The desktop test uses Playwright's Electron driver against the production renderer and real preload / IPC / daemon / PTY chain. CI includes Windows (ConPTY) and Linux (PTY), plus a Windows NSIS artifact build after checks.
