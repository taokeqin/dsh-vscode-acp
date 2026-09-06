# Changelog

All notable changes to this extension.

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

## 0.1.0

Unreleased. Initial ACP client, chat panel, and session resume.
