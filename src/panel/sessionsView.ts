// src/panel/sessionsView.ts — the sidebar sessions list.
//
// A launcher, not a transcript: it lists every session for the workspace and opens
// one as an editor tab. Sessions with an open tab are marked, and the visible tab is
// highlighted, so the list doubles as an overview of what is currently open.
import { randomBytes } from 'node:crypto';
import * as vscode from 'vscode';
import type { AcpConnection } from '../acp/connection';
import { listSessionIdsOnDisk, type SessionMeta } from '../history/store';
import { pickPreferredSession } from '../sessionOrder';
import type { SessionCatalog } from '../sessionCatalog';
import { dshHome } from '../dshHome';
import { ChatPanel } from './chatPanel';
import { sessionsHtml, type SessionsInbound, type SessionsOutbound } from './sessionsHtml';

/** Compact relative time ("3m ago", "2d ago"). */
export function relativeTime(ms: number | null): string {
  if (ms === null) return '';
  const secs = Math.max(0, Math.round((Date.now() - ms) / 1000));
  if (secs < 60) return 'just now';
  const mins = Math.round(secs / 60);
  if (mins < 60) return `${mins}m`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours}h`;
  return `${Math.round(hours / 24)}d`;
}

export class SessionsViewProvider implements vscode.WebviewViewProvider {
  /**
   * Every view showing this list.
   *
   * The same provider instance is registered for both the activity-bar and the
   * secondary-sidebar view, so one list can be mounted on the left and the right at
   * once and both stay in sync from a single refresh.
   */
  private readonly views = new Set<vscode.WebviewView>();

  constructor(
    private readonly connection: AcpConnection,
    private readonly workspaceRoot: string,
    private readonly log: (line: string) => void,
    /** Shared with the panel's inline list, so one metadata cache serves both. */
    private readonly catalog: SessionCatalog,
  ) {
    // Opening, closing or switching tabs changes what this list should show.
    ChatPanel.onDidChangeOpen(() => void this.refresh());
  }

  resolveWebviewView(view: vscode.WebviewView): void {
    this.views.add(view);
    view.webview.options = { enableScripts: true };
    view.webview.html = sessionsHtml(randomBytes(16).toString('base64'));
    view.webview.onDidReceiveMessage((msg: SessionsInbound) => void this.onMessage(msg));
    view.onDidDispose(() => {
      this.views.delete(view);
    });
  }

  /** Broadcasts to every mounted view. */
  private post(msg: SessionsOutbound): void {
    for (const view of this.views) void view.webview.postMessage(msg);
  }

  private async onMessage(msg: SessionsInbound): Promise<void> {
    switch (msg.type) {
      case 'ready':
      case 'refresh':
        await this.refresh();
        break;
      case 'new':
        await this.newSession();
        break;
      case 'open':
        await this.openSession(msg.id);
        break;
    }
  }

  /** Rebuilds the list from the shared catalog. */
  async refresh(): Promise<void> {
    if (this.views.size === 0) return;
    const rows = await this.catalog.rows(
      this.connection,
      ChatPanel.openSessionIds(),
      ChatPanel.activeSessionId(),
    );
    this.post({ type: 'sessions', items: rows });
    const count = `${rows.length} session${rows.length === 1 ? '' : 's'}`;
    this.post({
      type: 'status',
      text: this.connection.running ? `${count} · ${this.connection.agentName}` : `${count} · agent idle`,
    });
  }

  /** Invalidates one session's cached title, e.g. after its first turn. */
  invalidate(sessionId: string): void {
    this.catalog.invalidate(sessionId);
  }

  /**
   * The "DSH: Open" entry point, mirroring Claude Code's `editor.openLast`.
   *
   * Reveals a session tab if one is already open, otherwise reopens the most recent
   * session for this workspace, otherwise starts a fresh one — so the title-bar
   * icon always does something sensible on one click.
   */
  async openLast(): Promise<void> {
    const active = ChatPanel.activeSessionId();
    if (active !== null) {
      ChatPanel.get(active)?.reveal();
      return;
    }
    const openIds = ChatPanel.openSessionIds();
    if (openIds.length > 0) {
      ChatPanel.get(openIds[0])?.reveal();
      return;
    }
    let candidates: SessionMeta[] = [];
    try {
      const ids = listSessionIdsOnDisk(dshHome(), this.workspaceRoot);
      const metas = await Promise.all(ids.map((id) => this.catalog.metaFor(id)));
      candidates = metas;
    } catch (err) {
      this.log(`[sessions] openLast scan failed: ${String(err)}`);
    }
    const target = pickPreferredSession(candidates);
    if (target) {
      await this.openSession(target.sessionId);
      return;
    }
    await this.newSession();
  }

  /**
   * Surfaces a start failure with a way out.
   *
   * The common cause is a GUI-launched VS Code that cannot see a version-manager
   * install, so the message offers to open the setting that fixes it permanently.
   */
  private async reportStartFailure(err: unknown): Promise<void> {
    const message = String(err instanceof Error ? err.message : err);
    const openSetting = 'Open Setting';
    const choice = await vscode.window.showErrorMessage(message, openSetting, 'Show Logs');
    if (choice === openSetting) {
      await vscode.commands.executeCommand('workbench.action.openSettings', 'dshAgent.executablePath');
    } else if (choice === 'Show Logs') {
      await vscode.commands.executeCommand('dshAgent.showLogs');
    }
  }

  /** Creates a session and opens it in a new editor tab. */
  async newSession(): Promise<void> {
    try {
      const id = await this.connection.newSession();
      ChatPanel.create(id, 'DSH · new session', this.connection, this.workspaceRoot, this.log);
      await this.refresh();
    } catch (err) {
      this.log(`[sessions] create failed: ${String(err)}`);
      void this.reportStartFailure(err);
    }
  }

  /**
   * Opens a session as an editor tab, revealing the existing tab when there is one.
   * A session already open is active agent-side, so resuming it would fail — that is
   * exactly the case the reveal short-circuits.
   */
  async openSession(sessionId: string): Promise<void> {
    if (typeof sessionId !== 'string' || sessionId === '') return;
    const existing = ChatPanel.get(sessionId);
    if (existing) {
      existing.reveal();
      return;
    }
    const meta = await this.catalog.metaFor(sessionId);
    try {
      await this.connection.resume(sessionId);
    } catch (err) {
      this.log(`[sessions] resume failed for ${sessionId}: ${String(err)}`);
      void this.reportStartFailure(err);
      return;
    }
    const panel = ChatPanel.create(
      sessionId,
      `DSH · ${(meta.title ?? sessionId.slice(0, 8)).slice(0, 40)}`,
      this.connection,
      this.workspaceRoot,
      this.log,
    );
    void panel.replayHistory();
    await this.refresh();
  }
}
