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
import { ChatPanel, NEW_SESSION_TITLE } from './chatPanel';
import { sessionsHtml, type SessionsInbound, type SessionsOutbound } from './sessionsHtml';

/** Fold rapid panel-open/close/focus/turn-end bursts into one list rebuild. */
const CHANGE_DEBOUNCE_MS = 250;

export class SessionsViewProvider implements vscode.WebviewViewProvider {
  /**
   * Every view showing this list.
   *
   * The same provider instance is registered for both the activity-bar and the
   * secondary-sidebar view, so one list can be mounted on the left and the right at
   * once and both stay in sync from a single refresh.
   */
  private readonly views = new Set<vscode.WebviewView>();
  private refreshTimer: NodeJS.Timeout | null = null;

  constructor(
    private readonly connection: AcpConnection,
    private readonly workspaceRoot: string,
    private readonly log: (line: string) => void,
    /** Shared with the panel's inline list, so one metadata cache serves both. */
    private readonly catalog: SessionCatalog,
  ) {
    // Opening, closing or switching tabs changes what this list should show. Such
    // changes arrive in bursts (a turn end, focus changes across tabs), and each
    // rebuild scans disk and may call session/list, so coalesce them. User-initiated
    // refreshes (new/open/refresh button) still call refresh() directly.
    ChatPanel.onDidChangeOpen(() => this.scheduleRefresh());
  }

  private scheduleRefresh(): void {
    if (this.refreshTimer !== null) return;
    this.refreshTimer = setTimeout(() => {
      this.refreshTimer = null;
      void this.refresh();
    }, CHANGE_DEBOUNCE_MS);
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
    for (const view of this.views) {
      try {
        void view.webview.postMessage(msg);
      } catch {
        // The view can be disposed (sidebar hidden/closed) between our guard and
        // the post, and postMessage then throws "Webview is disposed". Its own
        // onDidDispose removes it from the set; nothing left to deliver to.
      }
    }
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
      ChatPanel.create(id, NEW_SESSION_TITLE, this.connection, this.workspaceRoot, this.log);
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
      // A session holding no conversation gets the same placeholder as one created
      // with "+", so its tab is named from the first message sent (see ChatPanel.send).
      meta.title ? `DSH · ${meta.title.slice(0, 40)}` : NEW_SESSION_TITLE,
      this.connection,
      this.workspaceRoot,
      this.log,
    );
    void panel.replayHistory();
    await this.refresh();
  }
}
