# DSH Agent

[![Marketplace](https://img.shields.io/vscode-marketplace/v/hacken.dsh-agent.svg?label=VS%20Marketplace&color=4D6BFE)](https://marketplace.visualstudio.com/items?itemName=hacken.dsh-agent)
[![License: MIT](https://img.shields.io/github/license/taokeqin/dsh-vscode-acp.svg)](https://github.com/taokeqin/dsh-vscode-acp/blob/main/LICENSE)
[![GitHub](https://img.shields.io/badge/source-github.com%2Ftaokeqin%2Fdsh--vscode--acp-181717?logo=github&logoColor=white)](https://github.com/taokeqin/dsh-vscode-acp)

Chat with the [DeepSeek Harness](https://www.npmjs.com/package/@deepseek-ai/dsh)
(`dsh`) coding agent inside VS Code, over ACP — the Agent Client Protocol.

> **Unofficial.** Not affiliated with, endorsed by, or supported by DeepSeek.
> `dsh` and DeepSeek Harness are their names, not this project's.

**Open source (MIT):** the source lives at
[github.com/taokeqin/dsh-vscode-acp](https://github.com/taokeqin/dsh-vscode-acp).
Please report bugs and request features in the
[issue tracker](https://github.com/taokeqin/dsh-vscode-acp/issues).

Sessions are ordinary editor tabs, the transcript renders as Markdown, and the agent
runs as a child process over stdio — no local web server and no port to secure.

## Requirements

- VS Code ^1.91.0
- `dsh` installed and working: `npm i -g @deepseek-ai/dsh`, then run `dsh --profile acp --help`
  once to confirm it starts. Built against dsh `0.1.2-rc.1`.
- A folder open in VS Code. Sessions bind to one workspace root.

The extension finds `dsh` even when VS Code was launched from the Dock and cannot see
your shell PATH; if discovery fails it tells you to set `dshAgent.executablePath`.

## Getting started

1. Open the **DSH** view in the secondary (right) sidebar — `Cmd/Ctrl+Alt+B` toggles it.
2. Press **+** to start a session. It opens as an editor tab beside your code.
3. Type. `Enter` sends, `Shift+Enter` adds a newline.

The whale in the editor title bar (**DSH: Open**) reopens your most recent
conversation from any file.

## Features

- **Sessions as editor tabs** — close, drag, split and *Reopen Closed Editor* all work,
  and tabs survive a window reload. Their group is locked so files never open into it.
- **History restored from disk** — ACP replays nothing on resume, so the transcript is
  rebuilt from dsh's own session log.
- **Markdown transcript** — headings, code, lists, tables, and file references that
  open at the cited line.
- **Context chips** — type `@` in the composer for an inline workspace file list (the
  file in your active editor ranks first), or right-click a file in the explorer
  (**DSH: Add Files to Chat**). Selecting code stages a selection chip for that file
  automatically, unchecked; the checkbox is the include/exclude switch and `×` removes a
  chip. There is no toolbar button for either — `@` and the selection are the entry
  points. The strip is cleared once the message is sent. A file is sent as its `@path`
  reference and read by the agent; a checked selection is sent verbatim (see Known
  limits).
- **Skills** — type `/` at the start of a line for the skill catalog.
- **Model and reasoning effort** — per session, in the composer, alongside a context
  usage ring.

## Commands

| Command |
|---|
| `DSH: Open` |
| `DSH: Session History` |
| `DSH: New Session` |
| `DSH: Refresh Sessions` |
| `DSH: Cancel Current Turn` |
| `DSH: Send Selection to Agent` |
| `DSH: Add Selection to Chat` |
| `DSH: Add Files to Chat` |
| `DSH: Select Model` |
| `DSH: Show Logs` |
| `DSH: Restart Agent Process` |
| `DSH: Open Session` |

## Settings

| Setting | Default | Meaning |
|---|---|---|
| `dshAgent.executablePath` | `"dsh"` | Absolute path to the `dsh` executable. |
| `dshAgent.profile` | `"acp"` | The dsh profile to boot. |
| `dshAgent.resumeLatestSession` | `true` | On open, resume the most recent persisted session for this workspace instead of creating a new one. |
| `dshAgent.showThoughts` | `true` | Render the agent's reasoning (`agent_thought_chunk`) in a collapsed block. |
| `dshAgent.replayHistory` | `true` | On resume, rebuild the transcript from dsh's on-disk session log. |
| `dshAgent.replayMaxEntries` | `200` | Maximum restored transcript entries (most recent kept). |
| `dshAgent.panelColumn` | `"Beside"` | Where a session tab opens. |
| `dshAgent.lockEditorGroup` | `true` | Lock the editor group holding session tabs, so opening a file lands in your code group instead of stacking on top of the conversation. |

## Known limits

- **No slash commands.** ACP exposes no command adapter, and dsh's commands are
  plugin-registered handlers rather than prompt templates, so there is no client-side
  equivalent. Skills work because they are files.
- **No images, MCP mounts, plans or todos** over ACP. See the notes below.
- **Files are referenced, not inlined.** dsh advertises
  `promptCapabilities.embeddedContext: false` and rejects an embedded `resource` block,
  so a file chip becomes the harness's own `@path` mention — the file on disk stays the
  single source of truth, and the agent reads as much of it as it needs. Selected text
  is the exception: it is sent verbatim as a fenced `path:line-line` block, because the
  user pointed at that exact text and it cannot be re-derived from a path.
- **The agent writes files without asking.** The shipped `acp` profile auto-approves
  tool use; see Security notes.
- **Windows is untested.** The code paths exist and are covered by simulated tests,
  but no Windows host was available.

---

The rest of this document is engineering detail: what was measured, what surprised
us, and why the design is what it is.

## Why ACP and not the web GUI

`dsh` ships a full web GUI (`dsh web`), and embedding it in a webview is the
obvious route. It does not work, and the reasons are structural:

- Since dsh `0.1.2-rc.1` the web UI requires auth. `GET /` returns `401`; the
  printed `?token=…` URL sets a `dsh-auth-*` cookie via a `303`.
- That cookie is `SameSite=Strict`. A VS Code webview frames the page **cross-site**,
  so the cookie is never attached to the redirect target. Measured with Chromium/CDP:
  top-level navigation loads the app (`303 → 200`), the same URL inside a cross-site
  iframe gets `303 → 401`.
- Working around it means terminating dsh's auth in a local proxy — a net loss.

ACP has no auth (`authMethods: []`), opens no port, and is a written contract:
the profile "adds no private method, capability, `_meta`, environment variable, or
transport field" and is conformance-tested against the public ACP SDK.

## What you get, and what you don't

ACP is scoped by DeepSeek to automation. Its README says to avoid it "when a human
needs DSH-specific presentation cards, plans, titles, todos, terminal views, or
elicitation". That boundary is real and permanent, not a gap to be filled later.

| Available | Not available over ACP |
|---|---|
| Assistant messages (streamed) | Plans, todos, presentation cards |
| Reasoning (`agent_thought_chunk`) | Terminal views, slash commands, modes |
| Tool-call lifecycle + status | Transcript replay on resume |
| Session list / resume / close | Multiple workspace roots per session |
| Model switching, context usage | Client-side filesystem delegation |

Transcript replay is recovered separately — see below.

## Opening a session

The whale in the editor title bar is **DSH: Open** — the same placement Claude Code
uses for its own (`editor/title`, `navigation` group). One click reveals the visible
session tab, else any open tab, else reopens the most recent session **that holds a
conversation**, else starts a fresh one.

That qualifier matters. A session is created before its first message, so an
untouched one — from a `+` click, or from a start that failed after creating it —
carries the newest timestamp. Ranking by recency alone therefore landed on a blank
session and looked exactly like lost history. The sidebar orders the same way: open
tabs, then conversations, then untouched sessions. Rules live in `src/sessionOrder.ts`,
kept vscode-free so `test/session-order.mjs` can pin them.

Title-bar icons are rendered as images rather than masked like container icons, so
`currentColor` would resolve to black and disappear on dark themes. The title icon
therefore carries a fixed brand blue that reads on both — the same trick Claude
Code's orange logo relies on. The container icon keeps `currentColor`, since VS Code
masks and themes that one.

## Where the session actions live

Inside the panel, in a header row: the session title, **+ New**, and **History** —
which drops a session list *under the button*, in the panel. Switching conversation
should not send you to another part of the window, so it does not focus the sidebar
view. Rows mark which sessions have a tab open and which one you are looking at;
picking the current one does nothing rather than pointlessly resuming it.

The sidebar list and this one are built by the same `SessionCatalog`, so a single
metadata cache serves both instead of each filling its own.

Model and reasoning effort sit in the composer, next to the context ring; Stop
appears there while a turn runs. The ring is left-aligned with them — against the
right edge it read as if it belonged to the Send button.

They started in the editor title bar, following Claude Code, and that was the wrong
read of what Claude Code does. Its `navigation` icons are only *Open*, *Open in
Terminal* and the diff accept/reject; its session actions sit in the `…` overflow,
and `newConversation` is registered for the command palette alone — its button is
drawn inside the webview.

Two failures made the reason concrete:

- `activeWebviewPanelId` is a **global** context key, so guarding session actions
  with it put them in *every* group's title bar the moment a session took focus.
- Keying the whale off `activeWebviewPanelId != …` made it vanish from the code
  group whenever a session was focused and reappear on the way back.

Adding `resourceScheme == 'webview-panel'` narrows the first case, but the whole
approach was betting on undocumented resource semantics for something a webview can
simply own. The editor title bar now carries only the whale, keyed off
`resourceScheme != 'webview-panel'` — what the tab *is*, not what happens to be
focused. Every command stays in the palette. `test/menus.mjs` asserts no menu
depends on `activeWebviewPanelId` at all.

## Transcript replay (best effort, `dshAgent.replayHistory`)

`session/resume` restores the agent's context but replays nothing, so a resumed
panel would start blank while the agent still remembers the conversation. This
extension rebuilds the transcript by reading dsh's on-disk session log.

**This reads dsh's internal format and carries no compatibility promise.** It is
built strictly as a sidecar: every failure returns a reason, the reason goes to the
`DSH Agent` output channel, the panel shows a one-line notice, and chat continues
unaffected. It never throws and is never awaited by the session path. Turn it off
with `dshAgent.replayHistory: false`.

Restored entries render dimmed above a `restored — continuing this session` divider.

## Sessions: editor tabs, sidebar list

Each session is a real `WebviewPanel`, so it is an ordinary editor tab. Closing,
dragging, splitting, `Ctrl+Tab`, tab groups and *Reopen Closed Editor* are VS Code's
behaviour rather than a webview reimplementation of it. Tabs survive a window reload
through a `WebviewPanelSerializer`: the webview persists its `sessionId` and each
restored tab resumes that session.

The session list is a launcher, not a transcript. Sessions with an open tab are
marked, and the visible tab is highlighted, so it doubles as an overview.

It is declared **only** in the secondary (right) sidebar, matching where Claude Code
puts its own view and leaving the left activity bar to file navigation. There is no
setting to move it: VS Code already lets a view be dragged between the primary and
secondary sidebars, so a container in both places would just be clutter.

The **first** session tab opens in the column beside your code
(`dshAgent.panelColumn`, `Beside` or `Active`); every session after that joins that
same group as a tab.

That group is then **locked** (`workbench.action.lockEditorGroup`), which is what
keeps conversations and code apart: a locked group refuses new editors, so opening a
file — from the explorer, Cmd+P, or a tool row — lands in the code group instead of
stacking on top of the chat. Claude Code does the same thing right after creating its
panel. Only a group this extension created is ever locked: with `panelColumn: Active`
the session deliberately shares your group, and locking that would stop you opening
files where you expect. Disable with `dshAgent.lockEditorGroup: false`. `Beside` alone cannot express this — it means "next to whatever
is active", so opening a session while a session tab was focused split the editor
into yet another group each time. The rule lives in `src/panelColumn.ts` and is
pinned by `test/panel-column.mjs`; it also reports whether a group was reused, which
is how locking stays a one-time act rather than being repeated per tab.

Files opened from a tool row go to column One, so code lands next to the chat rather
than on top of it.

This mirrors what Claude Code's own extension does: its bundle uses
`createWebviewPanel` and `registerWebviewPanelSerializer`, it ships commands like
*Open in New Tab*, *Add Session Tab to Group* and *Reopen Closed Session*, and it
declares a separate `claude-sessions-sidebar` list view.

One agent process serves every tab. ACP allows this outright — "one connection can
run several sessions at once, each independent" — and it is covered by the smoke
test: two sessions prompt concurrently on one process, settle in parallel, and
neither sees the other's messages or tool calls.

The sidebar enumerates sessions **from disk**, not from the agent, so it renders on
a fresh window before any process has been spawned. It merges three sources:

| Source | Why |
|---|---|
| `<dshHome>/sessions/<slug>/` | works with no agent running |
| `session/list` when the agent is up | authoritative for resumability (scoped by `cwd`) |
| sessions with an open tab | absent from `session/list`, which returns only **inactive** sessions |

`session/list` is called **with a `cwd`** and the result is filtered again
client-side. Without that argument the agent returns sessions for every workspace it
has ever served — 27 across 11 directories on this machine — which would fill the
sidebar with other projects' conversations.

Delegated sub-agent runs are filtered out by `delegationDepth > 0` — the disk holds
them alongside real conversations (3 of 28 here), and only depth 0 is something the
user started. This is what `session/list` means by "root sessions".

Closing a tab closes the session agent-side, which is required rather than tidy: an
active session never appears in `session/list`, so one left open could never be
reopened.

Entries are labelled with the session title (dsh writes the first user message as a
fallback title, since the acp profile disables model-generated ones) and a relative
timestamp, read from the on-disk log. Metadata uses a 64-frame budget rather than
decompressing the whole log — 2 ms versus ~600 ms per session on the largest one
here — and is cached per window. A session whose metadata cannot be read still
appears, labelled `(no messages yet)`.

A title only exists after the first turn completes, since that is when dsh writes
it; the list refreshes at that point.

### What the log actually looks like

Measured, because none of this is documented:

- Path: `~/.dsh/sessions/<slug>/<sessionId>/session.jsonl.zstd`, where `<slug>` is
  the cwd's path segments joined by `-` and wrapped in `--`. We locate a session by
  scanning for its id rather than trusting that rule.
- Records carry `type`, `seq`, `time`, `data`. Exactly three types are marked with
  `surfaceOp` — `user/message`, `assistant/message`, `tool/result` — and those are
  the visible transcript. The other 29 types are internal bookkeeping.
- **`user/message` does not mean the person typed it.** dsh splices scaffolding into
  the conversation under the same record type, discriminated by `data.source.kind`.
  Across 55 sessions here: `user` (66), `plugin` (43), `skill-catalog` (36),
  `goal` (25), `agent-message` (5), `subagent-settled` (4). Only `user` is real
  input; the rest rendered as walls of runtime context and skill catalogs the user
  never wrote, so only `user` is kept. A record with no `source.kind` is kept too —
  that is a shape we do not recognise, and hiding a real message is the worse error.
- `tool/call` has no `surfaceOp` but supplies the tool label, paired by `callId`.
- The log also contains `todo/write`, `goal/change`, and `approval/*` records —
  surfaces ACP deliberately withholds. Not rendered today; available if wanted.

### The multi-frame trap

dsh appends **one zstd frame per write**, so a real log is a concatenated
multi-frame stream — 9014 frames in the largest session here. **Node's zstd
bindings decode only the first frame and stop**: both `zstdDecompressSync` and
`createZstdDecompress` returned 202 bytes of a 6.3 MB log, which silently looks
like an empty transcript rather than an error.

The decoder therefore walks frames itself, advancing by the stream's `bytesWritten`
after each one. Measured 549 ms for the 3.2 MB / 9014-frame worst case (the `zstd`
CLI does it in 63 ms and is kept as a fallback for hosts whose Node predates zstd,
added in 22.15). Output is byte-identical to the CLI.

## Finding the `dsh` executable

`spawn('dsh')` is not enough. A VS Code launched from the Dock inherits the *system*
PATH — `/usr/gnu/bin:/usr/local/bin:/bin:/usr/bin` here — not your shell's, so an
install under a version manager is invisible to it and the agent fails with
`spawn dsh ENOENT` even though `which dsh` works in every terminal.

Discovery runs cheapest-first and only the last step spawns anything:

1. `dshAgent.executablePath` when set — an absolute path is taken as-is
2. `process.env.PATH` — works when VS Code was started from a terminal
3. version-manager and package-manager directories: every installed nvm version,
   then volta, fnm, asdf, bun, homebrew, `~/.npm-global`
4. the login shell's own PATH (`$SHELL -lic 'command -v dsh'`), with a 5 s timeout

The Windows branches differ throughout and are **simulated in tests, not verified on
a Windows host**: the PATH separator is `;`, an npm CLI is a `.cmd` shim so a bare
name finds nothing, the candidate directories live under `APPDATA`/`LOCALAPPDATA`,
and there is no login-shell step. Path joining picks `path.win32` or `path.posix`
from the target platform rather than following the host, which is what lets those
branches be exercised from macOS at all.

If all four fail, the error names `dshAgent.executablePath` and offers a button that
opens that setting.

**Finding the file is only half of it.** dsh is a Node CLI whose shebang is
`#!/usr/bin/env node`, so it resolves `node` through its *own* PATH at exec time.
Handing the child the inherited system PATH reproduces the same failure one level
down — `env: node: No such file or directory`, exit 127 — because the version
manager's node is no more visible to the child than dsh was to us. The child
therefore gets the directory dsh was found in prepended to PATH (for nvm, fnm, volta
and homebrew `node` sits right next to `dsh`), falling back to a search of the
well-known directories for a runtime.

`test/gui-launch.mjs` rebuilds the Dock-launch PATH and drives a real handshake
through it, which is the only way to catch that second failure: locating a file says
nothing about being able to exec it.

## Security notes

**The agent writes files with no prompt.** Measured: asking the agent to create a
file produced the file, and `session/request_permission` never fired — the shipped
`acp` profile auto-approves tool use. This extension implements the permission
prompt (the policy layer is patchable), but **do not treat it as a safety net**.
The agent has the same filesystem reach as running `dsh` in a terminal.

Other deliberate choices:

- `dshAgent.executablePath` and `dshAgent.profile` are `scope: machine`, so a
  repository's `.vscode/settings.json` cannot redirect the spawned binary.
- `untrustedWorkspaces.supported: false` — the extension stays off until you trust
  the folder.
- The child is spawned with an argv array and `shell: false`.
- File paths in tool rows are confined to the workspace before opening.
- Webview CSP uses a `crypto.randomBytes` nonce; all agent text reaches the DOM
  through `textContent`, never `innerHTML`.
- Zero runtime dependencies.

## Measured agent behaviour

Facts this client depends on, each verified against dsh `0.1.2-rc.1`
(`deepseek-harness-acp/0.0.1`) rather than taken from docs:

- `session/list` returns only **inactive** sessions. The active one is absent and
  reappears after `session/close` — so switching sessions must close the old one,
  or it becomes unreachable.
- `session/resume` restores context but **replays no history**; the panel starts
  empty. Transcripts live in `~/.dsh/sessions/<cwd-slug>/<sessionId>`.
- `promptCapabilities.image` tracks the configured model route, not the protocol:
  `deepseek-v4-flash` reports `false`, `deepseek-v4-flash-vision-exp` reports `true`.
- Tool output nests one level: `content[].content.text`.
- A turn emits `tool_call` → `tool_call_update` → `agent_thought_chunk` →
  `agent_message_chunk`, with `usage_update` interleaved.

## Develop

```sh
npm install
npm run compile      # tsc
npm test             # ACP smoke test against a real agent + transcript parsing
                     # against every session in ~/.dsh/sessions
npm run package      # dsh-agent.vsix
```

`src/acp/` imports no `vscode`, so the protocol layer runs headless under `npm test`.

## Releasing

Releases are published by GitHub Actions — no local publish step. The workflow
`.github/workflows/publish.yml` runs on a `v*` tag push: it checks the tag matches
the version in `package.json`, packages the `.vsix`, publishes it to the Visual
Studio Marketplace (and to Open VSX when its token is configured), then attaches
the `.vsix` to a GitHub Release.

1. Bump `version` in `package.json` and add a matching entry to `CHANGELOG.md`.
2. Commit and push, then tag and push — the tag must equal the package version:

   ```sh
   git tag v0.2.1
   git push origin v0.2.1
   ```

3. Watch the run under the repository's **Actions** tab.

The run fails loudly if the tag and version disagree or if the Marketplace token
is missing, so mistakes surface in CI rather than as half-published releases.

Secrets, configured in *Settings → Secrets and variables → Actions*. They must be
reachable by the publish job, which declares `environment: prod` — so put them
either in the **Secrets** tab (repository-level, visible to every workflow) or as
environment secrets on the `prod` environment (scoped, but only to jobs that
declare it):

| Secret | Required | Purpose |
|---|---|---|
| `VSCE_PAT` | yes | Marketplace token for publisher `hacken` — create at [marketplace.visualstudio.com/manage](https://marketplace.visualstudio.com/manage), scope **Marketplace → Manage** |
| `OVSX_PAT` | no | Also publish to [Open VSX](https://open-vsx.org) (the `hacken` namespace must exist there) |

## Status

Working slice: chat, streaming, tool rows, session resume/switch, transcript
replay, model picker, cancel, send-selection, context-chips (files and selections).

Not done: images, MCP server mounts, prompt queueing, rendering todos/plans from
the on-disk log.
