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
import { loadTranscript } from '../history/store';
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

/** Flattens tool result content, which nests one level: { type, content: { text } }. */
function flattenToolContent(content: ToolCallContent[] | undefined): string {
  if (!Array.isArray(content)) return '';
  return content
    .map((c) => (c.content && typeof c.content.text === 'string' ? c.content.text : ''))
    .filter(Boolean)
    .join('\n');
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
   * fence or bold run is not yet valid. So the full text is kept, reparsed on each
   * chunk, and the tree replaces the rendered node. Messages are small enough that
   * reparsing costs nothing, and it makes partial syntax correct itself as it lands.
   */
  private readonly streamText = new Map<string, string>();
  private disposed = false;

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
    this.panel.reveal(column);
  }

  /** Sets the tab label. Titles arrive late, so this is called again after turn one. */
  setTitle(title: string): void {
    this.panel.title = title;
    this.pushState();
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
      void panel.webview.postMessage({
        type: 'notice',
        text: `This session could not be resumed: ${String(err)}`,
        tone: 'error',
      } satisfies PanelOutbound);
      return;
    }
    const restored = new ChatPanel(panel, sessionId, connection, workspaceRoot, log);
    void restored.replayHistory();
  }

  private post(msg: PanelOutbound): void {
    if (this.disposed) return;
    void this.panel.webview.postMessage(msg);
  }

  /**
   * Parses Markdown and decorates the file references in it.
   *
   * Every rendered message goes through here so a path is clickable wherever it
   * appears — a streaming answer, a restored transcript, or the user's own message.
   */
  /**
   * A path is offered as clickable only when it resolves inside the workspace and
   * exists, so no row or span is a link that refuses on click.
   */
  private clickablePath(raw: string | undefined): { path: string; line?: number } | null {
    if (!raw) return null;
    const ref = parseFileRef(raw);
    if (!ref) return null;
    const deps = { workspaceRoot: this.workspaceRoot, exists: (p: string) => existsSync(p) };
    if (resolveInWorkspace(ref.path, deps) === null) return null;
    return { path: ref.path, ...(ref.line === undefined ? {} : { line: ref.line }) };
  }

  private render(text: string): Block[] {
    return decorateFileRefs(parseMarkdown(text), {
      workspaceRoot: this.workspaceRoot,
      exists: (p) => existsSync(p),
    });
  }

  private async onMessage(msg: PanelInbound): Promise<void> {
    switch (msg.type) {
      case 'ready':
        // The webview persists { sessionId } so a reload can rebind this same session.
        void this.panel.webview.postMessage({ type: 'restoreState', state: { sessionId: this.sessionId } });
        // Re-scan on open so a skill added since the window started shows up.
        this.skillsCache = null;
        this.pushState();
        break;
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
        const key = `${role}:${chunk.messageId ?? 'anon'}`;
        const full = (this.streamText.get(key) ?? '') + text;
        this.streamText.set(key, full);
        const blocks = this.render(full);
        this.post({
          type: 'message',
          role,
          messageId: chunk.messageId ?? 'anon',
          blocks,
          preview: isThought ? previewOf(blocks) : '',
        });
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
          detail: flattenToolContent(t.content).replace(/\s+/g, ' ').trim().slice(0, 120),
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
    // Rendered as Markdown too: sendSelection wraps the selection in a code fence.
    this.post({ type: 'user', blocks: this.render(text) });
    this.post({
      type: 'state', busy: true, sessionId: this.sessionId,
      options: [], skills: this.skillViews(), title: this.panel.title,
    });
    ChatPanel.syncBusyContext();
    try {
      const res = await this.connection.prompt(this.sessionId, text);
      // A finished turn will never extend its messages again; drop the buffers so a
      // long session does not accumulate every message it ever streamed.
      this.streamText.clear();
      this.post({ type: 'turnEnd', stopReason: res.stopReason });
      // A session is titled from its first message, so the cached title is now stale.
      ChatPanel.catalog?.invalidate(this.sessionId);
      ChatPanel.changeEmitter.fire(); // A title may exist now that a turn completed.
    } catch (err) {
      this.post({ type: 'notice', text: `Turn failed: ${String(err)}`, tone: 'error' });
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
