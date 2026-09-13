// src/extension.ts — activation, command registration, lifecycle.
//
// Shape: one agent process (AcpConnection) multiplexing N sessions; each session is
// an editor tab (ChatPanel); the sidebar is a session list (SessionsViewProvider).
import * as path from 'node:path';
import * as vscode from 'vscode';
import { AcpConnection } from './acp/connection';
import type { RequestPermissionParams } from './acp/types';
import { ChatPanel, CHAT_VIEW_TYPE } from './panel/chatPanel';
import { SessionsViewProvider } from './panel/sessionsView';
import { pickWorkspaceFiles, relativeWorkspacePath } from './filePicker';
import { selectionText } from './context';
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
  const p = params as RequestPermissionParams;
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

  /**
   * The tab the user is looking at: the focused one, else a visible one. The fallback
   * matters for context-menu commands — the explorer has focus, so the session tab is
   * visible but not active, and keying off `active` alone started a fresh session.
   */
  const activePanel = (): ChatPanel | undefined => {
    const id = ChatPanel.activeSessionId() ?? ChatPanel.visibleSessionId();
    return id === null ? undefined : ChatPanel.get(id);
  };

  /** The visible session tab, or a fresh one when every tab is closed. */
  const ensurePanel = async (): Promise<ChatPanel | undefined> => {
    let panel = activePanel();
    if (!panel) {
      await sessions!.newSession();
      const id = ChatPanel.activeSessionId();
      panel = id === null ? undefined : ChatPanel.get(id);
    }
    return panel;
  };

  /** File URIs from a command argument: a single Uri or the explorer's multi-select array. */
  const asUris = (arg: unknown): vscode.Uri[] => {
    const list = Array.isArray(arg) ? arg : [arg];
    return list.filter((v): v is vscode.Uri => v instanceof vscode.Uri);
  };

  /**
   * The last real text editor. The composer moves focus into a webview, where
   * `window.activeTextEditor` is undefined, so commands driven from the composer
   * (Selection) must fall back to this. The file is remembered too, so the `@` menu can
   * rank the file the user was looking at first.
   */
  let lastTextEditor = vscode.window.activeTextEditor;
  const noteActive = (editor: vscode.TextEditor | undefined): void => {
    if (!editor) return;
    lastTextEditor = editor;
    const root = resolveRoot();
    ChatPanel.noteActiveFile(
      root === null || editor.document.uri.scheme !== 'file'
        ? null
        : relativeWorkspacePath(root, editor.document.uri.fsPath),
    );
  };
  noteActive(lastTextEditor);

  /**
   * The active editor's selection as a workspace-relative descriptor, or null when
   * there is nothing selected (or it sits in a second workspace folder, which
   * sessions cannot reach). Shared by Send Selection and Add Selection.
   */
  const readSelection = (): { path: string; line: number; endLine: number; lang: string; text: string } | null => {
    const editor = vscode.window.activeTextEditor ?? lastTextEditor;
    if (!editor || editor.selection.isEmpty) {
      void vscode.window.showInformationMessage('DSH: select some code first.');
      return null;
    }
    // Every session is bound to the FIRST workspace folder; sending code from a
    // second folder would silently hand the wrong project to the agent, so refuse
    // loudly instead. (One agent process = one primary workspace, see resolveRoot.)
    const root = resolveRoot()!;
    const docFolder = vscode.workspace.getWorkspaceFolder(editor.document.uri);
    if (docFolder !== undefined && docFolder.uri.fsPath !== root) {
      void vscode.window.showWarningMessage(
        `DSH is bound to the first workspace folder ("${path.basename(root)}"). ` +
          `Move "${docFolder.name}" to the first position — or open it alone — to discuss its code.`,
      );
      return null;
    }
    return {
      path: vscode.workspace.asRelativePath(editor.document.uri),
      line: editor.selection.start.line + 1,
      endLine: editor.selection.end.line + 1,
      lang: editor.document.languageId,
      text: editor.document.getText(editor.selection),
    };
  };

  /**
   * Stages the editor's current selection into an open session, unchecked.
   *
   * The checkbox is the include switch, so selecting code never silently sends it —
   * but you also do not have to click anything to stage the range you are looking at.
   * Never opens a session: with no session on screen this is a no-op.
   */
  const stageSelection = (editor: vscode.TextEditor | undefined): void => {
    if (!editor || editor.selection.isEmpty || editor.document.uri.scheme !== 'file') return;
    const root = resolveRoot();
    if (root === null) return;
    const docFolder = vscode.workspace.getWorkspaceFolder(editor.document.uri);
    if (docFolder !== undefined && docFolder.uri.fsPath !== root) return;
    const panel = activePanel();
    if (!panel) return;
    panel.addSelectionContext(
      {
        kind: 'selection',
        enabled: false,
        path: vscode.workspace.asRelativePath(editor.document.uri),
        line: editor.selection.start.line + 1,
        endLine: editor.selection.end.line + 1,
        lang: editor.document.languageId,
        text: editor.document.getText(editor.selection),
      },
      false,
    );
  };

  // A drag fires a selection change per pixel; only the settled range matters.
  let selectionTimer: ReturnType<typeof setTimeout> | undefined;
  const scheduleStage = (editor: vscode.TextEditor | undefined): void => {
    if (selectionTimer !== undefined) clearTimeout(selectionTimer);
    selectionTimer = setTimeout(() => {
      selectionTimer = undefined;
      stageSelection(editor);
    }, 250);
  };

  context.subscriptions.push(
    // Keep the last real text editor (and its file) current for composer-driven commands.
    vscode.window.onDidChangeActiveTextEditor(noteActive),
    // Stage a selection as an unchecked chip; the checkbox decides whether it is sent.
    vscode.window.onDidChangeTextEditorSelection((e) => scheduleStage(e.textEditor)),
    { dispose: () => { if (selectionTimer !== undefined) clearTimeout(selectionTimer); } },
    // A closed document must not be read from later: the remembered editor would throw
    // on `document.getText`. Drop it, and the `@` menu's active-file hint with it.
    vscode.workspace.onDidCloseTextDocument((doc) => {
      if (lastTextEditor !== undefined && lastTextEditor.document === doc) {
        lastTextEditor = undefined;
        ChatPanel.noteActiveFile(null);
      }
    }),
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
    // Attaches files to the next message as context chips (`@path` mentions at send
    // time). Two callers: the composer Files button (passing its session id) and the
    // explorer context menu (passing the selected file URIs). Without URIs it shows
    // the workspace file list to pick from.
    vscode.commands.registerCommand('dshAgent.addFiles', async (arg?: unknown, selected?: unknown) => {
      const root = resolveRoot();
      if (root === null) {
        void vscode.window.showWarningMessage('DSH: open a folder before using the agent.');
        return;
      }
      const fromSelection = asUris(selected);
      const uris = fromSelection.length > 0 ? fromSelection : asUris(arg);
      let panel = typeof arg === 'string' ? ChatPanel.get(arg) : activePanel();
      const rels = uris.length > 0
        ? uris
            .map((uri) => (uri.scheme === 'file' ? relativeWorkspacePath(root, uri.fsPath) : null))
            .filter((rel): rel is string => rel !== null)
        : await pickWorkspaceFiles(root);
      if (rels.length === 0) {
        // A right-click in a second workspace folder maps to nothing: sessions are
        // bound to the first folder, so say why instead of doing nothing silently.
        if (uris.length > 0) {
          void vscode.window.showWarningMessage(
            `DSH is bound to the first workspace folder ("${path.basename(root)}"); those files are outside it.`,
          );
        }
        return;
      }
      panel ??= await ensurePanel();
      panel?.reveal();
      panel?.addFilesContext(rels);
    }),
    // Includes the current selection in the next message, or drops it back out when it
    // is already on — the Selection button is a switch, not an add-only action.
    vscode.commands.registerCommand('dshAgent.addSelection', async (arg?: unknown) => {
      if (resolveRoot() === null) {
        void vscode.window.showWarningMessage('DSH: open a folder before using the agent.');
        return;
      }
      const sel = readSelection();
      if (!sel) return;
      let panel = typeof arg === 'string' ? ChatPanel.get(arg) : activePanel();
      panel ??= await ensurePanel();
      panel?.reveal();
      panel?.toggleSelectionContext({ kind: 'selection', enabled: true, ...sel });
    }),
    vscode.commands.registerCommand('dshAgent.sendSelection', requireRoot(async () => {
      const sel = readSelection();
      if (!sel) return;
      // ACP advertises embeddedContext: false, so context travels as plain text.
      const text = selectionText({ kind: 'selection', enabled: true, ...sel });

      const panel = await ensurePanel();
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
