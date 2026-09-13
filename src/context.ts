// src/context.ts — the context carried alongside the next prompt.
//
// dsh's ACP surface accepts a single string prompt, so "attachments" are never sent
// as objects. A file never travels as content: it becomes the harness's own `@path`
// mention, and the agent reads it with its filesystem tool — the file on disk is the
// only authoritative version, and how much of it matters is the agent's call (dsh and
// Claude both work this way). A selection is the one thing this client does inline,
// because the user pointed at that exact text and it cannot be re-derived from a path.
// Both are prepended to the message text here — pure, no vscode import — so the exact
// wire shape is testable.
import { formatFileMention } from './fileMention';

export interface FileContext {
  kind: 'file';
  /** Workspace-relative path. */
  path: string;
  enabled: boolean;
}

export interface SelectionContext {
  kind: 'selection';
  path: string;
  line: number;
  endLine: number;
  /** Editor language id, reused as the code-fence info string. */
  lang: string;
  text: string;
  enabled: boolean;
}

export type ContextItem = FileContext | SelectionContext;

/**
 * Stable identity.
 *
 * A file is keyed by path. A selection is keyed by path too, on purpose: the editor's
 * current selection is one live thing, so moving it updates that file's selection chip
 * instead of piling up a new chip per range.
 */
export function contextKey(c: ContextItem): string {
  return c.kind === 'file' ? `file:${c.path}` : `sel:${c.path}`;
}

/** One-line label for the composer chip. */
export function contextLabel(c: ContextItem): string {
  if (c.kind === 'file') return formatFileMention(c.path) ?? c.path;
  return `${c.path}:${c.line}-${c.endLine}`;
}

/** What one selection contributes — the same shape Send Selection already sends. */
export function selectionText(c: SelectionContext): string {
  return `${c.path}:${c.line}-${c.endLine}\n\n\`\`\`${c.lang}\n${c.text}\n\`\`\`\n`;
}

/**
 * Prepends the enabled context to the prompt: `@path` mentions first, then the
 * selection blocks in the order attached. Disabled chips contribute nothing.
 */
export function withContext(items: ContextItem[], text: string): string {
  const mentions: string[] = [];
  const blocks: string[] = [];
  for (const c of items) {
    if (!c.enabled) continue;
    if (c.kind === 'file') {
      const mention = formatFileMention(c.path);
      if (mention !== null) mentions.push(mention);
    } else {
      blocks.push(selectionText(c));
    }
  }
  const head = [mentions.join(' '), ...blocks].filter((s) => s !== '').join('\n');
  return head === '' ? text : `${head}\n${text}`;
}
