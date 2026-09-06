// src/extension.ts — activation, command registration, lifecycle.
//
// Shape: one agent process (AcpConnection) multiplexing N sessions; each session is
// an editor tab (ChatPanel); the sidebar is a session list (SessionsViewProvider).
import * as vscode from 'vscode';
import { AcpConnection } from './acp/connection';
import { ChatPanel, CHAT_VIEW_TYPE } from './panel/chatPanel';
import { SessionsViewProvider } from './panel/sessionsView';
import { SessionCatalog } from './sessionCatalog';

let connection: AcpConnection | null = null;
let sessions: SessionsViewProvider | null = null;
let output: vscode.OutputChannel | null = null;

function log(line: string): void {
  const d = new Date();
  const ts = [d.getHours(), d.getMinutes(), d.getSeconds()]
    .map((n) => String(n).padStart(2, '0'))
    .join(':');
  output?.appendLine(`[${ts}] ${line}`);
}

/**
 * The agent needs one absolute workspace root: ACP sessions are created against an
 * absolute cwd, and dsh supports exactly one primary workspace per session.
 */
function resolveRoot(): string | null {
  return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? null;
}

/** Answers a permission prompt. Rarely fires: the acp profile auto-approves tool use. */
async function askPermission(params: unknown): Promise<string | null> {
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

export function activate(context: vscode.ExtensionContext): void {
  output = vscode.window.createOutputChannel('DSH Agent');
  const root = resolveRoot();
  if (root === null) {
    log('[init] no workspace folder open; the agent stays inactive');
  } else {
    log(`[init] workspace root: ${root}`);
  }
  const cwd = root ?? process.cwd();
  const cfg = vscode.workspace.getConfiguration('dshAgent');

  connection = new AcpConnection({
    command: cfg.get<string>('executablePath', 'dsh'),
    profile: cfg.get<string>('profile', 'acp'),
    cwd,
    log,
    onExit: () => {
      ChatPanel.notifyAllAgentExit();
      void sessions?.refresh();
    },
    onPermission: askPermission,
  });
  // One catalog behind both the sidebar list and the panel's inline list, so the
  // metadata cache is shared rather than filled twice.
  const catalog = new SessionCatalog(cwd, log);
  sessions = new SessionsViewProvider(connection, cwd, log, catalog);
  ChatPanel.useCatalog(catalog);

  /** Guards commands that need a folder; without one there is no cwd to bind to. */
  const requireRoot = (fn: () => void | Promise<void>) => async (): Promise<void> => {
    if (resolveRoot() === null) {
      void vscode.window.showWarningMessage('DSH: open a folder before using the agent.');
      return;
    }
    await fn();
  };

  /** The tab the user is looking at, if any. */
  const activePanel = (): ChatPanel | undefined => {
    const id = ChatPanel.activeSessionId();
    return id === null ? undefined : ChatPanel.get(id);
  };

  context.subscriptions.push(
    // The list is declared only in the secondary (right) sidebar, so the left rail
    // stays free for file navigation. VS Code lets a view be dragged between
    // sidebars natively, which is why no setting is needed to move it.
    vscode.window.registerWebviewViewProvider('dshAgent.sessions', sessions!),

    // Restores session tabs after a window reload; the webview persisted its
    // sessionId via setState, and each restored tab resumes that session.
    vscode.window.registerWebviewPanelSerializer(CHAT_VIEW_TYPE, {
      deserializeWebviewPanel: async (panel, state: { sessionId?: string } | undefined) => {
        if (!connection) {
          panel.dispose();
          return;
        }
        await ChatPanel.restore(
          panel,
          state && typeof state.sessionId === 'string' ? { sessionId: state.sessionId } : undefined,
          connection,
          cwd,
          log,
        );
        void sessions?.refresh();
      },
    }),

    vscode.commands.registerCommand('dshAgent.focus', () =>
      vscode.commands.executeCommand('dshAgent.sessions.focus'),
    ),
    vscode.commands.registerCommand('dshAgent.openLast', requireRoot(() => sessions!.openLast())),
    vscode.commands.registerCommand('dshAgent.newSession', requireRoot(() => sessions!.newSession())),
    // Invoked by the panel's inline session list, which passes the id.
    vscode.commands.registerCommand('dshAgent.openSession', (id: unknown) =>
      typeof id === 'string' ? sessions?.openSession(id) : undefined,
    ),
    vscode.commands.registerCommand('dshAgent.refreshSessions', () => void sessions?.refresh()),
    vscode.commands.registerCommand('dshAgent.pickModel', requireRoot(async () => {
      const panel = activePanel();
      if (!panel) {
        void vscode.window.showInformationMessage('DSH: open a session tab first.');
        return;
      }
      await panel.pickModel();
    })),
    vscode.commands.registerCommand('dshAgent.cancel', () => {
      const id = ChatPanel.activeSessionId();
      if (id !== null) connection?.cancel(id);
    }),
    vscode.commands.registerCommand('dshAgent.sendSelection', requireRoot(async () => {
      const editor = vscode.window.activeTextEditor;
      if (!editor || editor.selection.isEmpty) {
        void vscode.window.showInformationMessage('DSH: select some code first.');
        return;
      }
      const rel = vscode.workspace.asRelativePath(editor.document.uri);
      const start = editor.selection.start.line + 1;
      const end = editor.selection.end.line + 1;
      const body = editor.document.getText(editor.selection);
      // ACP advertises embeddedContext: false, so context travels as plain text.
      const text = `${rel}:${start}-${end}\n\n\`\`\`${editor.document.languageId}\n${body}\n\`\`\`\n`;

      let panel = activePanel();
      if (!panel) {
        // No visible session: start one rather than dropping the selection.
        await sessions!.newSession();
        const id = ChatPanel.activeSessionId();
        panel = id === null ? undefined : ChatPanel.get(id);
      }
      if (!panel) return;
      panel.reveal();
      await panel.send(text);
    })),
    vscode.commands.registerCommand('dshAgent.showLogs', () => output?.show()),
    vscode.commands.registerCommand('dshAgent.restart', requireRoot(async () => {
      ChatPanel.disposeAll();
      await connection?.dispose();
      void sessions?.refresh();
      void vscode.window.showInformationMessage('DSH: agent stopped. Open a session to restart it.');
    })),

    { dispose: () => void connection?.dispose() },
  );
}

export async function deactivate(): Promise<void> {
  // Deliberately does NOT dispose the panels. Disposing a WebviewPanel closes its
  // tab, and a tab closed during shutdown is a tab VS Code cannot restore on the
  // next window — which is what made session tabs vanish across a reload. Closing
  // the ACP sessions is enough; VS Code serializes the panels itself.
  await connection?.dispose();
  connection = null;
  sessions = null;
}
