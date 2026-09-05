// src/panel/provider.ts — binds the ACP session to the chat webview.
//
// Translation layer only: ACP session/update shapes in, PanelOutbound messages out.
// Nothing here talks JSON-RPC directly; nothing in acp/ knows about vscode.
import { randomBytes } from 'node:crypto';
import { homedir } from 'node:os';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { loadSessionMeta, loadTranscript, type SessionMeta } from '../history/store';
import { AgentSession } from '../acp/session';
import type { ConfigOption, SessionUpdate, ToolCallContent } from '../acp/types';
import { chatHtml, type PanelInbound, type PanelOutbound } from './html';

/** Tool arguments that name a file, in the order we prefer them. */
const PATH_KEYS = ['file_path', 'path', 'filePath', 'notebook_path'];

/** Pulls the most likely file path out of a tool's rawInput, if any. */
function pathFromInput(input: Record<string, unknown> | undefined): string | undefined {
  if (!input) return undefined;
  for (const key of PATH_KEYS) {
    const v = input[key];
    if (typeof v === 'string' && v !== '') return v;
  }
  return undefined;
}

/** One-line summary of a tool invocation for the panel row. */
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

/** Compact relative time for the session switcher ("3m ago", "2d ago"). */
function relativeTime(ms: number | null): string {
  if (ms === null) return '';
  const secs = Math.max(0, Math.round((Date.now() - ms) / 1000));
  if (secs < 60) return 'just now';
  const mins = Math.round(secs / 60);
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

/** Reads the human-readable name of the currently selected value of a config option. */
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

export class ChatViewProvider implements vscode.WebviewViewProvider {
  private view: vscode.WebviewView | null = null;
  private session: AgentSession | null = null;
  private starting: Promise<void> | null = null;
  /** Tool title by id, so a tool_call_update can keep the row's label. */
  private readonly toolTitles = new Map<string, string>();

  constructor(
    private readonly workspaceRoot: string,
    private readonly log: (line: string) => void,
  ) {}

  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;
    view.webview.options = { enableScripts: true };
    view.webview.html = chatHtml(randomBytes(16).toString('base64'));
    view.webview.onDidReceiveMessage((msg: PanelInbound) => void this.onMessage(msg));
    view.onDidDispose(() => {
      this.view = null;
    });
  }

  /** Posts to the panel; a hidden or disposed view simply drops the message. */
  private post(msg: PanelOutbound): void {
    void this.view?.webview.postMessage(msg);
  }

  private async onMessage(msg: PanelInbound): Promise<void> {
    switch (msg.type) {
      case 'ready':
        await this.ensureSession();
        break;
      case 'send':
        await this.send(msg.text);
        break;
      case 'cancel':
        this.session?.cancel();
        break;
      case 'openPath':
        await this.openPath(msg.path);
        break;
      case 'switchSession':
        await this.switchTo(msg.id);
        break;
      case 'newSession':
        await this.newSession();
        break;
    }
  }

  /**
   * Opens a file the agent touched.
   *
   * Confined to the workspace: the path comes from agent output, so an absolute
   * path pointing outside the project is refused rather than opened. This is the
   * one place untrusted content reaches a filesystem API.
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
      await vscode.window.showTextDocument(vscode.Uri.file(abs), { preview: true });
    } catch (err) {
      void vscode.window.showWarningMessage(`DSH: cannot open ${rel}: ${String(err)}`);
    }
  }

  /** Boots the agent on first use; concurrent callers share one attempt. */
  private ensureSession(): Promise<void> {
    if (this.session) {
      this.pushState();
      return Promise.resolve();
    }
    if (this.starting) return this.starting;
    this.starting = this.startSession().finally(() => {
      this.starting = null;
    });
    return this.starting;
  }

  private async startSession(): Promise<void> {
    const cfg = vscode.workspace.getConfiguration('dshAgent');
    const session = new AgentSession({
      command: cfg.get<string>('executablePath', 'dsh'),
      profile: cfg.get<string>('profile', 'acp'),
      cwd: this.workspaceRoot,
      resumeLatest: cfg.get<boolean>('resumeLatestSession', true),
      log: this.log,
      onUpdate: (u) => this.onUpdate(u),
      onExit: () => {
        this.session = null;
        this.post({ type: 'notice', text: 'The dsh agent exited. Send a message to restart it.', tone: 'error' });
        this.pushState();
      },
      onPermission: (params) => this.askPermission(params),
    });
    this.post({ type: 'notice', text: 'Starting the dsh agent…', tone: 'info' });
    try {
      await session.start();
    } catch (err) {
      this.log(`[acp] start failed: ${String(err)}`);
      this.post({
        type: 'notice',
        text: `Could not start the agent: ${String(err)}. Check that "dsh" is on PATH or set dshAgent.executablePath.`,
        tone: 'error',
      });
      return;
    }
    this.session = session;
    this.post({
      type: 'notice',
      text: `Connected to ${session.agentName}. Session ${session.id?.slice(0, 8)}…`,
      tone: 'info',
    });
    // Fire-and-forget: history must never delay or block the session becoming usable.
    if (session.resumed) void this.replayHistory(session.id);
    void this.pushSessions();
    this.pushState();
  }

  /**
   * Restores a resumed session's transcript from disk.
   *
   * Strictly best-effort and strictly optional: ACP replays no history, and dsh's
   * on-disk log is an internal format with no compatibility promise. Every failure
   * is logged and swallowed — the panel just stays empty and chat is unaffected.
   * It never throws and is never awaited by the session path.
   */
  private async replayHistory(sessionId: string | null): Promise<void> {
    if (sessionId === null) return;
    const cfg = vscode.workspace.getConfiguration('dshAgent');
    if (!cfg.get<boolean>('replayHistory', true)) {
      this.log('[history] disabled by dshAgent.replayHistory');
      return;
    }
    let result: Awaited<ReturnType<typeof loadTranscript>>;
    try {
      result = await loadTranscript({
        dshHome: process.env.DSH_HOME ?? path.join(homedir(), '.dsh'),
        sessionId,
        cwd: this.workspaceRoot,
        maxEntries: cfg.get<number>('replayMaxEntries', 200),
      });
    } catch (err) {
      // loadTranscript is written not to throw; this guard means a future format
      // change can never take the panel down with it.
      this.log(`[history] unexpected failure, continuing without history: ${String(err)}`);
      return;
    }
    if (!result.ok) {
      this.log(`[history] not restored: ${result.reason}`);
      this.post({
        type: 'notice',
        text: 'Resumed this session. Its earlier messages could not be restored — see DSH: Show Logs.',
        tone: 'info',
      });
      return;
    }
    this.log(
      `[history] restored ${result.entries.length} entries from ${result.scanned} records` +
        `${result.truncated ? ' (older ones omitted)' : ''}`,
    );
    this.post({ type: 'history', entries: result.entries, truncated: result.truncated });
  }

  /**
   * Permission prompt (agent → client).
   *
   * Note: the shipped acp profile auto-approves tool use, so this was never
   * observed to fire in practice. It is implemented because the policy layer is
   * patchable — but it is not a safety guarantee. See README.
   */
  private async askPermission(params: unknown): Promise<string | null> {
    const p = params as { toolCall?: { title?: string }; options?: { optionId: string; name?: string }[] };
    const options = p.options ?? [];
    if (options.length === 0) return null;
    const labels = options.map((o) => o.name ?? o.optionId);
    const picked = await vscode.window.showWarningMessage(
      `DSH agent wants to run: ${p.toolCall?.title ?? 'a tool'}`,
      { modal: true },
      ...labels,
    );
    if (picked === undefined) return null;
    return options[labels.indexOf(picked)]?.optionId ?? null;
  }

  /**
   * Session metadata cache, keyed by id.
   *
   * Each miss costs a file read plus a bounded zstd decode (~2 ms). Titles never
   * change once written — dsh titles a session from its first user message — so a
   * hit is safe to reuse for the life of the window.
   */
  private readonly metaCache = new Map<string, SessionMeta>();

  private dshHome(): string {
    return process.env.DSH_HOME ?? path.join(homedir(), '.dsh');
  }

  /** Metadata for one session, cached. Never throws. */
  private async metaFor(sessionId: string): Promise<SessionMeta> {
    const hit = this.metaCache.get(sessionId);
    if (hit && hit.title !== null) return hit;
    let meta: SessionMeta;
    try {
      meta = await loadSessionMeta(this.dshHome(), sessionId, this.workspaceRoot);
    } catch {
      meta = { sessionId, title: null, createdAt: null, updatedAt: null };
    }
    this.metaCache.set(sessionId, meta);
    return meta;
  }

  /**
   * Rebuilds the session tab strip.
   *
   * A sidebar cannot hold 20+ tabs, so the strip shows the most recently active
   * ones (dshAgent.sessionTabs) with the current session always included even if it
   * would fall outside that window; the full list stays in the switcher command.
   * Best effort throughout: a session whose title cannot be read still gets a tab.
   */
  private async pushSessions(): Promise<void> {
    const session = this.session;
    if (!session) {
      this.post({ type: 'sessions', tabs: [] });
      return;
    }
    const limit = vscode.workspace.getConfiguration('dshAgent').get<number>('sessionTabs', 8);
    if (limit <= 0) {
      this.post({ type: 'sessions', tabs: [] });
      return;
    }
    const currentId = session.id;
    let others: { sessionId: string }[] = [];
    try {
      others = await session.listSessions();
    } catch (err) {
      this.log(`[session] tab strip list failed: ${String(err)}`);
    }
    const ids = [...(currentId ? [currentId] : []), ...others.map((o) => o.sessionId)];
    const metas = await Promise.all(ids.map((id) => this.metaFor(id)));
    // Most recently active first. A brand-new session has no log yet, so treat the
    // current one as newest rather than letting it sink to the end.
    const weight = (m: SessionMeta): number =>
      m.updatedAt ?? (m.sessionId === currentId ? Date.now() : 0);
    const sorted = metas.sort((a, b) => weight(b) - weight(a));
    const shown = sorted.slice(0, limit);
    if (currentId && !shown.some((m) => m.sessionId === currentId)) {
      const current = sorted.find((m) => m.sessionId === currentId);
      if (current) shown.splice(limit - 1, 1, current);
    }
    this.post({
      type: 'sessions',
      tabs: shown.map((m) => ({
        id: m.sessionId,
        title: m.title ?? 'new session',
        current: m.sessionId === currentId,
      })),
    });
  }

  /** Binds the panel to another session and restores its transcript. */
  private async switchTo(sessionId: string): Promise<void> {
    const session = this.session;
    if (!session || typeof sessionId !== 'string' || sessionId === session.id) return;
    try {
      await session.resume(sessionId);
    } catch (err) {
      this.log(`[session] switch failed: ${String(err)}`);
      this.post({ type: 'notice', text: `Could not switch session: ${String(err)}`, tone: 'error' });
      return;
    }
    this.post({ type: 'clear' });
    await this.replayHistory(sessionId);
    void this.pushSessions();
    this.pushState();
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
        const flat = flattenToolContent(t.content);
        this.post({
          type: 'tool',
          id: t.toolCallId,
          title: this.toolTitles.get(t.toolCallId) ?? 'tool',
          status: t.status ?? 'completed',
          // Tool output can be huge; the row shows a single trimmed line.
          detail: flat.replace(/\s+/g, ' ').trim().slice(0, 120),
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
    const model = this.session?.options.find((o) => o.id === 'model');
    this.post({
      type: 'state',
      busy: this.session?.busy === true,
      sessionId: this.session?.id ?? null,
      model: currentChoiceName(model),
    });
  }

  /** Sends one prompt and drives the busy state around the turn. */
  private async send(text: string): Promise<void> {
    if (typeof text !== 'string' || text.trim() === '') return;
    await this.ensureSession();
    const session = this.session;
    if (!session) return;
    this.post({ type: 'user', text });
    this.pushState();
    // pushState reads session.busy, which only flips inside prompt(); force it on
    // for the turn so the composer disables immediately rather than a tick later.
    this.post({ type: 'state', busy: true, sessionId: session.id, model: null });
    try {
      const res = await session.prompt(text);
      this.post({ type: 'turnEnd', stopReason: res.stopReason });
      // A session is titled from its first user message, so the tab label only
      // becomes meaningful once a turn has completed.
      if (session.id) {
        this.metaCache.delete(session.id);
        void this.pushSessions();
      }
    } catch (err) {
      this.post({ type: 'notice', text: `Turn failed: ${String(err)}`, tone: 'error' });
    } finally {
      this.pushState();
    }
  }

  // —— commands ——

  async newSession(): Promise<void> {
    await this.ensureSession();
    if (!this.session) return;
    await this.session.newSession();
    this.post({ type: 'clear' });
    this.post({ type: 'notice', text: `New session ${this.session.id?.slice(0, 8)}…`, tone: 'info' });
    void this.pushSessions();
    this.pushState();
  }

  /**
   * Session switcher.
   *
   * `session/list` deliberately omits the ACTIVE session, so the current one is
   * added back explicitly and marked — otherwise the list would be missing exactly
   * the session the user is looking at. Titles and timestamps come from the on-disk
   * log (best effort); without them the picker would only show truncated ids.
   */
  async pickSession(): Promise<void> {
    await this.ensureSession();
    const session = this.session;
    if (!session) return;

    let others: { sessionId: string }[] = [];
    try {
      others = await session.listSessions();
    } catch (err) {
      this.log(`[session] list failed: ${String(err)}`);
    }

    const currentId = session.id;
    const ids = [...(currentId ? [currentId] : []), ...others.map((s) => s.sessionId)];
    if (ids.length === 0) {
      void vscode.window.showInformationMessage('DSH: no sessions for this workspace.');
      return;
    }

    // Metadata is a nicety; a failed read degrades to a bare id rather than an error.
    const metas = await Promise.all(ids.map((id) => this.metaFor(id)));
    // Current first; the rest most-recently-active first.
    const rest = metas
      .filter((m) => m.sessionId !== currentId)
      .sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0));
    const ordered = metas.filter((m) => m.sessionId === currentId).concat(rest);

    const items = ordered.map((m) => {
      const isCurrent = m.sessionId === currentId;
      const title = m.title ?? '(no messages yet)';
      return {
        label: `${isCurrent ? '$(check) ' : '$(comment-discussion) '}${title.replace(/\s+/g, ' ').slice(0, 72)}`,
        description: isCurrent ? 'current session' : relativeTime(m.updatedAt),
        detail: `${m.sessionId.slice(0, 12)}…${m.createdAt ? `  ·  created ${relativeTime(m.createdAt)}` : ''}`,
        id: m.sessionId,
        isCurrent,
      };
    });

    const picked = await vscode.window.showQuickPick(items, {
      placeHolder: 'Switch session  ·  history is restored from disk, not replayed by the agent',
      matchOnDetail: true,
    });
    if (!picked || picked.isCurrent) return; // Selecting the current session is a no-op.

    await this.switchTo(picked.id);
  }

  async pickModel(): Promise<void> {
    await this.ensureSession();
    const option = this.session?.options.find((o) => o.id === 'model');
    if (!this.session || !option) {
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
    await this.session.setConfigOption('model', picked.value);
    this.pushState();
  }

  cancel(): void {
    this.session?.cancel();
  }

  /** Drops the selection into the composer as a fenced block with a file reference. */
  sendSelection(): void {
    const editor = vscode.window.activeTextEditor;
    if (!editor || editor.selection.isEmpty) {
      void vscode.window.showInformationMessage('DSH: select some code first.');
      return;
    }
    const rel = vscode.workspace.asRelativePath(editor.document.uri);
    const start = editor.selection.start.line + 1;
    const end = editor.selection.end.line + 1;
    const lang = editor.document.languageId;
    const body = editor.document.getText(editor.selection);
    // ACP advertises embeddedContext: false, so context travels as plain text.
    const text = `${rel}:${start}-${end}\n\n\`\`\`${lang}\n${body}\n\`\`\`\n`;
    void this.view?.webview.postMessage({ type: 'user', text: `(attached ${rel}:${start}-${end})` });
    void this.send(text);
  }

  async restart(): Promise<void> {
    await this.session?.dispose();
    this.session = null;
    this.post({ type: 'clear' });
    await this.ensureSession();
  }

  async dispose(): Promise<void> {
    await this.session?.dispose();
    this.session = null;
  }
}
