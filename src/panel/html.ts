// src/panel/html.ts — the chat webview document.
//
// Pure string builder: no vscode import, so the markup is testable in isolation.
// The page renders only what ACP actually delivers — assistant text, reasoning,
// tool-call rows, and usage. DSH's richer surfaces (plans, todos, terminal views)
// are deliberately absent from the ACP contract and cannot be shown here.

import type { Block } from '../markdown';

/** One agent-advertised setting, flattened for a composer dropdown. */
export interface ConfigOptionView {
  id: string;
  label: string;
  current: string;
  choices: { value: string; label: string }[];
}

/** Messages the webview posts up to the extension host. */
export type PanelInbound =
  | { type: 'ready' }
  | { type: 'send'; text: string }
  | { type: 'cancel' }
  | { type: 'openPath'; path: string }
  | { type: 'openExternal'; url: string }
  | { type: 'setOption'; id: string; value: string }
  | { type: 'pickSkill' };

/** Messages the extension host posts down to the webview. */
export type PanelOutbound =
  /** `options` are the agent's advertised config options (model, reasoning effort). */
  | { type: 'state'; busy: boolean; sessionId: string | null; options: ConfigOptionView[]; skills: number }
  /** Text to drop at the caret, e.g. a chosen skill reference. */
  | { type: 'insert'; text: string }
  | { type: 'user'; blocks: Block[] }
  /**
   * A whole message, re-sent on every streaming chunk. Markdown is parsed in the
   * host and only this tree crosses the boundary, so the webview never handles an
   * HTML string built from agent output.
   */
  | { type: 'message'; role: 'assistant' | 'thought'; messageId: string; blocks: Block[]; preview: string }
  | { type: 'tool'; id: string; title: string; status: string; detail?: string; path?: string }
  | { type: 'usage'; used: number; size: number }
  | { type: 'notice'; text: string; tone: 'info' | 'error' }
  | { type: 'turnEnd'; stopReason: string }
  | { type: 'history'; entries: HistoryEntryView[]; truncated: boolean }
  | { type: 'clear' }
  /** Handed to the webview so it can persist the binding for reload restore. */
  | { type: 'restoreState'; state: { sessionId: string } };

/** A restored transcript entry, already flattened by the history store. */
export type HistoryEntryView =
  | { kind: 'user'; blocks: Block[] }
  | { kind: 'assistant'; blocks: Block[]; reasoning: Block[]; preview: string }
  | { kind: 'tool'; id: string; name: string; detail: string; failed: boolean };

