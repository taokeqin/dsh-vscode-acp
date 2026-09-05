// src/panel/sessionsView.ts — the sidebar sessions list.
//
// A launcher, not a transcript: it lists every session for the workspace and opens
// one as an editor tab. Sessions with an open tab are marked, and the visible tab is
// highlighted, so the list doubles as an overview of what is currently open.
import { randomBytes } from 'node:crypto';
import { homedir } from 'node:os';
import * as path from 'node:path';
import * as vscode from 'vscode';
import type { AcpConnection } from '../acp/connection';
import { listSessionIdsOnDisk, loadSessionMeta, type SessionMeta } from '../history/store';
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
  /**
   * Session metadata cache. A miss costs a file read plus a bounded zstd decode
   * (~2 ms); titles never change once dsh writes them, so hits are safe to reuse.
   */
  private readonly metaCache = new Map<string, SessionMeta>();

  constructor(
    private readonly connection: AcpConnection,
    private readonly workspaceRoot: string,
    private readonly log: (line: string) => void,
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

  private dshHome(): string {
    return process.env.DSH_HOME ?? path.join(homedir(), '.dsh');
  }

  /** Cached metadata for one session. Never throws. */
  private async metaFor(sessionId: string): Promise<SessionMeta> {
    const hit = this.metaCache.get(sessionId);
    if (hit && hit.title !== null) return hit;
    let meta: SessionMeta;
    try {
      meta = await loadSessionMeta(this.dshHome(), sessionId, this.workspaceRoot);
    } catch {
      meta = {
        sessionId, title: null, createdAt: null, updatedAt: null, cwd: null, delegationDepth: null,
      };
    }
    this.metaCache.set(sessionId, meta);
    return meta;
  }

  /**
   * Rebuilds the list.
   *
   * Sessions are enumerated from disk rather than from the agent, so the list
   * renders on a fresh window before anything has been spawned. Requiring a running
   * agent was a bug: a reloaded window showed an empty list and "agent not started"
   * even with sessions on disk, because the process is only started lazily.
   *
   * Three sources are merged:
   *   · on-disk sessions for this workspace  (works with no agent)
   *   · session/list when the agent is up    (authoritative for resumability)
   *   · sessions with an open tab            (absent from session/list, which
   *                                           returns only INACTIVE sessions)
   */
  async refresh(): Promise<void> {
    if (this.views.size === 0) return;
    const openIds = ChatPanel.openSessionIds();
    const activeId = ChatPanel.activeSessionId();

    const ids = new Set<string>(openIds);
    try {
      for (const id of listSessionIdsOnDisk(this.dshHome(), this.workspaceRoot)) ids.add(id);
    } catch (err) {
      this.log(`[sessions] disk scan failed: ${String(err)}`);
    }
    if (this.connection.running) {
      try {
        for (const s of await this.connection.listSessions()) ids.add(s.sessionId);
      } catch (err) {
        this.log(`[sessions] list failed: ${String(err)}`);
      }
    }

    const metas = await Promise.all([...ids].map((id) => this.metaFor(id)));
    // Drop delegated sub-agent runs: only depth 0 is a conversation the user started.
    // This is what session/list means by "root sessions"; the disk holds both.
    const roots = metas.filter((m) => m.delegationDepth === null || m.delegationDepth === 0);
    // Open sessions first, then most recently active. An open session with no log
    // yet (brand new) would otherwise sink to the bottom.
    const weight = (m: SessionMeta): number => m.updatedAt ?? (openIds.includes(m.sessionId) ? Date.now() : 0);
    roots.sort((a, b) => {
      const openDelta = Number(openIds.includes(b.sessionId)) - Number(openIds.includes(a.sessionId));
      return openDelta !== 0 ? openDelta : weight(b) - weight(a);
    });

    this.post({
      type: 'sessions',
      items: roots.map((m) => ({
        id: m.sessionId,
        title: m.title ?? 'new session',
        when: relativeTime(m.updatedAt),
        open: openIds.includes(m.sessionId),
        active: m.sessionId === activeId,
      })),
    });
    const count = `${roots.length} session${roots.length === 1 ? '' : 's'}`;
    this.post({
      type: 'status',
      text: this.connection.running ? `${count} · ${this.connection.agentName}` : `${count} · agent idle`,
    });
  }

  /** Invalidates one session's cached title, e.g. after its first turn. */
  invalidate(sessionId: string): void {
    this.metaCache.delete(sessionId);
  }

  /** Creates a session and opens it in a new editor tab. */
  async newSession(): Promise<void> {
    try {
      const id = await this.connection.newSession();
      ChatPanel.create(id, 'DSH · new session', this.connection, this.workspaceRoot, this.log);
      await this.refresh();
    } catch (err) {
      this.log(`[sessions] create failed: ${String(err)}`);
      void vscode.window.showErrorMessage(
        `DSH: could not start a session: ${String(err)}. Check that "dsh" is on PATH or set dshAgent.executablePath.`,
      );
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
    const meta = await this.metaFor(sessionId);
    try {
      await this.connection.resume(sessionId);
    } catch (err) {
      this.log(`[sessions] resume failed for ${sessionId}: ${String(err)}`);
      void vscode.window.showWarningMessage(`DSH: could not open that session: ${String(err)}`);
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
