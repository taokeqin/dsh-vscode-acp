# Changelog

All notable changes to this extension.

## 0.3.0

### Composer

- The busy indicator is no longer just a spinner and a counter: it now names what
  the agent is doing as it happens — *Working…*, *Thinking…*, *Running a
  command…*, *Editing files…*, *Writing files…*, *Reading…*, *Searching…*,
  *Searching the web…*, *Planning…* — inferred from the live thought stream and
  the in-flight tool, Claude Code-style. The transcript's transient "Working…"
  row mirrors the same word while it is shown.

### Fixed

- The "Working…" spinner row could fail to appear (or flash past before ever being
  painted) when the busy state travelled back slowly — its display depended on the
  host echoing the busy state at exactly the right moment. The row is now inserted
  synchronously the instant you send, and removed only by real content, turn end,
  or the busy:false that follows a failed send.
- Sending while the agent was still working (e.g. `DSH: Send Selection` during a
  running turn) used to start a second prompt that failed with "already in flight",
  pushing a second round of busy state for the same turn. Such a send is now
  refused up front: your text returns to the input and the running turn keeps its
  spinner.
- In a narrow panel the composer toolbar could clip its right-hand items — the
  busy spinner, Stop and Send — off the visible edge. The toolbar now wraps, and
  the model/effort dropdowns shrink first instead of pushing the spinner away.

## 0.2.0

First release intended for the Marketplace.

### Sessions

- Each session is an editor tab, so closing, dragging, splitting, `Ctrl+Tab`, tab
  groups and *Reopen Closed Editor* are VS Code's own behaviour. Tabs survive a
  window reload.
- The group holding them is locked, so opening a file lands in your code group
  instead of on top of the conversation.
- A session list in the secondary sidebar, and an inline one under the panel's
  **History** button.
- Sessions are listed from disk, so the list works before the agent has started.
  Opening picks the most recent session that actually holds a conversation — ranking
  by timestamp alone landed on empty sessions left behind by failed starts.

### Transcript

- Markdown rendering: headings, fenced and inline code, lists, blockquotes, rules,
  tables, and http(s) links.
- File references such as `src/panel/html.ts:42` open the file and select the cited
  lines. Only paths that resolve inside the workspace become links, so no link
  refuses on click.
- History is rebuilt from dsh's on-disk session log, since ACP replays nothing on
  resume. Best effort: any failure is logged and the panel simply starts empty.
- Reasoning is collapsed with its first line previewed.
- dsh splices runtime context and the skill catalog into conversations as user
  messages; those are filtered out rather than rendered as things you wrote.

### Composer

- Self-drawn dropdowns for model and reasoning effort, per session.
- A context usage ring, restored from the log on resume, with exact figures on hover.
- `/` at the start of a line opens the skill catalog inline.
- Enter during IME composition belongs to the input method, not to sending.

### Reliability

- `dsh` is located across PATH, version-manager directories and the login shell,
  because a Dock-launched VS Code does not inherit your shell PATH.
- The agent child is given a PATH that can reach `node`, which its shebang needs.
- One agent process multiplexes every session; concurrent turns stay isolated.
- Fixed: a restored history (or an error notice) posted before the webview had
  loaded was silently dropped by VS Code; such messages are now queued until the
  page signals ready.
- Fixed: a session tab stayed labelled "new session" forever; a tab created by "+"
  is now named from its first message the moment it is sent, and the label is
  re-checked against the session log after each turn, on focus, and after a window
  reload.
- Fixed: writing to the agent's stdin after it died could raise an uncaught EPIPE;
  the stdio streams now swallow post-death errors, and a failed spawn settles
  pending calls immediately instead of stalling shutdown for seconds.
- Fixed: closing a session tab mid-turn (or while history was restoring) could
  surface "Webview is disposed"; all host→webview posts now tolerate the panel
  being disposed between the guard check and the send.
- Fixed: streaming answers re-parsed and re-rendered the whole message once per
  chunk (quadratic over a long reply). Chunks now coalesce into ~40 ms render
  cycles, and file-existence checks behind clickable paths are cached with a short
  TTL instead of stat'ing every reference on every render.
- Fixed: a huge tool result (e.g. `read` of a large file) was flattened in full
  before being truncated to its one-line summary; the walk now stops at the budget.
- Fixed: when a send fails before the agent ever received it (agent stopped or a
  turn already in flight), the text is restored to the composer for an easy retry
  instead of vanishing as an undelivered bubble.
- Fixed: sidebar list refreshes triggered by tab churn are debounced.
- Fixed: on Windows, a located `.cmd`/`.bat` npm shim is now launched through
  cmd.exe (CreateProcess cannot run a batch file directly); argv is still passed
  as an array.
- Fixed: in a multi-root workspace, sending a selection from a non-first folder is
  refused with an explanation instead of silently chatting about the wrong project.
- A "Working…" row with a spinner now appears inside the transcript while a turn
  is starting, replaced by the first real chunk or tool row — so a silent agent is
  clearly busy even before anything streams.
- The model / reasoning-effort dropdowns stay visible (greyed out) while a turn
  runs instead of disappearing during reasoning.

## 0.1.0

Unreleased. Initial ACP client, chat panel, and session resume.
