// src/panel/chatPanel.ts — one editor tab per ACP session.
//
// Each session is a real WebviewPanel, so closing, dragging, splitting, Ctrl+Tab and
// tab groups are VS Code's behaviour rather than something reimplemented in a webview.
// Panels are registered by sessionId so a second request reveals the existing tab.
import { randomBytes } from 'node:crypto';
import { homedir } from 'node:os';
import * as path from 'node:path';
import * as vscode from 'vscode';
import type { AcpConnection } from '../acp/connection';
import type { ConfigOption, SessionUpdate, ToolCallContent } from '../acp/types';
import { loadTranscript } from '../history/store';
import { chatHtml, type PanelInbound, type PanelOutbound } from './html';

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

/** Flattens tool result content, which nests one level: { type, content: { text } }. */
function flattenToolContent(content: ToolCallContent[] | undefined): string {
  if (!Array.isArray(content)) return '';
  return content
    .map((c) => (c.content && typeof c.content.text === 'string' ? c.content.text : ''))
    .filter(Boolean)
    .join('\n');
}

function currentChoiceName(option: ConfigOption | undefined): string | null {
  if (!option) return null;
  const walk = (choices: ConfigOption['options']): string | null => {
    for (const c of choices ?? []) {
      if (c.value !== undefined && c.value === option.currentValue) return c.name ?? c.value;
      const nested = walk(c.options);
      if (nested) return nested;
    }
    return null;
  };
  return walk(option.options) ?? option.currentValue ?? null;
}

/** State persisted with the tab so a window reload can rebind the same session. */
interface PanelState {
  sessionId: string;
}

export const CHAT_VIEW_TYPE = 'dshAgent.chatPanel';

export class ChatPanel {
  /** Open panels by sessionId — the source of truth for "is this session open". */
  private static readonly open = new Map<string, ChatPanel>();
  /** Notified whenever the set of open panels or the active one changes. */
  private static readonly changeEmitter = new vscode.EventEmitter<void>();
  static readonly onDidChangeOpen = ChatPanel.changeEmitter.event;

  private readonly disposables: vscode.Disposable[] = [];
  private unsubscribe: (() => void) | null = null;
  private readonly toolTitles = new Map<string, string>();
  private disposed = false;

  private constructor(
    private readonly panel: vscode.WebviewPanel,
    private readonly sessionId: string,
    private readonly connection: AcpConnection,
    private readonly workspaceRoot: string,
    private readonly log: (line: string) => void,
  ) {
    ChatPanel.open.set(sessionId, this);

    panel.webview.options = { enableScripts: true };
    panel.webview.html = chatHtml(randomBytes(16).toString('base64'));
    this.disposables.push(
      panel.webview.onDidReceiveMessage((msg: PanelInbound) => void this.onMessage(msg)),
      panel.onDidChangeViewState(() => ChatPanel.changeEmitter.fire()),
      panel.onDidDispose(() => void this.dispose()),
    );

    this.unsubscribe = connection.subscribe(sessionId, (u) => this.onUpdate(u));
    ChatPanel.changeEmitter.fire();
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
    column: vscode.ViewColumn = vscode.ViewColumn.Active,
  ): ChatPanel {
    const panel = vscode.window.createWebviewPanel(CHAT_VIEW_TYPE, title, column, {
      enableScripts: true,
      retainContextWhenHidden: true,
    });
    return new ChatPanel(panel, sessionId, connection, workspaceRoot, log);
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

  private async onMessage(msg: PanelInbound): Promise<void> {
    switch (msg.type) {
      case 'ready':
        // The webview persists { sessionId } so a reload can rebind this same session.
        void this.panel.webview.postMessage({ type: 'restoreState', state: { sessionId: this.sessionId } });
        this.pushState();
        break;
      case 'send':
        await this.send(msg.text);
        break;
      case 'cancel':
        this.connection.cancel(this.sessionId);
        break;
      case 'openPath':
        await this.openPath(msg.path);
        break;
    }
  }

  /**
   * Opens a file the agent touched, confined to the workspace: the path comes from
   * agent output, so an absolute path pointing outside the project is refused.
   */
  private async openPath(raw: string): Promise<void> {
    if (typeof raw !== 'string' || raw === '') return;
    const abs = path.resolve(this.workspaceRoot, raw);
    const rel = path.relative(this.workspaceRoot, abs);
    if (rel.startsWith('..') || path.isAbsolute(rel)) {
      void vscode.window.showWarningMessage(`DSH: refused to open a path outside the workspace: ${raw}`);
      return;
    }
    try {
      await vscode.window.showTextDocument(vscode.Uri.file(abs), {
        preview: true,
        viewColumn: vscode.ViewColumn.Beside,
      });
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
        dshHome: process.env.DSH_HOME ?? path.join(homedir(), '.dsh'),
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
    this.post({ type: 'history', entries: result.entries, truncated: result.truncated });
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
        this.post({
          type: 'chunk',
          role: isThought ? 'thought' : 'assistant',
          messageId: chunk.messageId ?? 'anon',
          text,
        });
        return;
      }
      case 'tool_call': {
        const t = u as { toolCallId: string; title?: string; status?: string; rawInput?: Record<string, unknown> };
        const title = t.title ?? 'tool';
        this.toolTitles.set(t.toolCallId, title);
        const filePath = pathFromInput(t.rawInput);
        this.post({
          type: 'tool',
          id: t.toolCallId,
          title,
          status: t.status ?? 'pending',
          detail: summariseInput(t.rawInput, this.workspaceRoot),
          ...(filePath ? { path: filePath } : {}),
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

  private pushState(): void {
    const model = this.connection.configOptions(this.sessionId).find((o) => o.id === 'model');
    this.post({
      type: 'state',
      busy: this.connection.busy(this.sessionId),
      sessionId: this.sessionId,
      model: currentChoiceName(model),
    });
  }

  /** Sends one prompt and drives the busy state around the turn. */
  async send(text: string): Promise<void> {
    if (typeof text !== 'string' || text.trim() === '') return;
    this.post({ type: 'user', text });
    this.post({ type: 'state', busy: true, sessionId: this.sessionId, model: null });
    try {
      const res = await this.connection.prompt(this.sessionId, text);
      this.post({ type: 'turnEnd', stopReason: res.stopReason });
      ChatPanel.changeEmitter.fire(); // A title may exist now that a turn completed.
    } catch (err) {
      this.post({ type: 'notice', text: `Turn failed: ${String(err)}`, tone: 'error' });
    } finally {
      this.pushState();
    }
  }

  /** Lets the user pick a model for this session. */
  async pickModel(): Promise<void> {
    const option = this.connection.configOptions(this.sessionId).find((o) => o.id === 'model');
    if (!option) {
      void vscode.window.showInformationMessage('DSH: the agent advertises no model option.');
      return;
    }
    const items: { label: string; description: string; value: string }[] = [];
    const walk = (choices: ConfigOption['options'], group: string): void => {
      for (const c of choices ?? []) {
        if (c.value !== undefined) {
          items.push({
            label: `${c.value === option.currentValue ? '$(check) ' : ''}${c.name ?? c.value}`,
            description: c.description ?? group,
            value: c.value,
          });
        }
        walk(c.options, c.group ?? group);
      }
    };
    walk(option.options, '');
    const picked = await vscode.window.showQuickPick(items, { placeHolder: 'Select a model' });
    if (!picked) return;
    await this.connection.setConfigOption(this.sessionId, 'model', picked.value);
    this.pushState();
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
