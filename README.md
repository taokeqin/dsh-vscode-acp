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
npm test             # end-to-end smoke test against a real `dsh --profile acp`
npm run package      # dsh-agent.vsix
```

`src/acp/` imports no `vscode`, so the protocol layer runs headless under `npm test`.

## Status

Working slice: chat, streaming, tool rows, session resume/switch, model picker,
cancel, send-selection. Not done: images, MCP server mounts, transcript rendering
from disk, prompt queueing.
