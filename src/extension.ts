// src/extension.ts — activation, command registration, lifecycle.
import * as vscode from 'vscode';
import { ChatViewProvider } from './panel/provider';

let provider: ChatViewProvider | null = null;
let output: vscode.OutputChannel | null = null;

/** Timestamped log line into the DSH Agent output channel. */
function log(line: string): void {
  const d = new Date();
  const ts = [d.getHours(), d.getMinutes(), d.getSeconds()]
    .map((n) => String(n).padStart(2, '0'))
    .join(':');
  output?.appendLine(`[${ts}] ${line}`);
}

/**
 * The agent needs one absolute workspace root: ACP sessions are created against
 * an absolute cwd, and dsh supports exactly one primary workspace per session.
 */
function resolveRoot(): string | null {
  return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? null;
}

export function activate(context: vscode.ExtensionContext): void {
  output = vscode.window.createOutputChannel('DSH Agent');
  const root = resolveRoot();
  if (root === null) {
    // Without a folder there is no cwd to bind a session to; fail loudly at use
    // time rather than spawning an agent rooted somewhere arbitrary.
    log('[init] no workspace folder open; the agent panel stays inactive');
  } else {
    log(`[init] workspace root: ${root}`);
  }

  provider = new ChatViewProvider(root ?? process.cwd(), log);

  const requireRoot = (fn: () => void | Promise<void>) => async (): Promise<void> => {
    if (resolveRoot() === null) {
      void vscode.window.showWarningMessage('DSH: open a folder before using the agent.');
      return;
    }
    await fn();
  };

  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider('dshAgent.chat', provider, {
      // Keep the transcript when the panel is hidden; the agent process outlives it anyway.
      webviewOptions: { retainContextWhenHidden: true },
    }),
    vscode.commands.registerCommand('dshAgent.focus', () =>
      vscode.commands.executeCommand('dshAgent.chat.focus'),
    ),
    vscode.commands.registerCommand('dshAgent.newSession', requireRoot(() => provider!.newSession())),
    vscode.commands.registerCommand('dshAgent.pickSession', requireRoot(() => provider!.pickSession())),
    vscode.commands.registerCommand('dshAgent.pickModel', requireRoot(() => provider!.pickModel())),
    vscode.commands.registerCommand('dshAgent.cancel', () => provider?.cancel()),
    vscode.commands.registerCommand('dshAgent.restart', requireRoot(() => provider!.restart())),
    vscode.commands.registerCommand('dshAgent.sendSelection', requireRoot(async () => {
      await vscode.commands.executeCommand('dshAgent.chat.focus');
      provider!.sendSelection();
    })),
    vscode.commands.registerCommand('dshAgent.showLogs', () => output?.show()),
    { dispose: () => void provider?.dispose() },
  );
}

export async function deactivate(): Promise<void> {
  await provider?.dispose();
  provider = null;
}
