# DSH Agent (unofficial)

A VS Code panel for the [DeepSeek Harness](https://www.npmjs.com/package/@deepseek-ai/dsh)
coding agent, driven over **ACP** (Agent Client Protocol) on stdio.

Not affiliated with DeepSeek.

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

## Buttons on a session tab

Claude Code turns out to contribute very little to the editor title bar: only
`editor.openLast`, `terminal.open` and the diff accept/reject get `navigation`
icons. `newConversation` appears in the command palette alone — its own button is
drawn inside the webview — and there is no history command at all, because history
*is* the sessions sidebar view.

What is worth copying is how it scopes the entries it does contribute:
`activeWebviewPanelId == '<viewType>'`, so they never appear on ordinary editors.
Using that key, a session tab carries:

| | |
|---|---|
| `$(add)` | New Session |
| `$(history)` | Session History — reveals the sidebar list |
| `$(settings-gear)` | Select Model |
| `$(debug-stop)` | Cancel — only while a turn is in flight (`dshAgent.busy`) |

Show Logs and Restart Agent sit in the `…` overflow, which is where Claude Code puts
its own secondary actions. On any other editor the title bar shows just the whale.

## Rendering

Agent output is Markdown, so `**bold**`, `## headings` and `` `code` `` used to show
as literal text. It is now rendered — headings, fenced and inline code, lists,
blockquotes, rules and http(s) links.

**Markdown is parsed in the extension host; only a node tree crosses into the
webview**, which builds DOM from it with `createElement` and `textContent`. No HTML
string is ever constructed from agent output, so a message cannot introduce an
element the panel does not name. A test asserts the panel document contains no
`innerHTML` at all, and another parses the inline webview script, which ships as a
string and is otherwise invisible to `tsc`.

Streaming re-sends the whole message rather than appending deltas: Markdown only
parses as a whole, so a half-received code fence corrects itself once the closing
fence lands.

### File references

A code span naming a real file — `` `src/panel/html.ts:42` ``, with an optional
`:line` or `:line-line` — is rendered as a clickable reference that opens the file
and selects the cited lines. Tool rows are clickable on the same terms, restored ones
included.

Two decisions keep this from being annoying:

- **The host decides, not the webview.** Only the extension side can check the
  filesystem, so a span becomes a link only when the path resolves *inside* the
  workspace and *exists*. Prose is never dressed up as a link that then fails.
- **A path that cannot be opened is not a link.** Agents legitimately read outside
  the workspace — skills, configs — and those rows stay plain text rather than
  clickable-then-refused. A dead link is worse than no link.

Fenced code blocks are left alone: their contents are source, not prose. Line
numbers are clamped to the document, since a reference can outlive the edit that
shortened the file.

Reasoning stays collapsed, dimmed, with the first line of it previewed on the
summary so a folded block still says what it was about. Tool rows show the argument
that identifies the call — `bash ls -la …`, `read src/x.ts` — instead of the raw
JSON blob.

## Composer settings, and slash commands

The composer carries a dropdown for every setting the agent advertises — today
`model` (three routes) and `reasoning_effort` (Off/Low/High/Max) — read from
`session/new` rather than hardcoded, so a build exposing more just renders more.
Settings are per session: changing one tab does not affect another.

Context usage sits beside them as a small ring that fills as the window is consumed,
going from neutral to yellow at 60% and red at 85%. The exact numbers are rarely
what you want mid-conversation, so they live in the hover title —
*"Context 12% — 118,402 of 1,000,000 tokens"*.

A resumed session shows its ring immediately, recovered from the log rather than
waiting for the next turn — knowing how much room is left is most useful *before*
sending, not after. ACP only reports usage mid-turn, but both halves are on disk:
`request/context` carries the window and each `assistant/message` carries the tokens
its request consumed. The last values win, which is also what makes it correct after
a compaction — the context shrinks and later records reflect the smaller total. The
window is read per session rather than assumed: sessions here run at both 1,000,000
and 1,024,000. 47 of 73 sessions on this machine yield usage, exactly the 47 that
hold a conversation.

The parameter for `session/set_config_option` is **`configId`**, not `optionId`.
Every plausible spelling returned `-32602 Invalid params`; the right one came from
reading the agent's own handler. Worth stating plainly because the model picker
never worked until a test exercised it.

### Skills

Skills *are* recoverable, and the difference is instructive: a slash command is a
plugin-registered handler with no client-side equivalent, whereas a skill is a
Markdown file in a documented location. So the catalog is rebuilt by scanning the
roots `dsh-skill-filesystem` specifies:

| Rank | Source | Path |
|---|---|---|
| 100 | `project-dsh` | `<projectRoot>/.dsh/skills` |
| 200 | `project-agents` | `<projectRoot>/.agents/skills` |
| 400 | `user-dsh` | `<dshHome>/skills` |
| 500 | `user-agents` | `<agentsHome>/skills` |

A skill is `<name>/SKILL.md` or a flat `<name>.md` at a root's **top level** — nested
`**/SKILL.md` is deliberately not discovered — with YAML frontmatter carrying a
required `name` and `description`, plus optional `disable-model-invocation` and
`user-invocable`. Lower rank wins a name clash.

The scan was validated against dsh itself: a session log records the catalog dsh
splices into the conversation, and the disk scan reproduces it exactly.

Typing `/` at the start of a line opens the skill list **inline above the composer**
— arrow keys to move, Enter or Tab to accept, Esc to dismiss. A quick pick was tried
first and felt too far away: choosing a skill is part of writing the message, not a
separate errand. There is no toolbar button; the slash is the entry point.

The slash must open a line. That rule is what keeps `src/index.ts` or "and/or" from
popping the menu mid-sentence.

Accepting inserts a plain-text reference, since a skill is invoked by the model
reading the prompt — there is no command channel to call one through.

The trigger and filtering live in `src/slashMenu.ts`, and the Enter/IME decisions in
`src/composerKeys.ts`. Both are injected into the panel script through
`Function.prototype.toString()`, so the code the tests exercise is literally the code
that ships — no second copy to drift.

### Input methods

Enter during IME composition belongs to the input method, not to us. An IME uses it
to accept a candidate, and that keydown arrives *before* the text is committed — so
sending on it shipped the message and then let the IME commit the accepted word into
the emptied box, leaving the last word behind. Both `isComposing` and the legacy
`keyCode === 229` signal are honoured, for the slash menu's navigation keys as well
as for sending.

**Slash commands are not available over ACP and cannot be faked.** `dsh-commands`
says it directly — "UI-less demo spines and ACP automation provide no command
adapter and do not need it", and slash commands "ship with the `dsh` CLI and the Web
client". They are plugin-registered handlers that run "directly against the
receiving agent without creating a model message", so they are not prompt templates
a client could expand into text. Supporting them would need dsh to add a command
adapter to the ACP surface.

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
same group as a tab. `Beside` alone cannot express this — it means "next to whatever
is active", so opening a session while a session tab was focused split the editor
into yet another group each time. The rule lives in `src/panelColumn.ts` and is
pinned by `test/panel-column.mjs`.

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

## Status

Working slice: chat, streaming, tool rows, session resume/switch, transcript
replay, model picker, cancel, send-selection.

Not done: images, MCP server mounts, prompt queueing, rendering todos/plans from
the on-disk log.