const STYLE = `
:root { color-scheme: light dark; }
* { box-sizing: border-box; }
body {
  margin: 0; height: 100vh; display: flex; flex-direction: column;
  font-family: var(--vscode-font-family); font-size: var(--vscode-font-size, 13px);
  color: var(--vscode-foreground); background: var(--vscode-sideBar-background);
}
#log { flex: 1; overflow-y: auto; padding: 10px 10px 4px; }
.msg { margin-bottom: 12px; line-height: 1.6; word-break: break-word; }
.msg > *:first-child { margin-top: 0; }
.msg > *:last-child { margin-bottom: 0; }
.msg p { margin: 0 0 8px; white-space: pre-wrap; }
.msg h1, .msg h2, .msg h3, .msg h4, .msg h5, .msg h6 {
  margin: 14px 0 6px; line-height: 1.3; font-weight: 600;
}
.msg h1 { font-size: 1.28em; } .msg h2 { font-size: 1.17em; } .msg h3 { font-size: 1.07em; }
.msg h4, .msg h5, .msg h6 { font-size: 1em; }
.msg ul, .msg ol { margin: 0 0 8px; padding-left: 1.4em; }
.msg li { margin: 2px 0; white-space: pre-wrap; }
.msg blockquote {
  margin: 0 0 8px; padding: 2px 0 2px 10px;
  border-left: 2px solid var(--vscode-panel-border); opacity: 0.85; white-space: pre-wrap;
}
.msg hr { border: none; border-top: 1px solid var(--vscode-panel-border); margin: 12px 0; }
.msg code {
  font-family: var(--vscode-editor-font-family, monospace); font-size: 0.92em;
  background: var(--vscode-textCodeBlock-background, rgba(127,127,127,.18));
  padding: 1px 4px; border-radius: 3px;
}
.msg pre {
  margin: 0 0 8px; padding: 8px 10px; overflow-x: auto; border-radius: 4px;
  background: var(--vscode-textCodeBlock-background, rgba(127,127,127,.14));
  border: 1px solid var(--vscode-panel-border);
}
.msg pre code { background: none; padding: 0; font-size: 0.9em; line-height: 1.45; }
.msg a { color: var(--vscode-textLink-foreground); cursor: pointer; text-decoration: none; }
.msg a:hover { text-decoration: underline; }
.msg.user {
  background: var(--vscode-textBlockQuote-background);
  border-left: 2px solid var(--vscode-focusBorder);
  padding: 6px 9px; border-radius: 3px;
}
.msg.assistant { padding: 0 2px; }
details.thought {
  margin-bottom: 10px; font-size: 0.9em; opacity: 0.62;
  border-left: 2px solid var(--vscode-panel-border); padding-left: 8px;
}
details.thought[open] { opacity: 0.8; }
details.thought summary {
  cursor: pointer; user-select: none; list-style: none;
  display: flex; gap: 6px; align-items: baseline;
}
details.thought summary::-webkit-details-marker { display: none; }
details.thought summary::before { content: '▸'; flex: none; font-size: 0.85em; }
details.thought[open] summary::before { content: '▾'; }
/* One line of the reasoning, so a collapsed block still says what it was about. */
details.thought .peek {
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap; opacity: 0.8; font-style: italic;
}
details.thought[open] .peek { display: none; }
details.thought .body { margin-top: 6px; }
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
.restored { opacity: 0.82; }
.divider {
  display: flex; align-items: center; gap: 8px; margin: 4px 0 14px;
  font-size: 0.8em; opacity: 0.55; text-transform: uppercase; letter-spacing: 0.06em;
}
.divider::before, .divider::after {
  content: ''; flex: 1; height: 1px; background: var(--vscode-panel-border);
}
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
#bar { display: flex; align-items: center; gap: 6px; margin-top: 6px; font-size: 0.85em; }
#opts { display: flex; gap: 4px; flex: none; align-items: center; }
#skills {
  display: none; flex: none; padding: 2px 7px; font-size: 0.95em; line-height: 1.35;
  background: transparent; color: var(--vscode-foreground);
  border: 1px solid var(--vscode-dropdown-border, var(--vscode-panel-border));
  border-radius: 3px; cursor: pointer; opacity: 0.85;
}
#skills.on { display: block; }
#skills:hover:not(:disabled) { background: var(--vscode-list-hoverBackground); opacity: 1; }
#opts select {
  font-family: inherit; font-size: 0.95em; padding: 1px 4px; max-width: 130px;
  color: var(--vscode-dropdown-foreground, var(--vscode-foreground));
  background: var(--vscode-dropdown-background, transparent);
  border: 1px solid var(--vscode-dropdown-border, var(--vscode-panel-border));
  border-radius: 3px; cursor: pointer;
}
#opts select:hover { background: var(--vscode-list-hoverBackground); }
#opts select:disabled { opacity: 0.5; cursor: default; }
#status { flex: 1; display: flex; justify-content: flex-end; align-items: center; }
/* Context usage: a ring rather than a number, since the exact token count is
   rarely what you want mid-conversation — the hover title carries it. */
#usage { display: none; cursor: default; }
#usage.on { display: block; }
#usage .track { stroke: var(--vscode-panel-border); }
#usage .arc { transition: stroke-dasharray .3s ease, stroke .3s ease; }
#usage .arc.ok   { stroke: var(--vscode-descriptionForeground); }
#usage .arc.warn { stroke: var(--vscode-charts-yellow, #cca700); }
#usage .arc.high { stroke: var(--vscode-charts-red, #f14c4c); }
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
const opts = document.getElementById('opts');
const skillsBtn = document.getElementById('skills');

let busy = false;
let usage = null; // { used, size } once the agent has reported any
// Streaming chunks arrive per messageId; keep the live node so text appends in place.
const streams = new Map();
const tools = new Map();

function atBottom() { return log.scrollHeight - log.scrollTop - log.clientHeight < 40; }
function scroll(wasBottom) { if (wasBottom) log.scrollTop = log.scrollHeight; }

// —— node tree → DOM ——
// Every element is created explicitly and all text goes in via textContent. The host
// sends a tree, never markup, so agent output cannot introduce elements this file
// does not name.
function buildInline(nodes, into) {
  for (const n of nodes || []) {
    if (!n || typeof n !== 'object') continue;
    if (n.t === 'text') {
      into.append(document.createTextNode(String(n.v ?? '')));
    } else if (n.t === 'code') {
      const el = document.createElement('code');
      el.textContent = String(n.v ?? '');
      into.append(el);
    } else if (n.t === 'strong' || n.t === 'em') {
      const el = document.createElement(n.t === 'strong' ? 'strong' : 'em');
      buildInline(n.v, el);
      into.append(el);
    } else if (n.t === 'link') {
      const el = document.createElement('a');
      buildInline(n.v, el);
      el.title = String(n.href ?? '');
      // Navigating inside the webview is blocked by CSP anyway; hand the URL to the
      // host, which re-checks the scheme before opening a browser.
      el.onclick = () => vscode.postMessage({ type: 'openExternal', url: String(n.href ?? '') });
      into.append(el);
    }
  }
}

function buildBlocks(blocks, into) {
  for (const b of blocks || []) {
    if (!b || typeof b !== 'object') continue;
    if (b.t === 'p') {
      const el = document.createElement('p');
      buildInline(b.v, el);
      into.append(el);
    } else if (b.t === 'h') {
      const lvl = Math.min(6, Math.max(1, Number(b.level) || 1));
      const el = document.createElement('h' + lvl);
      buildInline(b.v, el);
      into.append(el);
    } else if (b.t === 'code') {
      const pre = document.createElement('pre');
      const code = document.createElement('code');
      code.textContent = String(b.v ?? '');
      if (b.lang) code.dataset.lang = String(b.lang);
      pre.append(code);
      into.append(pre);
    } else if (b.t === 'ul' || b.t === 'ol') {
      const list = document.createElement(b.t);
      if (b.t === 'ol' && Number(b.start) > 1) list.start = Number(b.start);
      for (const item of b.items || []) {
        const li = document.createElement('li');
        buildInline(item, li);
        list.append(li);
      }
      into.append(list);
    } else if (b.t === 'quote') {
      const el = document.createElement('blockquote');
      buildInline(b.v, el);
      into.append(el);
    } else if (b.t === 'hr') {
      into.append(document.createElement('hr'));
    }
  }
}

function addUser(blocks) {
  const wasBottom = atBottom();
  const el = document.createElement('div');
  el.className = 'msg user';
  buildBlocks(blocks, el);
  log.append(el);
  scroll(wasBottom);
}

/** Builds a collapsed reasoning block whose summary previews the first line. */
function makeThought(blocks, preview, extraClass) {
  const d = document.createElement('details');
  d.className = 'thought' + (extraClass ? ' ' + extraClass : '');
  const sm = document.createElement('summary');
  const label = document.createElement('span');
  label.textContent = 'Reasoning';
  const peek = document.createElement('span');
  peek.className = 'peek';
  peek.textContent = preview ? '· ' + preview : '';
  sm.append(label, peek);
  const body = document.createElement('div');
  body.className = 'body';
  buildBlocks(blocks, body);
  d.append(sm, body);
  return { root: d, body, peek };
}

/**
 * Renders a whole message. The host re-sends the full tree on every streaming
 * chunk, so the node is rebuilt rather than appended to — which also means a
 * partially-received code fence corrects itself once the closing fence arrives.
 */
function renderMessage(role, messageId, blocks, preview) {
  const wasBottom = atBottom();
  const key = role + ':' + messageId;
  let entry = streams.get(key);
  if (!entry) {
    if (role === 'thought') {
      const t = makeThought([], '');
      log.append(t.root);
      entry = { target: t.body, peek: t.peek };
    } else {
      const el = document.createElement('div');
      el.className = 'msg assistant';
      log.append(el);
      entry = { target: el, peek: null };
    }
    streams.set(key, entry);
  }
  entry.target.replaceChildren();
  buildBlocks(blocks, entry.target);
  if (entry.peek) entry.peek.textContent = preview ? '· ' + preview : '';
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

// Renders a restored transcript in one pass, then a divider marking where the
// live session begins. Restored content is dimmed so it reads as context, not
// as something that just happened.
function renderHistory(entries, truncated) {
  const frag = document.createDocumentFragment();
  if (truncated) {
    const d = document.createElement('div');
    d.className = 'divider';
    d.textContent = 'earlier messages omitted';
    frag.append(d);
  }
  for (const e of entries) {
    if (!e || typeof e !== 'object') continue;
    if (e.kind === 'user') {
      const el = document.createElement('div');
      el.className = 'msg user restored';
      buildBlocks(e.blocks, el);
      frag.append(el);
    } else if (e.kind === 'assistant') {
      if (Array.isArray(e.reasoning) && e.reasoning.length > 0) {
        frag.append(makeThought(e.reasoning, e.preview, 'restored').root);
      }
      if (Array.isArray(e.blocks) && e.blocks.length > 0) {
        const el = document.createElement('div');
        el.className = 'msg assistant restored';
        buildBlocks(e.blocks, el);
        frag.append(el);
      }
    } else if (e.kind === 'tool') {
      const row = document.createElement('div');
      row.className = 'tool restored';
      const dot = document.createElement('span');
      dot.className = 'dot ' + (e.failed ? 'failed' : 'completed');
      const name = document.createElement('span');
      name.className = 'name';
      name.textContent = String(e.name ?? 'tool');
      const arg = document.createElement('span');
      arg.className = 'arg';
      arg.textContent = String(e.detail ?? '');
      row.append(dot, name, arg);
      frag.append(row);
    }
  }
  const div = document.createElement('div');
  div.className = 'divider';
  div.textContent = 'restored — continuing this session';
  frag.append(div);
  log.prepend(frag);
  log.scrollTop = log.scrollHeight;
}

function addNotice(text, tone) {
  const wasBottom = atBottom();
  const el = document.createElement('div');
  el.className = 'notice ' + (tone === 'error' ? 'error' : 'info');
  el.textContent = text;
  log.append(el);
  scroll(wasBottom);
}

// —— context usage ring ——
// SVG is built through createElementNS for the same reason the transcript avoids
// innerHTML: nothing here is ever assembled as markup.
const SVG_NS = 'http://www.w3.org/2000/svg';
const RING_R = 6;
const RING_C = 2 * Math.PI * RING_R;
let usageArc = null;
let usageRing = null;

function ensureUsageRing() {
  if (usageRing) return usageRing;
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.id = 'usage';
  svg.setAttribute('width', '15');
  svg.setAttribute('height', '15');
  svg.setAttribute('viewBox', '0 0 16 16');
  const track = document.createElementNS(SVG_NS, 'circle');
  track.setAttribute('class', 'track');
  const arc = document.createElementNS(SVG_NS, 'circle');
  arc.setAttribute('class', 'arc ok');
  for (const c of [track, arc]) {
    c.setAttribute('cx', '8');
    c.setAttribute('cy', '8');
    c.setAttribute('r', String(RING_R));
    c.setAttribute('fill', 'none');
    c.setAttribute('stroke-width', '2');
  }
  // Start the arc at twelve o'clock and grow clockwise.
  arc.setAttribute('transform', 'rotate(-90 8 8)');
  arc.setAttribute('stroke-linecap', 'round');
  arc.setAttribute('stroke-dasharray', '0 ' + RING_C);
  svg.append(track, arc);
  status.append(svg);
  usageRing = svg;
  usageArc = arc;
  return svg;
}

function renderStatus() {
  if (!usage) return;
  const ring = ensureUsageRing();
  const pct = Math.max(0, Math.min(1, usage.used / usage.size));
  usageArc.setAttribute('stroke-dasharray', (pct * RING_C).toFixed(2) + ' ' + RING_C);
  usageArc.setAttribute('class', 'arc ' + (pct >= 0.85 ? 'high' : pct >= 0.6 ? 'warn' : 'ok'));
  const shown = pct > 0 && pct < 0.01 ? '<1' : String(Math.round(pct * 100));
  ring.classList.add('on');
  // The title is the whole point of the compact form: hover for the real numbers.
  const t = document.createElementNS(SVG_NS, 'title');
  t.textContent =
    'Context ' + shown + '% — ' + usage.used.toLocaleString() + ' of ' + usage.size.toLocaleString() + ' tokens';
  ring.querySelectorAll('title').forEach((el) => el.remove());
  ring.append(t);
}

/**
 * Renders the agent's advertised settings as dropdowns in the composer.
 *
 * Rebuilt only when the option set actually changes, so an open dropdown is not
 * torn out from under the pointer by an unrelated state push.
 */
let optionsKey = '';
function renderOptions(list) {
  const items = Array.isArray(list) ? list : [];
  const key = JSON.stringify(items);
  if (key === optionsKey) {
    // Same options: just reflect the current values and busy state.
    for (const sel of opts.querySelectorAll('select')) {
      const item = items.find((o) => o.id === sel.dataset.id);
      if (item) sel.value = item.current;
      sel.disabled = busy;
    }
    return;
  }
  optionsKey = key;
  opts.replaceChildren();
  for (const o of items) {
    if (!o || typeof o.id !== 'string') continue;
    const sel = document.createElement('select');
    sel.dataset.id = o.id;
    sel.title = String(o.label ?? o.id);
    sel.disabled = busy;
    for (const c of o.choices || []) {
      const opt = document.createElement('option');
      opt.value = String(c.value);
      opt.textContent = String(c.label);
      sel.append(opt);
    }
    sel.value = String(o.current ?? '');
    sel.onchange = () => vscode.postMessage({ type: 'setOption', id: o.id, value: sel.value });
    opts.append(sel);
  }
}

function setBusy(v) {
  busy = v;
  for (const sel of opts.querySelectorAll('select')) sel.disabled = v;
  skillsBtn.disabled = v;
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

// Skills are picked host-side: their descriptions are long, and a native quick pick
// is searchable where a narrow <select> would just truncate them.
skillsBtn.addEventListener('click', () => vscode.postMessage({ type: 'pickSkill' }));

/** Drops text at the caret and keeps focus in the composer. */
function insertAtCaret(text) {
  const start = input.selectionStart ?? input.value.length;
  const end = input.selectionEnd ?? start;
  input.value = input.value.slice(0, start) + text + input.value.slice(end);
  const pos = start + text.length;
  input.setSelectionRange(pos, pos);
  input.focus();
  input.dispatchEvent(new Event('input'));
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
      renderOptions(m.options);
      // Hidden entirely when the workspace and user config define no skills.
      skillsBtn.classList.toggle('on', Number(m.skills) > 0);
      renderStatus();
      break;
    case 'insert': insertAtCaret(String(m.text ?? '')); break;
    case 'user':    addUser(m.blocks); break;
    case 'message': renderMessage(m.role === 'thought' ? 'thought' : 'assistant', String(m.messageId), m.blocks, String(m.preview ?? '')); break;
    case 'tool':   upsertTool(m); break;
    case 'usage':
      if (typeof m.used === 'number' && typeof m.size === 'number' && m.size > 0) {
        usage = { used: m.used, size: m.size };
        renderStatus();
      }
      break;
    case 'history':
      if (Array.isArray(m.entries) && m.entries.length > 0) renderHistory(m.entries, m.truncated === true);
      break;
    case 'notice': addNotice(String(m.text), m.tone); break;
    case 'turnEnd':
      // Close every open stream so the next turn starts fresh nodes.
      streams.clear();
      if (m.stopReason && m.stopReason !== 'end_turn') addNotice('Turn ended: ' + m.stopReason, 'info');
      break;
    case 'restoreState':
      // Persisted by VS Code and handed back to the panel serializer after a
      // window reload, which is how a tab rebinds to its session.
      try { vscode.setState(m.state); } catch {}
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
    <span id="opts"></span>
    <button id="skills" title="Insert a skill reference">Skills</button>
    <span id="status"></span>
    <button id="stop" class="secondary" hidden>Stop</button>
    <button id="send">Send</button>
  </div>
</div>
<script nonce="${nonce}">${SCRIPT}</script>
</body>
</html>`;
}
