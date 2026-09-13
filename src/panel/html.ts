// src/panel/html.ts — the chat webview document.
//
// Pure string builder: no vscode import, so the markup is testable in isolation.
// The page renders only what ACP actually delivers — assistant text, reasoning,
// tool-call rows, and usage. DSH's richer surfaces (plans, todos, terminal views)
// are deliberately absent from the ACP contract and cannot be shown here.

import type { Block } from '../markdown';
import { menuHandlesKey, shouldSubmit } from '../composerKeys';
import { atTrigger, filterSkills, slashTrigger } from '../slashMenu';

/** A skill offered by the composer's slash menu. */
export interface SkillView {
  name: string;
  description: string;
}

/** One agent-advertised setting, flattened for a composer dropdown. */
export interface ConfigOptionView {
  id: string;
  label: string;
  current: string;
  choices: { value: string; label: string }[];
}

/** One chip in the composer's context strip. */
export interface ContextItemView {
  /** Stable identity, echoed back by toggle/remove. */
  id: string;
  label: string;
  kind: 'file' | 'selection';
  /** Unchecked chips stay attached but are left out of the next send. */
  enabled: boolean;
}

/** Messages the webview posts up to the extension host. */
export type PanelInbound =
  | { type: 'ready' }
  | { type: 'send'; text: string }
  | { type: 'cancel' }
  | { type: 'fileQuery'; query: string }
  | { type: 'addContextFile'; path: string }
  | { type: 'removeContext'; id: string }
  | { type: 'toggleContext'; id: string; enabled: boolean }
  | { type: 'openPath'; path: string; line?: number; endLine?: number }
  | { type: 'openExternal'; url: string }
  | { type: 'setOption'; id: string; value: string }
  | { type: 'newSession' }
  | { type: 'showSessions' }
  | { type: 'openSession'; id: string };

/** Messages the extension host posts down to the webview. */
export type PanelOutbound =
  /** `options` are the agent's advertised config options (model, reasoning effort). */
  | {
      type: 'state'; busy: boolean; sessionId: string | null;
      options: ConfigOptionView[]; skills: SkillView[];
      /** Shown in the panel header, so the tab does not have to carry it. */
      title: string;
    }
  /** Text to drop at the caret, e.g. a chosen skill reference. */
  | { type: 'insert'; text: string }
  /** The full context strip, re-sent whenever a chip is added, toggled or removed. */
  | { type: 'context'; items: ContextItemView[] }
  /** Ranked workspace paths answering one `@` query from the composer. */
  | { type: 'fileMatches'; query: string; items: string[] }
  /** Refills the composer with a message the agent never received (send failed). */
  | { type: 'restoreInput'; text: string }
  | { type: 'user'; blocks: Block[] }
  /**
   * A whole message, re-sent whenever streaming added text (the host coalesces the
   * deltas into ~40ms render cycles). Markdown is parsed in the host and only this
   * tree crosses the boundary, so the webview never handles an HTML string built
   * from agent output.
   */
  | { type: 'message'; role: 'assistant' | 'thought'; messageId: string; blocks: Block[]; preview: string }
  | { type: 'tool'; id: string; title: string; status: string; detail?: string; path?: string; line?: number }
  | { type: 'usage'; used: number; size: number }
  | { type: 'notice'; text: string; tone: 'info' | 'error' }
  | { type: 'turnEnd'; stopReason: string }
  | { type: 'history'; entries: HistoryEntryView[]; truncated: boolean }
  | { type: 'clear' }
  /** Handed to the webview so it can persist the binding for reload restore. */
  | { type: 'restoreState'; state: { sessionId: string } }
  /** Rows for the inline History popup. */
  | { type: 'sessionList'; items: SessionListItem[] };

/** One row of the panel's inline session list. */
export interface SessionListItem {
  id: string;
  title: string;
  when: string;
  open: boolean;
  active: boolean;
}

/** A restored transcript entry, already flattened by the history store. */
export type HistoryEntryView =
  | { kind: 'user'; blocks: Block[] }
  | { kind: 'assistant'; blocks: Block[]; reasoning: Block[]; preview: string }
  | { kind: 'tool'; id: string; name: string; detail: string; failed: boolean; path?: string; line?: number };

