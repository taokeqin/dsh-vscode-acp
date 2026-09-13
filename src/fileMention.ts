// src/fileMention.ts — writing a workspace file as a `@path` prompt mention.
//
// dsh's own UIs add a file to a request by inserting an `@path` token as ordinary
// prompt text, not by attaching the file: a host completion menu picks a path, the
// model then reads it with its filesystem tool (see `@deepseek-ai/dsh-file-reference`,
// which owns the grammar `@path` / `@"path with spaces"`). ACP cannot carry the
// content itself any other way — dsh advertises `promptCapabilities.embeddedContext:
// false` and rejects an embedded `resource` block — so this is the representation the
// harness actually understands.
//
// Kept as pure string handling, with no vscode import, so the grammar is testable.

/** Longest path this will mention; longer ones are almost certainly prose, not files. */
const MAX = 400;

/**
 * Formats a workspace-relative path as the `@path` mention dsh parses.
 *
 * Whitespace switches to the quoted `@"path"` spelling. Paths the grammar cannot
 * represent — empty, over-long, or carrying a control character or a double quote —
 * return null rather than producing a token that would parse back as something else.
 */
export function formatFileMention(relPath: string): string | null {
  const p = typeof relPath === 'string' ? relPath.trim() : '';
  if (p === '' || p.length > MAX) return null;
  if (/[\u0000-\u001f\u007f-\u009f"]/u.test(p)) return null;
  return /\s/u.test(p) ? `@"${p}"` : `@${p}`;
}
