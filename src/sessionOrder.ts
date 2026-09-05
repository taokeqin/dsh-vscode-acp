// src/sessionOrder.ts — which session to open, and in what order to list them.
//
// Pure and vscode-free so the rules are testable. They exist because recency alone
// chooses badly: a session is created before its first message, so an untouched
// session — from a + click, or from a start that failed after creating one — carries
// the newest timestamp and beats every real conversation.
import type { SessionMeta } from './history/store';

/**
 * A session holds a conversation if dsh gave it a title, which it derives from the
 * first user message. No title means nothing was ever sent.
 */
export function hasContent(m: SessionMeta): boolean {
  return typeof m.title === 'string' && m.title.trim() !== '';
}

/** Most recently active first. */
export function byRecency(a: SessionMeta, b: SessionMeta): number {
  return (b.updatedAt ?? 0) - (a.updatedAt ?? 0);
}

/** Drops delegated sub-agent runs; only depth 0 is a conversation the user started. */
export function rootsOnly(metas: SessionMeta[]): SessionMeta[] {
  return metas.filter((m) => m.delegationDepth === null || m.delegationDepth === 0);
}

/**
 * The session "DSH: Open" should land on: the most recent one holding a
 * conversation, falling back to the most recent of any kind.
 */
export function pickPreferredSession(metas: SessionMeta[]): SessionMeta | undefined {
  const roots = rootsOnly(metas);
  const withContent = roots.filter(hasContent).sort(byRecency);
  return withContent[0] ?? [...roots].sort(byRecency)[0];
}

/**
 * Sidebar order: open tabs first, then sessions holding a conversation, then
 * untouched ones — each group most-recent-first.
 */
export function orderSessions(metas: SessionMeta[], openIds: readonly string[]): SessionMeta[] {
  const rank = (m: SessionMeta): number =>
    (openIds.includes(m.sessionId) ? 2 : 0) + (hasContent(m) ? 1 : 0);
  // An open session with no log yet has no timestamp; treat it as current so it
  // does not sink below older entries in its group.
  const weight = (m: SessionMeta): number =>
    m.updatedAt ?? (openIds.includes(m.sessionId) ? Date.now() : 0);
  return [...rootsOnly(metas)].sort((a, b) => rank(b) - rank(a) || weight(b) - weight(a));
}