const STYLE = `
:root { color-scheme: light dark; }
* { box-sizing: border-box; }
body {
  margin: 0; height: 100vh; display: flex; flex-direction: column;
  font-family: var(--vscode-font-family); font-size: var(--vscode-font-size, 13px);
  color: var(--vscode-foreground); background: var(--vscode-sideBar-background);
}
/* Actions live in the panel, not the editor title bar. Title-bar menus are scoped by
   global context keys, which made them render over other groups and blink with
   focus; a header inside the webview is simply always where the conversation is. */
#head {
  display: flex; align-items: center; gap: 6px; flex: none;
  padding: 6px 8px; border-bottom: 1px solid var(--vscode-panel-border);
}
#head .title {
  flex: 1; font-size: 0.92em; font-weight: 600;
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
#head button {
  flex: none; padding: 2px 8px; font-size: 0.86em; line-height: 1.5;
  background: transparent; color: var(--vscode-foreground); opacity: 0.75;
  border: 1px solid var(--vscode-dropdown-border, var(--vscode-panel-border));
  border-radius: 3px; cursor: pointer;
}
#head button:hover { background: var(--vscode-list-hoverBackground); opacity: 1; }
/* Inline session list, anchored under the header. Switching conversation should not
   send the user off to another part of the window. */
#head { position: relative; }
#sessions {
  display: none; position: absolute; top: 100%; right: 8px; z-index: 40; margin-top: 4px;
  min-width: 240px; max-width: 380px; max-height: 300px; overflow-y: auto;
  background: var(--vscode-editorSuggestWidget-background, var(--vscode-editor-background));
  border: 1px solid var(--vscode-editorSuggestWidget-border, var(--vscode-panel-border));
  border-radius: 4px; box-shadow: 0 4px 14px rgba(0,0,0,.4);
}
#sessions.on { display: block; }
#sessions .row {
  display: flex; gap: 7px; align-items: baseline; padding: 5px 9px; cursor: pointer;
  border-left: 2px solid transparent;
}
#sessions .row:hover { background: var(--vscode-list-hoverBackground); }
#sessions .row.active {
  border-left-color: var(--vscode-focusBorder);
  background: var(--vscode-list-activeSelectionBackground);
  color: var(--vscode-list-activeSelectionForeground);
}
#sessions .row .dot { flex: none; width: 6px; height: 6px; border-radius: 50%; background: transparent; }
#sessions .row.open .dot { background: var(--vscode-charts-green, #89d185); }
#sessions .row .t { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
#sessions .row.open .t { font-weight: 600; }
#sessions .row .w { flex: none; font-size: 0.85em; opacity: 0.6; }
#sessions .empty { padding: 8px 10px; opacity: 0.6; font-size: 0.9em; }
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
/* Tables scroll inside their own box: the panel is narrow, and letting a wide table
   widen the transcript would make every message scroll sideways. */
.msg .tablewrap { overflow-x: auto; margin: 0 0 8px; }
.msg table { border-collapse: collapse; font-size: 0.95em; }
.msg th, .msg td {
  border: 1px solid var(--vscode-panel-border);
  padding: 4px 8px; text-align: left; vertical-align: top; white-space: pre-wrap;
}
.msg th { background: var(--vscode-textBlockQuote-background); font-weight: 600; }
.msg td.c, .msg th.c { text-align: center; }
.msg td.r, .msg th.r { text-align: right; }
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
/* A confirmed file reference: still monospace, but clearly actionable. */
.msg code.ref {
  color: var(--vscode-textLink-foreground); cursor: pointer;
  text-decoration: underline; text-decoration-style: dotted; text-underline-offset: 2px;
}
.msg code.ref:hover { text-decoration-style: solid; }
.msg.user {
  background: var(--vscode-textBlockQuote-background);
  border-left: 2px solid var(--vscode-focusBorder);
  padding: 6px 9px; border-radius: 3px;
}
.msg.assistant { padding: 0 2px; }
/* Transient "Working…" row shown in the transcript while a turn has started but
   no content has arrived yet; the first chunk/tool row replaces it. */
.msg.assistant.working {
  display: flex; gap: 8px; align-items: center; opacity: 0.65; font-size: 0.92em;
}
.msg.assistant.working .spinner { width: 10px; height: 10px; border-width: 2px; }
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
#composer { border-top: 1px solid var(--vscode-panel-border); padding: 8px; position: relative; }
/* Slash menu: anchored above the composer so it never covers what is being typed. */
#slash {
  display: none; position: absolute; left: 8px; right: 8px; bottom: 100%;
  max-height: 230px; overflow-y: auto; z-index: 20; margin-bottom: 4px;
  background: var(--vscode-editorSuggestWidget-background, var(--vscode-editor-background));
  border: 1px solid var(--vscode-editorSuggestWidget-border, var(--vscode-panel-border));
  border-radius: 4px; box-shadow: 0 3px 12px rgba(0,0,0,.35);
}
#slash.on { display: block; }
#slash .item { padding: 5px 9px; cursor: pointer; }
#slash .item.sel { background: var(--vscode-editorSuggestWidget-selectedBackground, var(--vscode-list-activeSelectionBackground)); }
#slash .item .n { font-weight: 600; }
#slash .item .d {
  display: block; font-size: 0.86em; opacity: 0.7;
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
#slash .empty { padding: 7px 9px; opacity: 0.6; font-size: 0.9em; }
/* Context chips: one row per attached file/selection, each with an include checkbox
   and a remove button. Hidden entirely when nothing is attached. */
#context { display: none; flex-wrap: wrap; gap: 4px; margin-bottom: 6px; }
#context.on { display: flex; }
.chip {
  display: inline-flex; align-items: center; gap: 4px; max-width: 100%;
  padding: 1px 3px 1px 6px; border-radius: 10px; font-size: 0.85em;
  background: var(--vscode-badge-background, rgba(127,127,127,.2));
  color: var(--vscode-badge-foreground, inherit);
}
.chip.off { opacity: 0.5; }
.chip .txt { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 240px; }
.chip input[type="checkbox"] { margin: 0; flex: none; }
.chip .rm {
  all: unset; flex: none; cursor: pointer; padding: 0 4px; border-radius: 50%;
  font-size: 1.1em; line-height: 1;
}
.chip .rm:hover { background: var(--vscode-toolbar-hoverBackground, rgba(127,127,127,.35)); }
#input {
  width: 100%; resize: none; min-height: 54px; max-height: 180px; padding: 6px 8px;
  color: var(--vscode-input-foreground); background: var(--vscode-input-background);
  border: 1px solid var(--vscode-input-border, transparent); border-radius: 3px;
  font-family: inherit; font-size: inherit;
}
#input:focus { outline: 1px solid var(--vscode-focusBorder); }
/* The bar must wrap rather than clip: in a narrow panel the dropdowns, busy
   spinner, Stop and Send are fixed-width items, and a single overflowing flex
   line pushes the right-hand ones (the spinner among them) past the viewport
   edge where they are unreachable. Wrapping lets them drop to a second line. */
#bar { display: flex; flex-wrap: wrap; align-items: center; gap: 4px 6px; margin-top: 6px; font-size: 0.85em; }
#opts { display: flex; gap: 4px; flex: 0 1 auto; min-width: 0; align-items: center; }
/* Self-drawn combobox rather than a native select element, which renders with the
   OS look inside a webview and sits oddly next to VS Code's flat dropdowns.
   Claude Code's webview reaches the same conclusion: role="combobox" throughout. */
.combo { position: relative; flex: 0 1 auto; min-width: 0; }
.combo > button {
  display: flex; align-items: center; gap: 4px; max-width: 150px; min-width: 0;
  padding: 2px 6px; font-family: inherit; font-size: 0.95em; line-height: 1.4;
  color: var(--vscode-dropdown-foreground, var(--vscode-foreground));
  background: var(--vscode-dropdown-background, transparent);
  border: 1px solid var(--vscode-dropdown-border, var(--vscode-panel-border));
  border-radius: 3px; cursor: pointer;
}
.combo > button:hover:not(:disabled) { background: var(--vscode-list-hoverBackground); }
.combo > button:disabled { opacity: 0.5; cursor: default; }
.combo > button .val { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.combo > button .caret { flex: none; font-size: 0.7em; opacity: 0.7; }
.combo-menu {
  display: none; position: absolute; bottom: 100%; left: 0; margin-bottom: 4px;
  min-width: 180px; max-width: 320px; max-height: 260px; overflow-y: auto; z-index: 30;
  background: var(--vscode-editorSuggestWidget-background, var(--vscode-editor-background));
  border: 1px solid var(--vscode-editorSuggestWidget-border, var(--vscode-panel-border));
  border-radius: 4px; box-shadow: 0 3px 12px rgba(0,0,0,.35);
}
.combo-menu.on { display: block; }
.combo-menu .opt {
  display: flex; gap: 6px; align-items: baseline; padding: 5px 9px;
  cursor: pointer; white-space: nowrap;
}
.combo-menu .opt.sel { background: var(--vscode-editorSuggestWidget-selectedBackground, var(--vscode-list-activeSelectionBackground)); }
.combo-menu .opt .tick { flex: none; width: 12px; opacity: 0.9; }
.combo-menu .opt .txt { overflow: hidden; text-overflow: ellipsis; }
/* Left-aligned, next to the dropdowns. Right-aligned it sat against Send, which
   read as if it belonged to the button. */
#status { flex: 1; display: flex; justify-content: flex-start; align-items: center; padding-left: 2px; }
/* Busy indicator: an animated spinner, a word describing what the agent is doing
   right now (Thinking…, Editing files…, Running a command… — the ACP events only
   say which tool/stream is live, so the label is inferred from that), and how long
   the turn has been running, so a silent agent (thinking, no chunks yet) still
   visibly "is working" instead of looking hung. Shown whenever a turn is in
   flight. */
#work { display: none; align-items: center; gap: 6px; flex: none;
  font-size: 0.85em; opacity: 0.75; margin-right: 2px; user-select: none;
  white-space: nowrap; }
#work.on { display: flex; }
.spinner { flex: none; width: 11px; height: 11px; border-radius: 50%;
  border: 2px solid var(--vscode-panel-border);
  border-top-color: var(--vscode-foreground);
  animation: spin .8s linear infinite; }
@keyframes spin { to { transform: rotate(360deg); } }
#work .doing { overflow: hidden; text-overflow: ellipsis; max-width: 190px; }
#work .when { font-variant-numeric: tabular-nums; }
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
const slash = document.getElementById('slash');
const contextEl = document.getElementById('context');
const headTitle = document.getElementById('head-title');
const work = document.getElementById('work');
const workDoing = document.getElementById('work-doing');
const workWhen = document.getElementById('work-when');

const sessionsMenu = document.getElementById('sessions');
document.getElementById('btn-new').onclick = () => vscode.postMessage({ type: 'newSession' });

function closeSessions() { sessionsMenu.classList.remove('on'); }

/** Renders the inline session list; the host answers a showSessions request with it. */
function renderSessions(items) {
  sessionsMenu.replaceChildren();
  const rows = Array.isArray(items) ? items : [];
  if (rows.length === 0) {
    const e = document.createElement('div');
    e.className = 'empty';
    e.textContent = 'No sessions yet';
    sessionsMenu.append(e);
  }
  for (const r of rows) {
    if (!r || typeof r.id !== 'string') continue;
    const row = document.createElement('div');
    row.className = 'row' + (r.open ? ' open' : '') + (r.active ? ' active' : '');
    row.setAttribute('role', 'option');
    const dot = document.createElement('span');
    dot.className = 'dot';
    const t = document.createElement('span');
    t.className = 't';
    t.textContent = String(r.title ?? '').replace(/\s+/g, ' ') || 'untitled';
    const w = document.createElement('span');
    w.className = 'w';
    w.textContent = String(r.when ?? '');
    row.append(dot, t, w);
    row.title = r.id;
    row.onmousedown = (e) => {
      e.preventDefault();
      closeSessions();
      // Clicking the session already shown is a no-op rather than a needless resume.
      if (!r.active) vscode.postMessage({ type: 'openSession', id: r.id });
    };
    sessionsMenu.append(row);
  }
  sessionsMenu.classList.add('on');
}

document.getElementById('btn-sessions').onclick = () => {
  if (sessionsMenu.classList.contains('on')) return closeSessions();
  vscode.postMessage({ type: 'showSessions' });
};

let busy = false;
let prevBusy = false; // last value setBusy saw, to detect turn start/end edges
let usage = null; // { used, size } once the agent has reported any
let workSince = 0;  // Date.now() when the current turn started
let workTimer = null; // 1s interval refreshing the elapsed counter
let workRow = null; // in-transcript "Working…" placeholder, replaced by content
let workLabel = null; // the label span inside workRow, so its word tracks activity
// What the agent is doing right now, shown next to the spinner (Claude Code-style).
// Inferred from the last live event: thought chunks mean thinking, an in-progress
// tool call means that tool's action, streamed assistant text means writing.
let activity = 'Working…';
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
    } else if (n.t === 'file') {
      // Rendered as code, not a link: it reads as a path and behaves like one.
      const el = document.createElement('code');
      el.className = 'ref';
      el.textContent = String(n.v ?? '');
      el.title = n.line ? n.path + ':' + n.line : n.path;
      el.onclick = () => vscode.postMessage({
        type: 'openPath', path: String(n.path), line: n.line, endLine: n.endLine,
      });
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
    } else if (b.t === 'table') {
      const wrap = document.createElement('div');
      wrap.className = 'tablewrap';
      const table = document.createElement('table');
      const align = Array.isArray(b.align) ? b.align : [];
      const cls = (i) => (align[i] === 'center' ? ' c' : align[i] === 'right' ? ' r' : '');
      const thead = document.createElement('thead');
      const hr = document.createElement('tr');
      (b.head || []).forEach((cell, i) => {
        const th = document.createElement('th');
        if (cls(i)) th.className = cls(i).trim();
        buildInline(cell, th);
        hr.append(th);
      });
      thead.append(hr);
      const tbody = document.createElement('tbody');
      for (const row of b.rows || []) {
        const tr = document.createElement('tr');
        (row || []).forEach((cell, i) => {
          const td = document.createElement('td');
          if (cls(i)) td.className = cls(i).trim();
          buildInline(cell, td);
          tr.append(td);
        });
        tbody.append(tr);
      }
      table.append(thead, tbody);
      wrap.append(table);
      into.append(wrap);
    }
  }
}

function addUser(blocks) {
  const wasBottom = atBottom();
  const el = document.createElement('div');
  el.className = 'msg user';
  buildBlocks(blocks, el);
  // send() shows the optimistic "Working…" row BEFORE the host echoes this prompt
  // back. The question belongs above that placeholder (it stands for the reply, so
  // the transcript must read question-then-working, never the reverse); without
  // this the row floats over the question until the first chunk replaces it.
  if (workRow) log.insertBefore(el, workRow);
  else log.append(el);
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
  // Real agent content has started: the placeholder "Working…" row is obsolete.
  replaceWorkRow();
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
  // A tool row is real activity: the placeholder "Working…" row is obsolete.
  replaceWorkRow();
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
    arg.onclick = () => vscode.postMessage({ type: 'openPath', path: m.path, line: m.line });
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
      if (e.path) {
        arg.classList.add('link');
        arg.title = String(e.path);
        arg.onclick = () => vscode.postMessage({ type: 'openPath', path: String(e.path), line: e.line });
      }
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

/** The combobox menu currently open, so only one is ever expanded. */
let openCombo = null;

function closeCombo() {
  if (!openCombo) return;
  openCombo.menu.classList.remove('on');
  openCombo.button.setAttribute('aria-expanded', 'false');
  openCombo = null;
}

/**
 * Builds one combobox.
 *
 * Keyboard behaviour mirrors a native select closely enough to be unsurprising:
 * arrows move, Enter commits, Escape cancels and returns focus to the button.
 */
function buildCombo(option) {
  const wrap = document.createElement('span');
  wrap.className = 'combo';

  const button = document.createElement('button');
  button.type = 'button';
  button.setAttribute('role', 'combobox');
  button.setAttribute('aria-expanded', 'false');
  button.title = String(option.label ?? option.id);
  const val = document.createElement('span');
  val.className = 'val';
  const caret = document.createElement('span');
  caret.className = 'caret';
  caret.textContent = '\u25BE';
  button.append(val, caret);

  const menu = document.createElement('div');
  menu.className = 'combo-menu';
  menu.setAttribute('role', 'listbox');

  const choices = Array.isArray(option.choices) ? option.choices : [];
  const current = () => choices.findIndex((c) => c.value === option.current);
  let cursor = Math.max(0, current());

  const label = choices.find((c) => c.value === option.current);
  val.textContent = label ? label.label : String(option.current ?? '');

  const paint = () => {
    for (const [i, el] of [...menu.children].entries()) el.classList.toggle('sel', i === cursor);
    const sel = menu.children[cursor];
    if (sel) sel.scrollIntoView({ block: 'nearest' });
  };

  const commit = (i) => {
    const choice = choices[i];
    closeCombo();
    button.focus();
    if (!choice || choice.value === option.current) return;
    vscode.postMessage({ type: 'setOption', id: option.id, value: choice.value });
  };

  choices.forEach((c, i) => {
    const opt = document.createElement('div');
    opt.className = 'opt';
    opt.setAttribute('role', 'option');
    const tick = document.createElement('span');
    tick.className = 'tick';
    tick.textContent = c.value === option.current ? '\u2713' : '';
    const txt = document.createElement('span');
    txt.className = 'txt';
    txt.textContent = c.label;
    opt.append(tick, txt);
    opt.onmouseenter = () => { cursor = i; paint(); };
    opt.onmousedown = (e) => { e.preventDefault(); commit(i); };
    menu.append(opt);
  });

  const open = () => {
    if (button.disabled || choices.length === 0) return;
    closeCombo();
    cursor = Math.max(0, current());
    menu.classList.add('on');
    button.setAttribute('aria-expanded', 'true');
    openCombo = { menu, button };
    paint();
  };

  button.onclick = () => (openCombo && openCombo.menu === menu ? closeCombo() : open());
  button.onkeydown = (e) => {
    const isOpen = openCombo !== null && openCombo.menu === menu;
    if (!isOpen) {
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp' || e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        open();
      }
      return;
    }
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      cursor = (cursor + (e.key === 'ArrowDown' ? 1 : -1) + choices.length) % choices.length;
      paint();
    } else if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      commit(cursor);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      closeCombo();
    }
  };

  wrap.append(button, menu);
  return { wrap, button };
}

/**
 * Renders the agent's advertised settings.
 *
 * Rebuilt only when the option set actually changes, so an open menu is not torn
 * out from under the pointer by an unrelated state push.
 */
let optionsKey = '';
function renderOptions(list) {
  const items = Array.isArray(list) ? list : [];
  const key = JSON.stringify(items);
  if (key === optionsKey) {
    for (const b of opts.querySelectorAll('.combo > button')) b.disabled = busy;
    return;
  }
  optionsKey = key;
  closeCombo();
  opts.replaceChildren();
  for (const o of items) {
    if (!o || typeof o.id !== 'string') continue;
    const { wrap, button } = buildCombo(o);
    button.disabled = busy;
    opts.append(wrap);
  }
}

// A click anywhere else dismisses an open menu, as a native dropdown would.
document.addEventListener('mousedown', (e) => {
  if (openCombo && !openCombo.menu.contains(e.target) && e.target !== openCombo.button
      && !openCombo.button.contains(e.target)) closeCombo();
  const btn = document.getElementById('btn-sessions');
  if (sessionsMenu.classList.contains('on') && !sessionsMenu.contains(e.target)
      && e.target !== btn && !btn.contains(e.target)) closeSessions();
}, true);
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && sessionsMenu.classList.contains('on')) closeSessions();
});

/**
 * Inserts a transient "Working…" assistant row at the bottom of the transcript.
 * It stands in for the reply while the agent has accepted the prompt but nothing
 * has streamed yet; the first real chunk/tool row removes it (replaceWorkRow).
 * Shown optimistically on send and again when the busy edge arrives; either way it
 * marks a fresh turn, so the activity word resets here.
 */
function showWorkRow() {
  if (workRow) return;
  const wasBottom = atBottom();
  activity = 'Working…';
  paintActivity();
  workRow = document.createElement('div');
  workRow.className = 'msg assistant working';
  const spin = document.createElement('span');
  spin.className = 'spinner';
  const label = document.createElement('span');
  label.textContent = activity;
  workLabel = label;
  workRow.append(spin, label);
  log.append(workRow);
  scroll(wasBottom);
}

/** Removes the placeholder once real content arrived (or the turn ended). */
function replaceWorkRow() {
  if (!workRow) return;
  const wasBottom = atBottom();
  workRow.remove();
  workRow = null;
  workLabel = null;
  scroll(wasBottom);
}

/** Writes the current activity word into the busy pill and the placeholder row. */
function paintActivity() {
  workDoing.textContent = activity;
  if (workLabel) workLabel.textContent = activity;
}

/** Switches the "what is the agent doing" word (no-op when it is unchanged). */
function setActivity(text) {
  if (text === activity) return;
  activity = text;
  paintActivity();
}

/**
 * A human word for an in-flight tool, from its name. dsh's tool set is small and
 * stable (bash, read, edit, write, grep, glob, web_search, web_fetch, todo_write…),
 * so a name test is enough — no title from the agent ever needs to reach the DOM.
 */
const TOOL_ACTIVITY = [
  [/web|fetch|curl|http|url/, 'Searching the web…'],
  [/image|screenshot|picture/, 'Looking at an image…'],
  [/todo|plan|goal|task/, 'Planning…'],
  [/bash|shell|sh\b|command|exec|run|npm|pnpm|yarn|test/, 'Running a command…'],
  [/edit|patch|apply|replace|modify|sed/, 'Editing files…'],
  [/write|create|append|mkdir/, 'Writing files…'],
  [/read/, 'Reading…'],
  [/grep|search|glob|find|rg\b|lookup|locate/, 'Searching…'],
  [/agent|subagent|job/, 'Coordinating agents…'],
  [/skill/, 'Using a skill…'],
];
function activityForTool(title) {
  const t = String(title ?? '').toLowerCase();
  for (const [re, word] of TOOL_ACTIVITY) if (re.test(t)) return word;
  return 'Working…';
}

function setBusy(v) {
  const started = v && !prevBusy;
  const ended = !v && prevBusy;
  prevBusy = v;
  busy = v;
  for (const b of opts.querySelectorAll('.combo > button')) b.disabled = v;
  if (v) closeCombo();
  sendBtn.disabled = v;
  stopBtn.hidden = !v;
  // Elapsed time since the turn started (kept across repeated busy state pushes).
  if (v) {
    work.classList.add('on');
    if (workTimer === null) {
      workSince = Date.now();
      workTimer = setInterval(paintWork, 1000);
    }
    paintWork();
    // A fresh turn starts at "Working…" (the row's own creation also does this);
    // later pushes while a turn runs must NOT reset a word already narrowed down
    // to Thinking… / Editing files… / etc.
    if (started) showWorkRow();
  } else {
    work.classList.remove('on');
    if (workTimer !== null) { clearInterval(workTimer); workTimer = null; }
    if (ended) replaceWorkRow();
  }
  input.placeholder = v ? 'Agent is working…' : 'Ask the agent  (Enter to send, Shift+Enter for a newline, @ for files)';
}

function paintWork() {
  const s = Math.max(0, Math.round((Date.now() - workSince) / 1000));
  workWhen.textContent = s + 's';
}

function send() {
  // A click on Send during composition would read a value the IME has not committed.
  if (composing) return;
  const text = input.value.trim();
  if (text === '' || busy) return;
  input.value = '';
  input.style.height = 'auto';
  vscode.postMessage({ type: 'send', text });
  // Show the "Working…" placeholder synchronously, not on the host's busy echo.
  // The echo travels postMessage → RPC and back, so under a slow reply (or a turn
  // that started while the page was still loading, where the echo is replayed from
  // a queue) the placeholder could otherwise arrive and vanish without ever being
  // painted. Here it is in the DOM before send() returns; real content, turn end,
  // or the busy:false that follows a failed send still remove it.
  showWorkRow();
}

// —— composer menu: '/' for skills, '@' for files ——
// Typing '/' at the start of a line opens the skill list; typing '@' opens the
// workspace file list. Both render in the same popover right above the input, so the
// choice stays part of writing the message instead of a detour through a dialog.
let skills = [];
let menuKind = 'skill'; // 'skill' | 'file'
let menuItems = [];     // skill objects, or workspace-relative paths
let menuIndex = 0;
let menuFrom = -1;      // caret offset of the '/' or '@' that opened the menu
let fileMatches = [];   // the last matches the host sent
let askedQuery = null;  // the '@' query those matches answer; null once answered

function closeSlash() {
  slash.classList.remove('on');
  menuItems = [];
  menuFrom = -1;
  askedQuery = null;
}

/*__SLASH_LOGIC__*/

function renderSlash() {
  slash.replaceChildren();
  if (menuItems.length === 0) {
    const e = document.createElement('div');
    e.className = 'empty';
    e.textContent = menuKind === 'file'
      ? (askedQuery === null ? 'No matching file' : 'Searching…')
      : 'No matching skill';
    slash.append(e);
    return;
  }
  menuItems.forEach((item, i) => {
    const row = document.createElement('div');
    row.className = 'item' + (i === menuIndex ? ' sel' : '');
    row.setAttribute('role', 'option');
    const n = document.createElement('span');
    n.className = 'n';
    const d = document.createElement('span');
    d.className = 'd';
    if (menuKind === 'file') {
      const at = String(item).lastIndexOf('/');
      n.textContent = at === -1 ? String(item) : String(item).slice(at + 1);
      d.textContent = at === -1 ? '' : String(item).slice(0, at);
    } else {
      n.textContent = '/' + item.name;
      d.textContent = item.description;
    }
    row.append(n, d);
    row.onmousedown = (ev) => { ev.preventDefault(); acceptSlash(i); };
    slash.append(row);
  });
  const sel = slash.querySelector('.sel');
  if (sel) sel.scrollIntoView({ block: 'nearest' });
}

function updateSlash() {
  const caret = input.selectionStart ?? 0;
  const skillHit = slashTrigger(input.value, caret);
  if (skillHit) {
    if (skills.length === 0) return closeSlash();
    menuKind = 'skill';
    menuFrom = skillHit.from;
    menuItems = filterSkills(skills, skillHit.query);
    menuIndex = 0;
    slash.classList.add('on');
    renderSlash();
    return;
  }
  const fileHit = atTrigger(input.value, caret);
  if (!fileHit) return closeSlash();
  menuKind = 'file';
  menuFrom = fileHit.from;
  menuIndex = 0;
  // Ask the host once per distinct query; the reply carries the query back so a slow
  // one for an earlier keystroke cannot overwrite the current list.
  if (askedQuery !== fileHit.query) {
    askedQuery = fileHit.query;
    fileMatches = [];
    vscode.postMessage({ type: 'fileQuery', query: fileHit.query });
  }
  menuItems = fileMatches;
  slash.classList.add('on');
  renderSlash();
}

/**
 * Accepts the highlighted row.
 *
 * A skill is replaced by a reference the model acts on. A file becomes a context chip
 * instead: the typed at-query is scaffolding and is deleted, because the chip is what
 * carries the reference at send time.
 */
function acceptSlash(i) {
  const chosen = menuItems[i];
  if (chosen === undefined || menuFrom < 0) return closeSlash();
  const caret = input.selectionStart ?? 0;
  const from = menuFrom;
  if (menuKind === 'file') {
    input.value = input.value.slice(0, from) + input.value.slice(caret);
    closeSlash();
    input.setSelectionRange(from, from);
    input.focus();
    vscode.postMessage({ type: 'addContextFile', path: String(chosen) });
    input.dispatchEvent(new Event('input'));
    return;
  }
  // A literal backtick would close the String.raw template this script lives in.
  const tick = String.fromCharCode(96);
  const text = 'Use the ' + tick + chosen.name + tick + ' skill: ';
  input.value = input.value.slice(0, from) + text + input.value.slice(caret);
  const pos = from + text.length;
  closeSlash();
  input.setSelectionRange(pos, pos);
  input.focus();
  input.dispatchEvent(new Event('input'));
}

/** Drops text at the caret and keeps focus in the composer. */
function insertAtCaret(text) {
  let t = String(text ?? '');
  if (t === '') return;
  const start = input.selectionStart ?? input.value.length;
  const end = input.selectionEnd ?? start;
  const before = input.value.slice(0, start);
  const after = input.value.slice(end);
  // Keep inserted tokens separate: an @mention glued to the previous word
  // ("see@src/a.ts") is no longer a mention the harness can recognise.
  if (before !== '' && !/\s$/.test(before) && !/^\s/.test(t)) t = ' ' + t;
  if (after !== '' && !/^\s/.test(after) && !/\s$/.test(t)) t = t + ' ';
  input.value = before + t + after;
  const pos = start + t.length;
  input.setSelectionRange(pos, pos);
  input.focus();
  input.dispatchEvent(new Event('input'));
}

// —— context strip ——
// Files and selections attached to the next message. The host owns the list (both the
// composer buttons and the explorer right-click feed it) and re-sends it on every
// change; the webview only renders it and reports intent. Nothing is attached
// implicitly — a chip exists only because the user added it, and each one can be
// switched off or removed again.
let contexts = [];

function renderContexts() {
  contextEl.replaceChildren();
  contextEl.classList.toggle('on', contexts.length > 0);
  for (const c of contexts) {
    const chip = document.createElement('span');
    chip.className = 'chip' + (c.enabled ? '' : ' off');
    const box = document.createElement('input');
    box.type = 'checkbox';
    box.checked = c.enabled !== false;
    box.title = 'Include this in the next message';
    box.onchange = () => vscode.postMessage({ type: 'toggleContext', id: c.id, enabled: box.checked });
    const txt = document.createElement('span');
    txt.className = 'txt';
    txt.textContent = c.label;
    txt.title = c.kind === 'selection' ? 'Selected text — ' + c.label : c.label;
    const rm = document.createElement('button');
    rm.type = 'button';
    rm.className = 'rm';
    rm.textContent = '×';
    rm.title = 'Remove from context';
    rm.onclick = () => vscode.postMessage({ type: 'removeContext', id: c.id });
    chip.append(box, txt, rm);
    contextEl.append(chip);
  }
}

sendBtn.addEventListener('click', send);
stopBtn.addEventListener('click', () => vscode.postMessage({ type: 'cancel' }));
// An IME reports composition around candidate selection; nothing typed during it is
// final, so neither sending nor the slash menu may act on those keys.
let composing = false;
input.addEventListener('compositionstart', () => { composing = true; });
input.addEventListener('compositionend', () => { composing = false; updateSlash(); });

input.addEventListener('keydown', (e) => {
  const ime = { ...{ key: e.key, shiftKey: e.shiftKey, keyCode: e.keyCode }, isComposing: e.isComposing || composing };
  // While the menu is open it owns navigation keys, so Enter picks a skill rather
  // than sending a half-written message.
  if (slash.classList.contains('on') && menuHandlesKey(ime)) {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      if (menuItems.length > 0) {
        menuIndex = (menuIndex + (e.key === 'ArrowDown' ? 1 : -1) + menuItems.length) % menuItems.length;
        renderSlash();
      }
      return;
    }
    if (e.key === 'Enter' || e.key === 'Tab') {
      if (menuItems.length > 0) { e.preventDefault(); acceptSlash(menuIndex); return; }
      closeSlash();
    }
    if (e.key === 'Escape') { e.preventDefault(); closeSlash(); return; }
  }
  if (shouldSubmit(ime)) { e.preventDefault(); send(); }
});
input.addEventListener('input', () => {
  input.style.height = 'auto';
  input.style.height = Math.min(input.scrollHeight, 180) + 'px';
  // Candidate text is not a query; wait for the composition to settle.
  if (!composing) updateSlash();
});
// The trigger depends on the caret, so moving it must re-evaluate the menu.
input.addEventListener('keyup', (e) => {
  if (['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(e.key)) updateSlash();
});
input.addEventListener('click', updateSlash);
input.addEventListener('blur', closeSlash);

window.addEventListener('message', (e) => {
  const m = e.data;
  if (!m || typeof m !== 'object') return;
  switch (m.type) {
    case 'state':
      setBusy(m.busy === true);
      renderOptions(m.options);
      // Skills are reached by typing '/' at the start of a line, files by '@'; no
      // toolbar entry is needed for either (the Files button just types the '@').
      skills = Array.isArray(m.skills) ? m.skills : [];
      if (typeof m.title === 'string' && m.title !== '') headTitle.textContent = m.title;
      renderStatus();
      break;
    case 'insert': insertAtCaret(String(m.text ?? '')); break;
    case 'context':
      contexts = Array.isArray(m.items) ? m.items : [];
      renderContexts();
      break;
    case 'fileMatches':
      // Only the answer to the query still being typed matters; a slow reply for an
      // earlier keystroke is stale and must not replace the list on screen.
      if (m.query === askedQuery) {
        askedQuery = null;
        fileMatches = Array.isArray(m.items) ? m.items : [];
        if (menuKind === 'file' && slash.classList.contains('on')) {
          menuItems = fileMatches;
          menuIndex = 0;
          renderSlash();
        }
      }
      break;
    case 'restoreInput':
      // Put back a message the agent never received. Only when the composer is
      // still empty — if the user already typed a retry, never clobber it. busy
      // is deliberately NOT part of the guard: the host echoes busy before the
      // failure surfaces, so by the time this arrives the failed send's busy
      // flag may still be set even though its turn is over — and the text then
      // belongs back in the composer.
      if (input.value.trim() === '') {
        input.value = String(m.text ?? '');
        input.style.height = 'auto';
        input.style.height = Math.min(input.scrollHeight, 180) + 'px';
        input.dispatchEvent(new Event('input'));
      }
      input.focus();
      break;
    case 'sessionList': renderSessions(m.items); break;
    case 'user':    addUser(m.blocks); break;
    case 'message':
      // What the agent is doing: reasoning streams in as thoughts, the reply as
      // assistant text. The word matters only while the turn is busy, but it is
      // cheap and harmless to track regardless (the pill is hidden otherwise).
      setActivity(m.role === 'thought' ? 'Thinking…' : 'Writing…');
      renderMessage(m.role === 'thought' ? 'thought' : 'assistant', String(m.messageId), m.blocks, String(m.preview ?? ''));
      break;
    case 'tool':
      // A live tool call names the activity: Running a command… / Editing files… /
      // Reading… etc. Completed/failed updates leave the word alone — the next
      // event (another tool, a thought, the reply) re-names it.
      if (m.status === 'pending' || m.status === 'in_progress') setActivity(activityForTool(m.title));
      upsertTool(m);
      break;
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
      // Close every open stream so the next turn starts fresh nodes; a turn that
      // produced no content (e.g. an empty refusal) should drop the placeholder.
      streams.clear();
      replaceWorkRow();
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
      workRow = null;
      workLabel = null;
      contexts = [];
      renderContexts();
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
/**
 * The decision helpers, injected verbatim so the panel runs the same code the tests
 * exercise. They are plain functions with no closure over module scope, which is
 * what makes serialising them safe.
 */
function slashLogicSource(): string {
  return [
    slashTrigger.toString(),
    atTrigger.toString(),
    filterSkills.toString(),
    shouldSubmit.toString(),
    menuHandlesKey.toString(),
  ].join('\n');
}

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
<div id="head">
  <span class="title" id="head-title">DSH</span>
  <button id="btn-new" title="Start a new session">+ New</button>
  <button id="btn-sessions" title="Show the session list">History</button>
  <div id="sessions" role="listbox"></div>
</div>
<div id="log"></div>
<div id="composer">
  <div id="slash" role="listbox"></div>
  <div id="context" role="list"></div>
  <textarea id="input" rows="2" placeholder="Ask the agent  (Enter to send, Shift+Enter for a newline, @ for files)"></textarea>
  <div id="bar">
    <span id="opts"></span>
    <span id="status"></span>
    <span id="work" title="The agent is working…">
      <span class="spinner" aria-hidden="true"></span>
      <span id="work-doing" class="doing">Working…</span>
      <span id="work-when" class="when"></span>
    </span>
    <button id="stop" class="secondary" hidden>Stop</button>
    <button id="send">Send</button>
  </div>
</div>
<script nonce="${nonce}">${SCRIPT.replace('/*__SLASH_LOGIC__*/', slashLogicSource())}</script>
</body>
</html>`;
}
