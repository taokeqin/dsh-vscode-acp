// src/panel/html.ts — the chat webview document.
//
// Pure string builder: no vscode import, so the markup is testable in isolation.
// The page renders only what ACP actually delivers — assistant text, reasoning,
// tool-call rows, and usage. DSH's richer surfaces (plans, todos, terminal views)
// are deliberately absent from the ACP contract and cannot be shown here.

/** Messages the webview posts up to the extension host. */
export type PanelInbound =
  | { type: 'ready' }
  | { type: 'send'; text: string }
  | { type: 'cancel' }
  | { type: 'openPath'; path: string };

/** Messages the extension host posts down to the webview. */
export type PanelOutbound =
  | { type: 'state'; busy: boolean; sessionId: string | null; model: string | null }
  | { type: 'user'; text: string }
  | { type: 'chunk'; role: 'assistant' | 'thought'; messageId: string; text: string }
  | { type: 'tool'; id: string; title: string; status: string; detail?: string; path?: string }
  | { type: 'usage'; used: number; size: number }
  | { type: 'notice'; text: string; tone: 'info' | 'error' }
  | { type: 'turnEnd'; stopReason: string }
  | { type: 'clear' };

const STYLE = `
:root { color-scheme: light dark; }
* { box-sizing: border-box; }
body {
  margin: 0; height: 100vh; display: flex; flex-direction: column;
  font-family: var(--vscode-font-family); font-size: var(--vscode-font-size, 13px);
  color: var(--vscode-foreground); background: var(--vscode-sideBar-background);
}
#log { flex: 1; overflow-y: auto; padding: 10px 10px 4px; }
.msg { margin-bottom: 12px; line-height: 1.55; white-space: pre-wrap; word-break: break-word; }
.msg.user {
  background: var(--vscode-textBlockQuote-background);
  border-left: 2px solid var(--vscode-focusBorder);
  padding: 6px 9px; border-radius: 3px;
}
.msg.assistant { padding: 0 2px; }
details.thought {
  margin-bottom: 10px; font-size: 0.92em; opacity: 0.75;
  border-left: 2px solid var(--vscode-panel-border); padding-left: 8px;
}
details.thought summary { cursor: pointer; user-select: none; opacity: 0.85; }
details.thought .body { white-space: pre-wrap; margin-top: 4px; }
.tool {
  display: flex; gap: 7px; align-items: baseline;
  border: 1px solid var(--vscode-panel-border); border-radius: 4px;
  padding: 5px 8px; margin-bottom: 8px; font-size: 0.92em;
}
.tool .name { font-weight: 600; }
.tool .arg {
  opacity: 0.8; font-family: var(--vscode-editor-font-family, monospace);
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap; flex: 1;
}
.tool .arg.link { cursor: pointer; text-decoration: underline; }
.tool .dot { width: 7px; height: 7px; border-radius: 50%; flex: none; align-self: center; }
.dot.in_progress { background: var(--vscode-charts-blue, #3794ff); animation: pulse 1.1s ease-in-out infinite; }
.dot.completed   { background: var(--vscode-charts-green, #89d185); }
.dot.failed      { background: var(--vscode-charts-red, #f14c4c); }
.dot.pending     { background: var(--vscode-descriptionForeground); }
@keyframes pulse { 50% { opacity: 0.25; } }
.notice { font-size: 0.9em; padding: 5px 8px; border-radius: 3px; margin-bottom: 10px; }
.notice.info  { background: var(--vscode-textBlockQuote-background); opacity: 0.85; }
.notice.error { background: var(--vscode-inputValidation-errorBackground); border: 1px solid var(--vscode-inputValidation-errorBorder); }
#composer { border-top: 1px solid var(--vscode-panel-border); padding: 8px; }
#input {
  width: 100%; resize: none; min-height: 54px; max-height: 180px; padding: 6px 8px;
  color: var(--vscode-input-foreground); background: var(--vscode-input-background);
  border: 1px solid var(--vscode-input-border, transparent); border-radius: 3px;
  font-family: inherit; font-size: inherit;
}
#input:focus { outline: 1px solid var(--vscode-focusBorder); }
#bar { display: flex; align-items: center; gap: 8px; margin-top: 6px; font-size: 0.85em; }
#status { flex: 1; opacity: 0.7; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
button {
  background: var(--vscode-button-background); color: var(--vscode-button-foreground);
  border: none; padding: 4px 12px; border-radius: 3px; cursor: pointer; font-size: inherit;
}
button:hover:not(:disabled) { background: var(--vscode-button-hoverBackground); }
button:disabled { opacity: 0.45; cursor: default; }
button.secondary { background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground); }
`;

/**
 * Client script. Kept dependency-free and defensive: every inbound message is
 * shape-checked before it touches the DOM, and all text goes in via textContent
 * so agent or tool output can never inject markup.
 */
