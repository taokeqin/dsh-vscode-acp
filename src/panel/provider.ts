// src/panel/provider.ts — binds the ACP session to the chat webview.
//
// Translation layer only: ACP session/update shapes in, PanelOutbound messages out.
// Nothing here talks JSON-RPC directly; nothing in acp/ knows about vscode.
import { randomBytes } from 'node:crypto';
import * as path from 'node:path';
import * as vscode from 'vscode';
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
    this.pushState();
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
    this.pushState();
  }

  async pickSession(): Promise<void> {
    await this.ensureSession();
    if (!this.session) return;
    const sessions = await this.session.listSessions();
    if (sessions.length === 0) {
      void vscode.window.showInformationMessage('DSH: no persisted sessions for this workspace.');
      return;
    }
    const picked = await vscode.window.showQuickPick(
      sessions.map((s, i) => ({
        label: `${i === 0 ? '$(star-full) ' : ''}${s.sessionId.slice(0, 12)}…`,
        description: i === 0 ? 'most recent' : '',
        id: s.sessionId,
      })),
      { placeHolder: 'Resume a session (history is not replayed)' },
    );
    if (!picked) return;
    await this.session.resume(picked.id);
    this.post({ type: 'clear' });
    this.post({
      type: 'notice',
      text: 'Resumed. The agent kept its context, but ACP does not replay the transcript, so this panel starts empty.',
      tone: 'info',
    });
    this.pushState();
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
