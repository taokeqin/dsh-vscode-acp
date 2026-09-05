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
import { loadSessionMeta, type SessionMeta } from '../history/store';
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
  private view: vscode.WebviewView | null = null;
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
    this.view = view;
    view.webview.options = { enableScripts: true };
    view.webview.html = sessionsHtml(randomBytes(16).toString('base64'));
    view.webview.onDidReceiveMessage((msg: SessionsInbound) => void this.onMessage(msg));
    view.onDidDispose(() => {
      this.view = null;
    });
  }

  private post(msg: SessionsOutbound): void {
    void this.view?.webview.postMessage(msg);
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
      meta = { sessionId, title: null, createdAt: null, updatedAt: null };
    }
    this.metaCache.set(sessionId, meta);
    return meta;
  }

  /**
   * Rebuilds the list.
   *
   * session/list returns only INACTIVE sessions, so every session with an open tab
   * is absent and must be merged back in — otherwise the list would hide exactly the
   * sessions the user is working in.
   */
  async refresh(): Promise<void> {
    if (!this.view) return;
    const openIds = ChatPanel.openSessionIds();
    const activeId = ChatPanel.activeSessionId();

    let inactive: string[] = [];
    if (this.connection.running) {
      try {
        inactive = (await this.connection.listSessions()).map((s) => s.sessionId);
      } catch (err) {
        this.log(`[sessions] list failed: ${String(err)}`);
      }
    }
    const ids = [...new Set([...openIds, ...inactive])];
    const metas = await Promise.all(ids.map((id) => this.metaFor(id)));
    // Open sessions first, then most recently active. An open session with no log
    // yet (brand new) would otherwise sink to the bottom.
    const weight = (m: SessionMeta): number => m.updatedAt ?? (openIds.includes(m.sessionId) ? Date.now() : 0);
    metas.sort((a, b) => {
      const openDelta = Number(openIds.includes(b.sessionId)) - Number(openIds.includes(a.sessionId));
      return openDelta !== 0 ? openDelta : weight(b) - weight(a);
    });

    this.post({
      type: 'sessions',
      items: metas.map((m) => ({
        id: m.sessionId,
        title: m.title ?? 'new session',
        when: relativeTime(m.updatedAt),
        open: openIds.includes(m.sessionId),
        active: m.sessionId === activeId,
      })),
    });
    this.post({
      type: 'status',
      text: this.connection.running ? `${metas.length} sessions · ${this.connection.agentName}` : 'agent not started',
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
