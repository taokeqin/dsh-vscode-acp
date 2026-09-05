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

It lives in the **secondary (right) sidebar** by default, matching where Claude Code
puts its own view and leaving the left activity bar to file navigation. Set
`dshAgent.showInActivityBar` to also mount it on the left; a single provider serves
both view ids, so either side (or both at once) stays in sync from one refresh.

Tabs open in the column beside your code (`dshAgent.panelColumn`, `Beside` or
`Active`). Files opened from a tool row go to column One, so code lands next to the
chat rather than on top of it.

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
