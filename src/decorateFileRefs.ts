// src/decorateFileRefs.ts — turns code spans that name a real file into references.
//
// Runs in the extension host, which is the only side that can check the filesystem.
// Doing it here rather than in the webview is what keeps precision high: a span is
// decorated only when the path actually resolves inside the workspace, so prose is
// never dressed up as a link that then fails on click.
import { isAbsolute, relative, resolve } from 'node:path';
import { parseFileRef } from './fileRef';
import type { Block, Inline } from './markdown';

export interface RefDeps {
  workspaceRoot: string;
  /** Existence check, injected so the rules can be tested without a filesystem. */
  exists(absPath: string): boolean;
}

/**
 * Resolves a reference against the workspace.
 *
 * Confined on purpose: agent output can name any path, and only files inside the
 * project are worth linking — the same boundary the open handler enforces.
 *
 * The same rule decides tool rows. Agents legitimately read outside the workspace
 * (skills, configs), and those rows are left unclickable rather than clickable and
 * then refused: a dead link is worse than plain text.
 */
export function resolveInWorkspace(path: string, deps: RefDeps): string | null {
  const abs = isAbsolute(path) ? path : resolve(deps.workspaceRoot, path);
  const rel = relative(deps.workspaceRoot, abs);
  if (rel.startsWith('..') || isAbsolute(rel)) return null;
  return deps.exists(abs) ? abs : null;
}

/** Rewrites one inline node tree, converting confirmed code spans into file refs. */
function decorateInline(nodes: Inline[], deps: RefDeps): Inline[] {
  return nodes.map((n): Inline => {
    if (n.t === 'code') {
      const ref = parseFileRef(n.v);
      if (ref && resolveInWorkspace(ref.path, deps) !== null) {
        return {
          t: 'file',
          v: n.v,
          path: ref.path,
          ...(ref.line === undefined ? {} : { line: ref.line }),
          ...(ref.endLine === undefined ? {} : { endLine: ref.endLine }),
        };
      }
      return n;
    }
    // Links keep their own behaviour; only their labels are walked.
    if (n.t === 'strong' || n.t === 'em') return { t: n.t, v: decorateInline(n.v, deps) };
    if (n.t === 'link') return { ...n, v: decorateInline(n.v, deps) };
    return n;
  });
}

/**
 * Walks a parsed document and decorates file references.
 *
 * Fenced code blocks are left alone: their contents are source, not prose, and
 * linking words inside a snippet would be noise.
 */
export function decorateFileRefs(blocks: Block[], deps: RefDeps): Block[] {
  return blocks.map((b): Block => {
    if (b.t === 'code' || b.t === 'hr') return b;
    if (b.t === 'ul') return { t: 'ul', items: b.items.map((i) => decorateInline(i, deps)) };
    if (b.t === 'ol') return { ...b, items: b.items.map((i) => decorateInline(i, deps)) };
    if (b.t === 'h') return { ...b, v: decorateInline(b.v, deps) };
    if (b.t === 'p' || b.t === 'quote') return { t: b.t, v: decorateInline(b.v, deps) };
    return b;
  });
}
