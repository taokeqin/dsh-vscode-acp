// src/sessionCatalog.ts — the session list, shared by the sidebar and the panel.
//
// Both surfaces need the same rows, and both need the metadata cache behind them, so
// the assembly lives here instead of being duplicated. One instance is created at
// activation and handed to both.
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { AcpConnection } from './acp/connection';
import { listSessionIdsOnDisk, loadSessionMeta, type SessionMeta } from './history/store';
import { orderSessions } from './sessionOrder';

/** A row as presented to either surface. */
export interface SessionRow {
  id: string;
  title: string;
  /** Relative time of last activity, pre-formatted. */
  when: string;
  /** True when this session already has an editor tab open. */
  open: boolean;
  /** True when it is the visible tab. */
  active: boolean;
}

/** Compact relative time ("3m", "2d"). */
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

export class SessionCatalog {
  /**
   * Metadata cache. A miss costs a file read plus a bounded zstd decode (~2 ms), and
   * titles never change once dsh writes them, so hits are safe for the window's life.
   */
  private readonly meta = new Map<string, SessionMeta>();

  constructor(
    private readonly workspaceRoot: string,
    private readonly log: (line: string) => void,
  ) {}

  private dshHome(): string {
    return process.env.DSH_HOME ?? join(homedir(), '.dsh');
  }

  /** Cached metadata for one session. Never throws. */
  async metaFor(sessionId: string): Promise<SessionMeta> {
    const hit = this.meta.get(sessionId);
    if (hit && hit.title !== null) return hit;
    let meta: SessionMeta;
    try {
      meta = await loadSessionMeta(this.dshHome(), sessionId, this.workspaceRoot);
    } catch {
      meta = {
        sessionId, title: null, createdAt: null, updatedAt: null, cwd: null, delegationDepth: null,
      };
    }
    this.meta.set(sessionId, meta);
    return meta;
  }

  /** Drops a cached title, e.g. after the first turn of a new session names it. */
  invalidate(sessionId: string): void {
    this.meta.delete(sessionId);
  }

  /**
   * Builds the rows.
   *
   * Three sources are merged. Sessions come from disk so the list renders before any
   * agent has been spawned; `session/list` is added when the agent is up because it
   * is authoritative on resumability; and sessions with an open tab are added because
   * `session/list` returns only INACTIVE ones and would otherwise hide exactly the
   * conversations being worked in.
   */
  async rows(
    connection: AcpConnection,
    openIds: readonly string[],
    activeId: string | null,
  ): Promise<SessionRow[]> {
    const ids = new Set<string>(openIds);
    try {
      for (const id of listSessionIdsOnDisk(this.dshHome(), this.workspaceRoot)) ids.add(id);
    } catch (err) {
      this.log(`[sessions] disk scan failed: ${String(err)}`);
    }
    if (connection.running) {
      try {
        for (const s of await connection.listSessions()) ids.add(s.sessionId);
      } catch (err) {
        this.log(`[sessions] list failed: ${String(err)}`);
      }
    }
    const metas = await Promise.all([...ids].map((id) => this.metaFor(id)));
    return orderSessions(metas, openIds).map((m) => ({
      id: m.sessionId,
      title: m.title ?? 'new session',
      when: relativeTime(m.updatedAt),
      open: openIds.includes(m.sessionId),
      active: m.sessionId === activeId,
    }));
  }
}
