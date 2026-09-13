# AGENTS.md

Agent-facing notes for **dsh-agent**, the VS Code extension that chats with the
DeepSeek Harness (`dsh`) over ACP. Humans get the full story in `README.md`; this file
is the part an agent needs to change code without breaking it, and to package, install
and release it.

## What this is

- One `dsh --profile acp` child process (`src/acp/`) multiplexing N sessions.
- One editor tab per session (`src/panel/chatPanel.ts`), rendered by a pure HTML
  string builder (`src/panel/html.ts`).
- A sidebar session list (`src/panel/sessionsView.ts`).

`src/acp/` imports no `vscode`, so the protocol layer runs headless under the tests.
`src/panel/html.ts` is also vscode-free: it builds the webview document as a string.

## Layout

| Path | Role |
|---|---|
| `src/acp/` | ACP wire client, connection, executable discovery. No `vscode`. |
| `src/panel/html.ts` | The webview document (markup + injected script). Pure string. |
| `src/panel/chatPanel.ts` | Host side of a session tab: state, sends, context chips. |
| `src/extension.ts` | Activation, commands, menus, selection/file staging. |
| `src/context.ts` | Attachments → the single prompt string. Pure. |
| `src/filePicker.ts` | Workspace file listing (`findFiles`) + QuickPick. |
| `src/fileSearch.ts` | `@` menu ranking. Pure. |
| `src/fileMention.ts` | `@path` / `@"path with spaces"` grammar. Pure. |
| `src/slashMenu.ts` | `/` and `@` trigger detection, skill filtering. Pure. |
| `test/*.mjs` | One file per concern; run with plain `node`. |

## Test and verify

```sh
npm run compile      # tsc, also deletes out/
npm run typecheck    # tsc --noEmit
npm run test:unit    # compile + every headless suite (no dsh, no credentials)
npm test             # the above + gui-launch.mjs + smoke.mjs (needs a real agent)
```

- **`test:unit` is the gate for a change.** Keep it green before committing.
- `npm test` additionally starts a real `dsh --profile acp`. `gui-launch.mjs` checks
  discovery/handshake; `smoke.mjs` runs real turns and needs model credentials.
- In a **workspace-write sandbox**, `dsh` may exit 1 because it rewrites
  `~/.dsh/profiles/acp/cordis.yml` (outside the workspace) — an environment limit, not
  a code failure. `test:unit` does not touch `dsh`.

### How the tests are built

- Decisions live in pure modules (`slashMenu.ts`, `composerKeys.ts`, `context.ts`,
  `fileSearch.ts`, …). They are injected into the webview script with
  `Function.prototype.toString()` (see `slashLogicSource()`), so **the tested function
  is the shipped function**. When you add webview logic, put the decision in a module
  and test it there; do not inline an untested branch.
- `chatHtml()` is a TypeScript **template literal**. The injected script must not
  contain a raw backtick — it would close the template and produce a syntax error
  (`TS1005`). Use `String.fromCharCode(96)` when the script needs one.
- Some suites assert on the rendered HTML (`test/menus.mjs`, `test/slash-menu.mjs`).
  They are there because a wrong `when` clause or a missing listener fails silently.

## Debug the UI

The agent cannot click a webview, so UI changes are verified in two steps:

1. **Agent:** `npm run compile` + `npm run test:unit`, and assert on `chatHtml()` output
   in a test for anything structural.
2. **Human:** `F5` → **Run DSH Agent** (`.vscode/launch.json`, preLaunchTask
   `npm: compile`) opens an Extension Development Host on `../opensource/dsh-vscode`.
   `npm run watch` for iterative work. Logs are in **Output → DSH Agent**.

Ask the human to confirm anything that is only visible in the UI.

## Package and install locally

```sh
npm run package      # compile + vsce package → dsh-agent.vsix (gitignored)
```

If `npx` is blocked writing its cache, run the already-cached vsce directly:

```sh
~/.npm/_npx/*/node_modules/.bin/vsce package --no-dependencies -o dsh-agent.vsix
```

Install with the app-bundled CLI (`code` is often not on `PATH`):

```sh
"/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code" \
  --install-extension dsh-agent.vsix --force
```

Installing writes to `~/.vscode/extensions` and `~/Library/Application Support/Code`
(both outside the workspace, so a sandboxed run needs wider access). Reinstalling the
same version over a running VS Code is allowed, but **the user must reload the window**
(`Developer: Reload Window`) before the new code is active. The `dsh-agent.vsix` in the
repo root is a stale build artifact — always repackage before installing.

## Release

Releases happen **only in CI**, from a version tag. `.github/workflows/publish.yml`
runs on `v*`: it checks tag == `package.json` version, packages, publishes to the VS
Marketplace (`VSCE_PAT`, required) and optionally Open VSX (`OVSX_PAT`), then creates a
GitHub Release with the `.vsix` attached.

```sh
npm version <x.y.z> --no-git-tag-version        # bumps package.json + package-lock.json
# rename CHANGELOG "## Unreleased" to "## <x.y.z>"
git add -A && git commit -m "chore: release v<x.y.z>"
git push origin main
git tag v<x.y.z> && git push origin v<x.y.z>    # this triggers the publish
```

- The tag **must equal** the `package.json` version, or the run fails before packaging.
- Features bump the minor (`0.x.0`); a released version's tag is immutable.
- The tag is also the GitHub Release name. Watch the run in **Actions**.
- A push to `main` does **not** publish; only the tag does.
- `git push` may print `fatal: unable to get credential storage lock ... Operation not
  permitted` under a sandbox and still succeed — trust the `old..new main -> main` line.

## Commit style

`type: lowercase summary` — `feat`, `fix`, `docs`, `chore`, `ci`. One concern per
commit; explain *why* in the body when the change is not obvious.

## Invariants the code depends on

- **ACP carries one string prompt.** Files are sent as dsh's own `@path` mention (the
  agent reads them); a checked selection is the only thing inlined, as a fenced
  `path:line-line` block. dsh advertises `embeddedContext: false`, so an embedded
  `resource` block is rejected — never try to attach file contents.
- **Context chips are host-owned.** The webview renders and reports intent
  (`removeContext` / `toggleContext` / `fileQuery` / `addContextFile`); the host
  serializes. Keep it that way so both entry points stay in step.
- **Nothing is attached implicitly.** A chip exists because the user added it (or
  selected text, which stages it unchecked); the checkbox is the include switch.
- **The composer moves focus into a webview**, where `window.activeTextEditor` is
  `undefined`. Use the last real text editor remembered in `extension.ts` for anything
  selection-driven.
- **`@`/`/` only trigger at start-of-input or after whitespace**, matching dsh's grammar.
- The shipped extension carries `out/`, `media/` and the docs; `src/` and `test/` are
  excluded (see `.vscodeignore`), so a file the extension needs at runtime must be
  included by the package step — adding it under `src/` alone is not enough.
