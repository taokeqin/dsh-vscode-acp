// src/panel/sessionsHtml.ts — the sidebar sessions list document.
//
// Pure string builder, mirroring html.ts. This view is a launcher: it lists every
// session for the workspace and opens one as an editor tab. It holds no transcript.

/** Sidebar list → extension host. */
export type SessionsInbound =
  | { type: 'ready' }
  | { type: 'open'; id: string }
  | { type: 'new' }
  | { type: 'refresh' };

/** Extension host → sidebar list. */
export type SessionsOutbound =
  | { type: 'sessions'; items: SessionRow[] }
  | { type: 'status'; text: string };

/** One row in the sidebar list. */
export interface SessionRow {
  id: string;
  title: string;
  /** Relative time of last activity, pre-formatted host-side. */
  when: string;
  /** True when this session already has an editor tab open. */
  open: boolean;
  /** True when it is the visible tab. */
  active: boolean;
}

const STYLE = `
:root { color-scheme: light dark; }
* { box-sizing: border-box; }
body {
  margin: 0; font-family: var(--vscode-font-family); font-size: var(--vscode-font-size, 13px);
  color: var(--vscode-foreground); background: var(--vscode-sideBar-background);
}
#bar {
  display: flex; align-items: center; gap: 6px; padding: 6px 8px;
  border-bottom: 1px solid var(--vscode-panel-border); position: sticky; top: 0;
  background: var(--vscode-sideBar-background);
}
#bar .label { flex: 1; font-size: 0.8em; opacity: 0.6; text-transform: uppercase; letter-spacing: 0.06em; }
button {
  background: transparent; color: var(--vscode-foreground); border: none;
  padding: 2px 7px; border-radius: 3px; cursor: pointer; font-size: 1.05em; line-height: 1.4;
}
button:hover { background: var(--vscode-toolbar-hoverBackground, var(--vscode-list-hoverBackground)); }
#list { padding: 4px 0; }
.row {
  display: flex; align-items: baseline; gap: 8px; padding: 5px 10px;
  cursor: pointer; border-left: 2px solid transparent;
}
.row:hover { background: var(--vscode-list-hoverBackground); }
.row.active {
  background: var(--vscode-list-activeSelectionBackground);
  color: var(--vscode-list-activeSelectionForeground);
  border-left-color: var(--vscode-focusBorder);
}
.row .title { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.row.open .title { font-weight: 600; }
.row .when { flex: none; font-size: 0.85em; opacity: 0.6; }
.row .dot { flex: none; width: 6px; height: 6px; border-radius: 50%; background: transparent; }
.row.open .dot { background: var(--vscode-charts-green, #89d185); }
#empty { padding: 14px 12px; opacity: 0.65; font-size: 0.92em; line-height: 1.5; }
#status { padding: 6px 10px; font-size: 0.85em; opacity: 0.6; }
`;

const SCRIPT = String.raw`
const vscode = acquireVsCodeApi();
const list = document.getElementById('list');
const status = document.getElementById('status');

function render(items) {
  list.replaceChildren();
  if (!Array.isArray(items) || items.length === 0) {
    const e = document.createElement('div');
    e.id = 'empty';
    e.textContent = 'No sessions yet. Use + to start one.';
    list.append(e);
    return;
  }
  for (const s of items) {
    if (!s || typeof s.id !== 'string') continue;
    const row = document.createElement('div');
    row.className = 'row' + (s.open ? ' open' : '') + (s.active ? ' active' : '');
    const dot = document.createElement('span');
    dot.className = 'dot';
    const title = document.createElement('span');
    title.className = 'title';
    title.textContent = String(s.title ?? '').replace(/\s+/g, ' ') || 'untitled';
    const when = document.createElement('span');
    when.className = 'when';
    when.textContent = String(s.when ?? '');
    row.append(dot, title, when);
    row.title = s.id;
    row.onclick = () => vscode.postMessage({ type: 'open', id: s.id });
    list.append(row);
  }
}

document.getElementById('new').onclick = () => vscode.postMessage({ type: 'new' });
document.getElementById('refresh').onclick = () => vscode.postMessage({ type: 'refresh' });

window.addEventListener('message', (e) => {
  const m = e.data;
  if (!m || typeof m !== 'object') return;
  if (m.type === 'sessions') render(m.items);
  else if (m.type === 'status') status.textContent = String(m.text ?? '');
});

vscode.postMessage({ type: 'ready' });
`;

/** Builds the sidebar list document. */
export function sessionsHtml(nonce: string): string {
  const csp = ["default-src 'none'", "style-src 'unsafe-inline'", `script-src 'nonce-${nonce}'`].join('; ');
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>DSH Sessions</title>
<style>${STYLE}</style>
</head>
<body>
<div id="bar">
  <span class="label">Sessions</span>
  <button id="refresh" title="Refresh">&#8635;</button>
  <button id="new" title="New session">+</button>
</div>
<div id="list"></div>
<div id="status"></div>
<script nonce="${nonce}">${SCRIPT}</script>
</body>
</html>`;
}