const SCRIPT = String.raw`
const vscode = acquireVsCodeApi();
const log = document.getElementById('log');
const input = document.getElementById('input');
const sendBtn = document.getElementById('send');
const stopBtn = document.getElementById('stop');
const status = document.getElementById('status');

let busy = false;
let usage = '';
let model = '';
// Streaming chunks arrive per messageId; keep the live node so text appends in place.
const streams = new Map();
const tools = new Map();

function atBottom() { return log.scrollHeight - log.scrollTop - log.clientHeight < 40; }
function scroll(wasBottom) { if (wasBottom) log.scrollTop = log.scrollHeight; }

function addUser(text) {
  const wasBottom = atBottom();
  const el = document.createElement('div');
  el.className = 'msg user';
  el.textContent = text;
  log.append(el);
  scroll(wasBottom);
}

function appendChunk(role, messageId, text) {
  const wasBottom = atBottom();
  const key = role + ':' + messageId;
  let node = streams.get(key);
  if (!node) {
    if (role === 'thought') {
      const d = document.createElement('details');
      d.className = 'thought';
      const s = document.createElement('summary');
      s.textContent = 'Reasoning';
      const b = document.createElement('div');
      b.className = 'body';
      d.append(s, b);
      log.append(d);
      node = b;
    } else {
      node = document.createElement('div');
      node.className = 'msg assistant';
      log.append(node);
    }
    streams.set(key, node);
  }
  node.textContent += text;
  scroll(wasBottom);
}

function upsertTool(m) {
  const wasBottom = atBottom();
  let row = tools.get(m.id);
  if (!row) {
    row = document.createElement('div');
    row.className = 'tool';
    const dot = document.createElement('span');
    dot.className = 'dot';
    const name = document.createElement('span');
    name.className = 'name';
    const arg = document.createElement('span');
    arg.className = 'arg';
    row.append(dot, name, arg);
    log.append(row);
    tools.set(m.id, row);
  }
  row.querySelector('.dot').className = 'dot ' + (m.status || 'pending');
  row.querySelector('.name').textContent = m.title || 'tool';
  const arg = row.querySelector('.arg');
  arg.textContent = m.detail || '';
  // A tool argument that names a real file becomes a jump target.
  if (m.path) {
    arg.classList.add('link');
    arg.title = m.path;
    arg.onclick = () => vscode.postMessage({ type: 'openPath', path: m.path });
  }
  scroll(wasBottom);
}

function addNotice(text, tone) {
  const wasBottom = atBottom();
  const el = document.createElement('div');
  el.className = 'notice ' + (tone === 'error' ? 'error' : 'info');
  el.textContent = text;
  log.append(el);
  scroll(wasBottom);
}

function renderStatus() {
  status.textContent = [model, usage].filter(Boolean).join('  ·  ');
}

function setBusy(v) {
  busy = v;
  sendBtn.disabled = v;
  stopBtn.hidden = !v;
  input.placeholder = v ? 'Agent is working…' : 'Ask the agent  (Enter to send, Shift+Enter for a newline)';
}

function send() {
  const text = input.value.trim();
  if (text === '' || busy) return;
  input.value = '';
  input.style.height = 'auto';
  vscode.postMessage({ type: 'send', text });
}

sendBtn.addEventListener('click', send);
stopBtn.addEventListener('click', () => vscode.postMessage({ type: 'cancel' }));
input.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); }
});
input.addEventListener('input', () => {
  input.style.height = 'auto';
  input.style.height = Math.min(input.scrollHeight, 180) + 'px';
});

window.addEventListener('message', (e) => {
  const m = e.data;
  if (!m || typeof m !== 'object') return;
  switch (m.type) {
    case 'state':
      setBusy(m.busy === true);
      model = typeof m.model === 'string' ? m.model : '';
      renderStatus();
      break;
    case 'user':   addUser(String(m.text)); break;
    case 'chunk':  appendChunk(m.role === 'thought' ? 'thought' : 'assistant', String(m.messageId), String(m.text)); break;
    case 'tool':   upsertTool(m); break;
    case 'usage':
      usage = Math.round((m.used / m.size) * 100) + '% context (' + m.used.toLocaleString() + ')';
      renderStatus();
      break;
    case 'notice': addNotice(String(m.text), m.tone); break;
    case 'turnEnd':
      // Close every open stream so the next turn starts fresh nodes.
      streams.clear();
      if (m.stopReason && m.stopReason !== 'end_turn') addNotice('Turn ended: ' + m.stopReason, 'info');
      break;
    case 'clear':
      log.replaceChildren();
      streams.clear();
      tools.clear();
      break;
  }
});

setBusy(false);
vscode.postMessage({ type: 'ready' });
input.focus();
`;

/**
 * Builds the panel document.
 * @param nonce cryptographically random per-render CSP nonce
 */
export function chatHtml(nonce: string): string {
  const csp = [
    "default-src 'none'",
    "style-src 'unsafe-inline'",
    `script-src 'nonce-${nonce}'`,
  ].join('; ');
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>DSH Agent</title>
<style>${STYLE}</style>
</head>
<body>
<div id="log"></div>
<div id="composer">
  <textarea id="input" rows="2" placeholder="Ask the agent  (Enter to send, Shift+Enter for a newline)"></textarea>
  <div id="bar">
    <span id="status"></span>
    <button id="stop" class="secondary" hidden>Stop</button>
    <button id="send">Send</button>
  </div>
</div>
<script nonce="${nonce}">${SCRIPT}</script>
</body>
</html>`;
}
