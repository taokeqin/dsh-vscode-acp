// src/panel/chatPanel.ts — one editor tab per ACP session.
//
// Each session is a real WebviewPanel, so closing, dragging, splitting, Ctrl+Tab and
// tab groups are VS Code's behaviour rather than something reimplemented in a webview.
// Panels are registered by sessionId so a second request reveals the existing tab.
import { randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import * as path from 'node:path';
import * as vscode from 'vscode';
import type { AcpConnection } from '../acp/connection';
import type { ConfigOption, SessionUpdate, ToolCallContent } from '../acp/types';
import { loadTranscript, type SessionMeta } from '../history/store';
import { inlineToText, parseMarkdown, type Block } from '../markdown';
import { loadSkills, type Skill } from '../skills';
import type { SessionCatalog } from '../sessionCatalog';
import { dshHome } from '../dshHome';
import { decorateFileRefs, resolveInWorkspace } from '../decorateFileRefs';
import { parseFileRef } from '../fileRef';
import { pickSessionColumn } from '../panelColumn';
import { chatHtml, type ConfigOptionView, type PanelInbound, type PanelOutbound, type SkillView } from './html';

/** Tool arguments that name a file, in the order we prefer them. */
const PATH_KEYS = ['file_path', 'path', 'filePath', 'notebook_path'];

/** How long incoming stream chunks are held before one coalesced render+post. */
const STREAM_FLUSH_MS = 40;
/** Max length of the flattened one-line summary of a tool result. */
const TOOL_DETAIL_MAX = 120;
/** How long a file-existence answer is trusted before re-stat'ing (files can be
 * created mid-turn by the agent, so negatives must not be cached forever). */
const EXISTS_TTL_MS = 1000;
/** Upper bound on cached existence answers, evicting oldest first. */
const EXISTS_CACHE_MAX = 512;

/**
 * Posts to a webview while tolerating disposal.
 *
 * VS Code can dispose a panel (tab closed, window reload, restart) between a
 * guard check and the post; postMessage on a disposed webview then throws
 * "Webview is disposed". That is not a bug — the user simply closed the tab —
 * so the throw is swallowed. Every host→webview post goes through here.
 */
function postSafe(webview: vscode.Webview, msg: PanelOutbound): void {
  try {
    void webview.postMessage(msg);
  } catch {
    // Disposed between the guard and the post: nothing left to deliver to.
  }
}

function pathFromInput(input: Record<string, unknown> | undefined): string | undefined {
  if (!input) return undefined;
  for (const key of PATH_KEYS) {
    const v = input[key];
    if (typeof v === 'string' && v !== '') return v;
  }
  return undefined;
}

function summariseInput(input: Record<string, unknown> | undefined, root: string): string {
  const p = pathFromInput(input);
  if (p) return path.isAbsolute(p) ? path.relative(root, p) || p : p;
  if (!input) return '';
  const first = Object.values(input).find((v) => typeof v === 'string') as string | undefined;
  return first ? first.replace(/\s+/g, ' ').slice(0, 120) : '';
}

/** First line of a block tree, for a collapsed reasoning summary. */
function previewOf(blocks: Block[]): string {
  for (const b of blocks) {
    const text =
      b.t === 'code' ? b.v : 'v' in b && Array.isArray(b.v) ? inlineToText(b.v) : '';
    const line = text.split('\n').map((l) => l.trim()).find((l) => l !== '');
    if (line) return line.length > 90 ? `${line.slice(0, 90)}…` : line;
  }
  return '';
}

/**
 * Flattens tool result content into a short one-line summary.
 *
 * Content nests one level: { type, content: { text } }, and a tool result can be
 * huge (a `read` of a large file). Only the first ~120 characters are wanted, so
 * blocks are walked word-wise and the walk stops the moment the budget is spent —
 * never joining or whitespace-collapsing the whole payload first.
 */
function flattenToolContent(content: ToolCallContent[] | undefined): string {
  if (!Array.isArray(content)) return '';
  let out = '';
  for (const c of content) {
    const t = c.content && typeof c.content.text === 'string' ? c.content.text : '';
    if (t === '') continue;
    for (const word of t.split(/\s+/)) {
      if (word === '') continue;
      if (out === '') out = word;
      else if (out.length + 1 + word.length <= TOOL_DETAIL_MAX) out += ' ' + word;
      else return out; // Budget spent: the rest of this payload is irrelevant.
    }
  }
  return out;
}

/**
 * Flattens one advertised option into composer-dropdown shape.
 *
 * Choices arrive nested under provider groups, but a narrow dropdown reads better
 * flat, so the group name is folded into the label only when there is more than one.
 */
function flattenOption(option: ConfigOption): ConfigOptionView {
  const choices: { value: string; label: string; group: string }[] = [];
  const walk = (list: ConfigOption['options'], group: string): void => {
    for (const c of list ?? []) {
      if (c.value !== undefined) choices.push({ value: c.value, label: c.name ?? c.value, group });
      walk(c.options, c.group ?? group);
    }
  };
  walk(option.options, '');
  const groups = new Set(choices.map((c) => c.group).filter((g) => g !== ''));
  return {
    id: option.id,
    label: option.name ?? option.id,
    current: option.currentValue ?? '',
    choices: choices.map((c) => ({
      value: c.value,
      label: groups.size > 1 && c.group !== '' ? `${c.group} · ${c.label}` : c.label,
    })),
  };
}

/** State persisted with the tab so a window reload can rebind the same session. */
interface PanelState {
  sessionId: string;
}

export const CHAT_VIEW_TYPE = 'dshAgent.chatPanel';

/** Tab label used while a fresh session has no content yet; replaced on first message. */
export const NEW_SESSION_TITLE = 'DSH · new session';

export class ChatPanel {
  /** Open panels by sessionId — the source of truth for "is this session open". */
  private static readonly open = new Map<string, ChatPanel>();
  /**
   * The shared session catalog, used by the inline History popup.
   *
   * Static because every panel needs it and panels are constructed from a static
   * factory; set once at activation alongside the sidebar's copy.
   */
  private static catalog: SessionCatalog | null = null;

  static useCatalog(catalog: SessionCatalog): void {
    ChatPanel.catalog = catalog;
  }

  /** Notified whenever the set of open panels or the active one changes. */
  private static readonly changeEmitter = new vscode.EventEmitter<void>();
  static readonly onDidChangeOpen = ChatPanel.changeEmitter.event;

  private readonly disposables: vscode.Disposable[] = [];
  private unsubscribe: (() => void) | null = null;
  private readonly toolTitles = new Map<string, string>();
  /**
   * Accumulated text per streaming message id.
   *
   * Chunks are deltas, but Markdown only parses correctly as a whole — a half-received
   * fence or bold run is not yet valid. So the full text is kept; parsing and posting
   * are coalesced: chunks arriving within a few milliseconds mark the message dirty
   * and one render cycle paints the latest state, instead of re-parsing and re-posting
   * the whole message once per chunk (which is O(n²) over a long stream).
   */
  private readonly streamText = new Map<string, string>();
  /** Keys whose accumulated text changed and awaits the next coalesced render. */
  private readonly streamDirty = new Map<string, { role: 'assistant' | 'thought'; messageId: string }>();
  private streamTimer: NodeJS.Timeout | null = null;
  private disposed = false;
  /**
   * Whether the webview page has signalled 'ready'. VS Code drops postMessage calls
   * made before the page has loaded, so outbound messages are buffered until then —
   * a restored history, an early notice, or the first stream chunks would otherwise
   * vanish silently.
   */
  private ready = false;
  /** Outbound messages produced while the page was still loading. */
  private readonly pendingOutbound: PanelOutbound[] = [];

  private constructor(
    private readonly panel: vscode.WebviewPanel,
    private readonly sessionId: string,
    /** Shared agent connection; also read by syncBusyContext for the active tab. */
    private readonly connection: AcpConnection,
    private readonly workspaceRoot: string,
    private readonly log: (line: string) => void,
  ) {
    ChatPanel.open.set(sessionId, this);

    panel.webview.options = { enableScripts: true };
    panel.webview.html = chatHtml(randomBytes(16).toString('base64'));
    this.disposables.push(
      panel.webview.onDidReceiveMessage((msg: PanelInbound) => void this.onMessage(msg)),
      panel.onDidChangeViewState(() => {
        ChatPanel.syncBusyContext();
        ChatPanel.changeEmitter.fire();
        // Focusing the tab is a cheap moment to re-check the log title: a title
        // dsh wrote after the last turn (or a flush that landed late) shows up
        // here even if the turn-end refresh found nothing yet.
        if (panel.active) void this.refreshTitle();
      }),
      panel.onDidDispose(() => void this.dispose()),
    );

    this.unsubscribe = connection.subscribe(sessionId, (u) => this.onUpdate(u));
    ChatPanel.changeEmitter.fire();
  }

  /**
   * Publishes whether the *visible* tab has a turn in flight, so the Stop button can
   * appear only while it is useful. Busy state is per session, and the title bar
   * belongs to whichever tab is active, so this is recomputed on every view-state
   * change as well as around each turn.
   */
  private static syncBusyContext(): void {
    const id = ChatPanel.activeSessionId();
    const panel = id === null ? undefined : ChatPanel.open.get(id);
    const busy = panel !== undefined && panel.connection.busy(panel.sessionId);
    void vscode.commands.executeCommand('setContext', 'dshAgent.busy', busy);
  }

  /** Sessions with an open tab. */
  static openSessionIds(): string[] {
    return [...ChatPanel.open.keys()];
  }

  /** The session whose tab is currently visible, if any. */
  static activeSessionId(): string | null {
    for (const [id, p] of ChatPanel.open) if (p.panel.active) return id;
    return null;
  }

  static get(sessionId: string): ChatPanel | undefined {
    return ChatPanel.open.get(sessionId);
  }

  /** Brings this tab to the front. */
  reveal(column?: vscode.ViewColumn): void {
    if (this.disposed) return;
    try {
      this.panel.reveal(column);
    } catch {
      // Tab closed between the lookup and the reveal; nothing to bring forward.
    }
  }

  /** Sets the tab label and pushes it into the panel header. */
  setTitle(title: string): void {
    if (this.disposed) return;
    try {
      this.panel.title = title;
    } catch {
      // The panel can be disposed between the guard and the assignment (an async
      // refreshTitle resolving after the tab was closed); a title is cosmetic, so
      // give up quietly rather than surface "Webview is disposed".
      return;
    }
    this.pushState();
  }

  /**
   * Re-titles the tab from the session log.
   *
   * dsh derives a session's title from its first user message and writes it to the
   * log, so a tab created before any message ("DSH · new session") can only be
   * named once a turn has run. Called after every finished turn and after a
   * restore; a no-op until the log actually carries a title.
   */
  private async refreshTitle(): Promise<void> {
    const catalog = ChatPanel.catalog;
    if (!catalog) return;
    let meta: SessionMeta;
    try {
      meta = await catalog.metaFor(this.sessionId);
    } catch {
      return;
    }
    const raw = meta.title;
    if (typeof raw !== 'string' || raw === '') return;
    const oneLine = raw.replace(/\s+/g, ' ').trim();
    if (oneLine === '') return;
    this.setTitle(`DSH · ${oneLine.slice(0, 40)}`);
  }

  /** Where the FIRST session tab opens, from dshAgent.panelColumn. */
  private static configuredColumn(): vscode.ViewColumn {
    const pref = vscode.workspace.getConfiguration('dshAgent').get<string>('panelColumn', 'Beside');
    return pref === 'Active' ? vscode.ViewColumn.Active : vscode.ViewColumn.Beside;
  }

  /**
   * Which column a new session tab should open in.
   *
   * Sessions belong together, so the second one joins the first as a tab rather than
   * splitting the editor again. `Beside` alone could not do that: it means "next to
   * whatever is active", so opening a session from a session tab kept creating a new
   * group each time. Reuse the column an existing tab already occupies — preferring
   * the visible one — and fall back to the configured column only when none is open.
   */
  private static preferredColumn(): { column: vscode.ViewColumn; reused: boolean } {
    const activeId = ChatPanel.activeSessionId();
    const active = activeId === null ? undefined : ChatPanel.open.get(activeId);
    const others = [...ChatPanel.open.values()].map((p) => p.panel.viewColumn as number | undefined);
    const choice = pickSessionColumn(
      active?.panel.viewColumn as number | undefined,
      others,
      ChatPanel.configuredColumn() as number,
    );
    return { column: choice.column as vscode.ViewColumn, reused: choice.reused };
  }

  /**
   * Locks the group the session tabs live in.
   *
   * A locked group refuses new editors, so opening a file — from the explorer, from
   * Cmd+P, or from a tool row — lands in the code group instead of stacking on top
   * of the conversation. This is what Claude Code does after creating its panel.
   *
   * Only ever applied to a group we created ourselves: with panelColumn set to
   * `Active` the session shares the user's code group, and locking that would stop
   * them opening files where they expect.
   */
  private static async lockOwnGroup(): Promise<void> {
    const cfg = vscode.workspace.getConfiguration('dshAgent');
    if (!cfg.get<boolean>('lockEditorGroup', true)) return;
    if (cfg.get<string>('panelColumn', 'Beside') === 'Active') return;
    try {
      // Acts on the active group, which is the one the new panel just created.
      await vscode.commands.executeCommand('workbench.action.lockEditorGroup');
    } catch {
      // Older hosts may not have the command; an unlocked group still works.
    }
  }

  /**
   * Creates a tab for a session that is already bound agent-side.
   * Callers own resume/new; this only builds the view.
   */
  static create(
    sessionId: string,
    title: string,
    connection: AcpConnection,
    workspaceRoot: string,
    log: (line: string) => void,
  ): ChatPanel {
    const { column, reused } = ChatPanel.preferredColumn();
    const panel = vscode.window.createWebviewPanel(CHAT_VIEW_TYPE, title, column, {
      enableScripts: true,
      retainContextWhenHidden: true,
    });
    const created = new ChatPanel(panel, sessionId, connection, workspaceRoot, log);
    // Lock only the group we just created; a reused one is already locked.
    if (!reused) void ChatPanel.lockOwnGroup();
    return created;
  }

  /** Rebuilds a panel VS Code restored after a window reload. */
  static async restore(
    panel: vscode.WebviewPanel,
    state: PanelState | undefined,
    connection: AcpConnection,
    workspaceRoot: string,
    log: (line: string) => void,
  ): Promise<void> {
    const sessionId = state?.sessionId;
    if (typeof sessionId !== 'string' || sessionId === '') {
      panel.dispose();
      return;
    }
    if (ChatPanel.open.has(sessionId)) {
      // Already restored by another path; drop the duplicate rather than double-bind.
      panel.dispose();
      return;
    }
    try {
      await connection.resume(sessionId);
    } catch (err) {
      log(`[panel] could not resume ${sessionId} on restore: ${String(err)}`);
      panel.webview.options = { enableScripts: true };
      panel.webview.html = chatHtml(randomBytes(16).toString('base64'));
      // The page has not loaded yet, so a postMessage now would be dropped. Wait
      // for the page's own 'ready' signal and hand the error to the user then.
      const notice = {
        type: 'notice',
        text: `This session could not be resumed: ${String(err)}`,
        tone: 'error',
      } satisfies PanelOutbound;
      const sub = panel.webview.onDidReceiveMessage((msg: PanelInbound) => {
        if (msg?.type !== 'ready') return;
        sub.dispose();
        postSafe(panel.webview, notice);
      });
      panel.onDidDispose(() => sub.dispose());
      return;
    }
    const restored = new ChatPanel(panel, sessionId, connection, workspaceRoot, log);
    void restored.replayHistory();
    // The reloaded tab may carry a generic title; name it from the log if it can.
    void restored.refreshTitle();
  }

  private post(msg: PanelOutbound): void {
    if (this.disposed) return;
    if (!this.ready) {
      this.pendingOutbound.push(msg);
      return;
    }
    postSafe(this.panel.webview, msg);
  }

  /** Queues one coalesced render cycle; repeated calls within the window collapse. */
  private scheduleStreamFlush(): void {
    if (this.streamTimer !== null) return;
    this.streamTimer = setTimeout(() => {
      this.streamTimer = null;
      this.flushStream();
    }, STREAM_FLUSH_MS);
  }

  /** Renders and posts the latest accumulated text of every dirty message. */
  private flushStream(): void {
    if (this.streamTimer !== null) {
      clearTimeout(this.streamTimer);
      this.streamTimer = null;
    }
    const dirty = [...this.streamDirty];
    this.streamDirty.clear();
    for (const [key, { role, messageId }] of dirty) {
      const full = this.streamText.get(key);
      if (full === undefined) continue;
      const blocks = this.render(full);
      this.post({
        type: 'message',
        role,
        messageId,
        blocks,
        preview: role === 'thought' ? previewOf(blocks) : '',
      });
    }
  }

  /** Drops any pending coalesced render (turn ended / panel gone). */
  private cancelStreamFlush(): void {
    if (this.streamTimer !== null) {
      clearTimeout(this.streamTimer);
      this.streamTimer = null;
    }
    this.streamDirty.clear();
  }

  /**
   * Existence check with a short TTL.
   *
   * Decoration stats every file reference, and during a streaming turn the same
   * references are re-rendered many times a second; syscalls for them are wasted.
   * Files can still appear mid-turn (the agent writes then cites), so answers are
   * trusted for only a second and the cache is size-capped.
   */
  private readonly existsCache = new Map<string, { hit: boolean; at: number }>();

  private fileExists(p: string): boolean {
    const now = Date.now();
    const hit = this.existsCache.get(p);
    if (hit !== undefined && now - hit.at < EXISTS_TTL_MS) return hit.hit;
    if (this.existsCache.size >= EXISTS_CACHE_MAX) {
      // Evict the oldest entry (Map iteration order is insertion order).
      const oldest = this.existsCache.keys().next().value;
      if (oldest !== undefined) this.existsCache.delete(oldest);
    }
    const v = existsSync(p);
    this.existsCache.set(p, { hit: v, at: now });
    return v;
  }

  /**
   * A path is offered as clickable only when it resolves inside the workspace and
   * exists, so no row or span is a link that refuses on click.
   */
  private clickablePath(raw: string | undefined): { path: string; line?: number } | null {
    if (!raw) return null;
    const ref = parseFileRef(raw);
    if (!ref) return null;
    const deps = { workspaceRoot: this.workspaceRoot, exists: (p: string) => this.fileExists(p) };
    if (resolveInWorkspace(ref.path, deps) === null) return null;
    return { path: ref.path, ...(ref.line === undefined ? {} : { line: ref.line }) };
  }

  private render(text: string): Block[] {
    return decorateFileRefs(parseMarkdown(text), {
      workspaceRoot: this.workspaceRoot,
      exists: (p: string) => this.fileExists(p),
    });
  }

  private async onMessage(msg: PanelInbound): Promise<void> {
    switch (msg.type) {
      case 'ready': {
        // The webview persists { sessionId } so a reload can rebind this same session.
        if (!this.ready) {
          // Flush everything posted while the page was still loading (history,
          // notices, early stream chunks): those posts are dropped by VS Code.
          this.ready = true;
          const pending = this.pendingOutbound.splice(0);
          for (const m of pending) postSafe(this.panel.webview, m);
        }
        postSafe(this.panel.webview, { type: 'restoreState', state: { sessionId: this.sessionId } });
        // Re-scan on open so a skill added since the window started shows up.
        this.skillsCache = null;
        this.pushState();
        break;
      }
      case 'send':
        await this.send(msg.text);
        break;
      case 'cancel':
        this.connection.cancel(this.sessionId);
        break;
      case 'openPath':
        await this.openPath(msg.path, msg.line, msg.endLine);
        break;
      case 'openExternal':
        await ChatPanel.openExternal(msg.url);
        break;
      case 'setOption':
        await this.setOption(msg.id, msg.value);
        break;
      case 'newSession':
        await vscode.commands.executeCommand('dshAgent.newSession');
        break;
      case 'showSessions':
        await this.sendSessionList();
        break;
      case 'openSession':
        await vscode.commands.executeCommand('dshAgent.openSession', msg.id);
        break;
    }
  }

  /**
   * Opens a link from rendered Markdown.
   *
   * The parser already rejects anything but http(s); this re-checks before handing a
   * URL to the OS, because that is the boundary where getting it wrong matters.
   */
  private static async openExternal(url: string): Promise<void> {
    if (typeof url !== 'string' || !/^https?:\/\//i.test(url)) return;
    await vscode.env.openExternal(vscode.Uri.parse(url));
  }

  /**
   * Opens a file the agent touched, confined to the workspace: the path comes from
   * agent output, so an absolute path pointing outside the project is refused.
   */
  private async openPath(raw: string, line?: number, endLine?: number): Promise<void> {
    if (typeof raw !== 'string' || raw === '') return;
    const abs = path.resolve(this.workspaceRoot, raw);
    const rel = path.relative(this.workspaceRoot, abs);
    if (rel.startsWith('..') || path.isAbsolute(rel)) {
      void vscode.window.showWarningMessage(`DSH: refused to open a path outside the workspace: ${raw}`);
      return;
    }
    try {
      // Column One, not Beside: the chat usually sits in the right-hand column, so
      // "beside" would stack code on top of it instead of next to it.
      const editor = await vscode.window.showTextDocument(vscode.Uri.file(abs), {
        preview: true,
        viewColumn: vscode.ViewColumn.One,
      });
      if (typeof line !== 'number' || line < 1) return;
      // Clamp to the document: a reference can outlive the edit that shortened the file.
      const last = editor.document.lineCount - 1;
      const start = new vscode.Position(Math.min(line - 1, last), 0);
      const endNo = typeof endLine === 'number' && endLine >= line ? endLine : line;
      const end = editor.document.lineAt(Math.min(endNo - 1, last)).range.end;
      const target = new vscode.Range(start, end);
      editor.revealRange(target, vscode.TextEditorRevealType.InCenterIfOutsideViewport);
      // Select the referenced range so a cited span is visible, not just scrolled to.
      editor.selection = new vscode.Selection(start, endNo === line ? start : end);
    } catch (err) {
      void vscode.window.showWarningMessage(`DSH: cannot open ${rel}: ${String(err)}`);
    }
  }

  /**
   * Restores this session's transcript from dsh's on-disk log.
   *
   * Best effort by construction: ACP replays nothing on resume and the log is an
   * internal format with no compatibility promise, so every failure is logged and
   * the panel simply stays empty. Never awaited by a session path.
   */
  async replayHistory(): Promise<void> {
    const cfg = vscode.workspace.getConfiguration('dshAgent');
    if (!cfg.get<boolean>('replayHistory', true)) {
      this.log('[history] disabled by dshAgent.replayHistory');
      return;
    }
    let result: Awaited<ReturnType<typeof loadTranscript>>;
    try {
      result = await loadTranscript({
        dshHome: dshHome(),
        sessionId: this.sessionId,
        cwd: this.workspaceRoot,
        maxEntries: cfg.get<number>('replayMaxEntries', 200),
      });
    } catch (err) {
      this.log(`[history] unexpected failure, continuing without history: ${String(err)}`);
      return;
    }
    if (!result.ok) {
      this.log(`[history] not restored: ${result.reason}`);
      return;
    }
    this.log(
      `[history] restored ${result.entries.length} entries from ${result.scanned} records` +
        `${result.truncated ? ' (older ones omitted)' : ''}`,
    );
    // Restore the context ring before the transcript, so a resumed session shows how
    // much room is left without having to send a message first.
    if (result.usage) this.post({ type: 'usage', used: result.usage.used, size: result.usage.size });
    this.post({
      type: 'history',
      entries: result.entries.map((e) => {
        if (e.kind === 'user') return { kind: 'user' as const, blocks: this.render(e.text) };
        if (e.kind === 'assistant') {
          const reasoning = e.reasoning ? this.render(e.reasoning) : [];
          return {
            kind: 'assistant' as const,
            blocks: this.render(e.text),
            reasoning,
            preview: previewOf(reasoning),
          };
        }
        // Restored tool rows are clickable on the same terms as live ones.
        const clickable = this.clickablePath(e.path);
        return { ...e, path: undefined, line: undefined, ...(clickable ?? {}) };
      }),
      truncated: result.truncated,
    });
  }

  /** ACP session/update → panel messages. */
  private onUpdate(u: SessionUpdate): void {
    switch (u.sessionUpdate) {
      case 'agent_message_chunk':
      case 'agent_thought_chunk': {
        const chunk = u as { messageId?: string; content?: { text?: string } };
        const text = chunk.content?.text;
        if (typeof text !== 'string' || text === '') return;
        const isThought = u.sessionUpdate === 'agent_thought_chunk';
        if (isThought && !vscode.workspace.getConfiguration('dshAgent').get<boolean>('showThoughts', true)) return;
        const role = isThought ? 'thought' : 'assistant';
        // Thoughts and the answer can share a messageId, so the role is part of the key.
        const messageId = chunk.messageId ?? 'anon';
        const key = `${role}:${messageId}`;
        // Accumulate immediately (deltas must never be lost), but defer parsing and
        // posting: consecutive chunks coalesce into one render cycle per message.
        this.streamText.set(key, (this.streamText.get(key) ?? '') + text);
        this.streamDirty.set(key, { role, messageId });
        this.scheduleStreamFlush();
        return;
      }
      case 'tool_call': {
        const t = u as { toolCallId: string; title?: string; status?: string; rawInput?: Record<string, unknown> };
        const title = t.title ?? 'tool';
        this.toolTitles.set(t.toolCallId, title);
        const clickable = this.clickablePath(pathFromInput(t.rawInput));
        this.post({
          type: 'tool',
          id: t.toolCallId,
          title,
          status: t.status ?? 'pending',
          detail: summariseInput(t.rawInput, this.workspaceRoot),
          ...(clickable ?? {}),
        });
        return;
      }
      case 'tool_call_update': {
        const t = u as { toolCallId: string; status?: string; content?: ToolCallContent[] };
        this.post({
          type: 'tool',
          id: t.toolCallId,
          title: this.toolTitles.get(t.toolCallId) ?? 'tool',
          status: t.status ?? 'completed',
          detail: flattenToolContent(t.content),
        });
        return;
      }
      case 'usage_update': {
        const usage = u as { used?: number; size?: number };
        if (typeof usage.used === 'number' && typeof usage.size === 'number' && usage.size > 0) {
          this.post({ type: 'usage', used: usage.used, size: usage.size });
        }
        return;
      }
      case 'config_option_update':
        this.pushState();
        return;
      default:
        this.log(`[acp] unhandled session/update: ${u.sessionUpdate}`);
    }
  }

  /**
   * Skills the agent can use, read from disk.
   *
   * ACP exposes no skill surface, but they are Markdown files in documented roots,
   * so the catalog is rebuilt independently — verified to match the list dsh itself
   * splices into a session. Cached per panel: the roots are watched by dsh, not by
   * us, and re-scanning on every state push would be wasteful.
   */
  private skillsCache: Skill[] | null = null;

  private skills(): Skill[] {
    if (this.skillsCache === null) {
      try {
        this.skillsCache = loadSkills(this.workspaceRoot);
      } catch (err) {
        this.log(`[skills] scan failed: ${String(err)}`);
        this.skillsCache = [];
      }
    }
    return this.skillsCache;
  }

  /**
   * The skills the composer's slash menu offers.
   *
   * Descriptions are trimmed here rather than in the webview: the menu shows one
   * line per skill, and shipping a 700-character description to render 60 of them
   * is waste on every state push.
   */
  private skillViews(): SkillView[] {
    return this.skills()
      .filter((s) => s.userInvocable)
      .map((s) => ({
        name: s.name,
        description: s.description.length > 140 ? `${s.description.slice(0, 140)}…` : s.description,
      }));
  }

  private pushState(): void {
    this.post({
      type: 'state',
      busy: this.connection.busy(this.sessionId),
      sessionId: this.sessionId,
      // Everything the agent advertises — model and reasoning effort today — so the
      // composer renders whatever this build exposes rather than a hardcoded list.
      options: this.connection.configOptions(this.sessionId).map(flattenOption),
      skills: this.skillViews(),
      title: this.panel.title,
    });
  }

  /** Sends one prompt and drives the busy state around the turn. */
  async send(text: string): Promise<void> {
    if (typeof text !== 'string' || text.trim() === '') return;
    // The composer disables Send while its own turn runs, but a command-driven send
    // (dshAgent.sendSelection, a keybinding) can arrive while this session's turn is
    // still in flight. Prompting anyway would throw "already in flight" and push a
    // second round of busy state for the same turn; refuse up front instead, give
    // the text back, and let the webview snap to the real busy state (the turn that
    // is actually running keeps its spinner — the indicator must never be cleared
    // or double-set by a send nobody started).
    if (this.connection.busy(this.sessionId)) {
      // The text returns to the composer only when it is empty (a composer send
      // clears it first); a Send Selection keeps its text selected in the editor.
      this.post({ type: 'restoreInput', text });
      this.pushState();
      this.panel.reveal();
      this.post({ type: 'notice', text: 'The agent is still working — send again when the current turn finishes.', tone: 'info' });
      return;
    }
    // A tab created by "+" carries a placeholder label until its first message
    // names it. dsh derives the title from the first prompt and writes it to the
    // log, but naming the tab right here — from the same text, no disk round-trip —
    // is instant and cannot race that write. The log-based refresh after the turn
    // then re-reads the same title and is a no-op.
    if (this.panel.title === NEW_SESSION_TITLE) {
      const oneLine = text.replace(/\s+/g, ' ').trim();
      if (oneLine !== '') this.setTitle(`DSH · ${oneLine.slice(0, 40)}`);
    }
    // Rendered as Markdown too: sendSelection wraps the selection in a code fence.
    this.post({ type: 'user', blocks: this.render(text) });
    this.post({
      // Same shape as pushState, just busy: keep the option dropdowns (model,
      // reasoning effort) on screen while the turn runs — the webview greys them
      // out — instead of wiping them, which made them vanish during reasoning.
      type: 'state', busy: true, sessionId: this.sessionId,
      options: this.connection.configOptions(this.sessionId).map(flattenOption),
      skills: this.skillViews(), title: this.panel.title,
    });
    ChatPanel.syncBusyContext();
    try {
      const res = await this.connection.prompt(this.sessionId, text);
      // A finished turn will never extend its messages again: flush any chunk still
      // sitting in the coalescing window, then drop the buffers so a long session
      // does not accumulate every message it ever streamed.
      this.flushStream();
      this.streamText.clear();
      this.toolTitles.clear();
      this.post({ type: 'turnEnd', stopReason: res.stopReason });
      // A session is titled from its first message, so the cached title is now stale.
      ChatPanel.catalog?.invalidate(this.sessionId);
      ChatPanel.changeEmitter.fire(); // A title may exist now that a turn completed.
      void this.refreshTitle();       // …and so may a proper tab label ("DSH · …").
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.post({ type: 'notice', text: `Turn failed: ${message}`, tone: 'error' });
      // Errors the client detects before the request is written (agent stopped,
      // session busy) mean the agent never saw this message: give the text back so
      // the user can retry instead of watching a bubble that was never delivered.
      if (message.includes('not running') || message.includes('already in flight')) {
        this.post({ type: 'restoreInput', text });
      }
    } finally {
      this.pushState();
      ChatPanel.syncBusyContext();
    }
  }

  /**
   * Sends the session list for the panel's inline History popup.
   *
   * Kept in the panel rather than focusing the sidebar view: switching conversation
   * should not move the user to another part of the window.
   */
  private async sendSessionList(): Promise<void> {
    const catalog = ChatPanel.catalog;
    if (!catalog) return;
    let rows;
    try {
      rows = await catalog.rows(this.connection, ChatPanel.openSessionIds(), this.sessionId);
    } catch (err) {
      this.log(`[sessions] inline list failed: ${String(err)}`);
      return;
    }
    this.post({ type: 'sessionList', items: rows });
  }

  /** Applies a composer dropdown change to this session. */
  private async setOption(id: string, value: string): Promise<void> {
    if (typeof id !== 'string' || typeof value !== 'string') return;
    try {
      await this.connection.setConfigOption(this.sessionId, id, value);
    } catch (err) {
      this.log(`[acp] set ${id} failed: ${String(err)}`);
      this.post({ type: 'notice', text: `Could not change ${id}: ${String(err)}`, tone: 'error' });
    }
    // Re-push either way: on failure the dropdown must snap back to the real value.
    this.pushState();
  }

  /** Lets the user pick a model for this session. */
  async pickModel(): Promise<void> {
    const option = this.connection.configOptions(this.sessionId).find((o) => o.id === 'model');
    if (!option) {
      void vscode.window.showInformationMessage('DSH: the agent advertises no model option.');
      return;
    }
    const flat = flattenOption(option);
    const picked = await vscode.window.showQuickPick(
      flat.choices.map((c) => ({
        label: `${c.value === flat.current ? '$(check) ' : ''}${c.label}`,
        value: c.value,
      })),
      { placeHolder: 'Select a model' },
    );
    if (!picked) return;
    await this.setOption('model', picked.value);
  }

  /** Reports that the agent process died. */
  notifyAgentExit(): void {
    this.post({ type: 'notice', text: 'The dsh agent exited. Reopen this session to restart it.', tone: 'error' });
  }

  /**
   * Tab closed: release the session agent-side so it becomes inactive and therefore
   * resumable — an active session never appears in session/list.
   */
  private async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    ChatPanel.open.delete(this.sessionId);
    ChatPanel.syncBusyContext();
    this.cancelStreamFlush();
    this.pendingOutbound.length = 0;
    this.unsubscribe?.();
    this.unsubscribe = null;
    for (const d of this.disposables) d.dispose();
    this.disposables.length = 0;
    await this.connection.closeSession(this.sessionId);
    ChatPanel.changeEmitter.fire();
  }

  /** Closes every open tab (extension shutdown). */
  static disposeAll(): void {
    for (const p of [...ChatPanel.open.values()]) p.panel.dispose();
  }

  static notifyAllAgentExit(): void {
    for (const p of ChatPanel.open.values()) p.notifyAgentExit();
  }
}
