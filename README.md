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

## Session switcher

`session/list` deliberately omits the **active** session, so the switcher adds the
current one back explicitly and marks it `$(check) current session` at the top —
otherwise the list would be missing exactly the session you are looking at.

Entries are labelled with the session title (dsh writes the first user message as a
fallback title, since the acp profile disables model-generated ones) and a relative
timestamp, read from the on-disk log. Metadata uses a 64-frame budget rather than
decompressing the whole log: 2 ms versus 320 ms per session on the largest one here.
A session whose metadata cannot be read still lists, as `(no messages yet)`.

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
