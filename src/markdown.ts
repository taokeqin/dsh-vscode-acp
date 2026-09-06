// src/markdown.ts — a small Markdown subset, parsed to a node tree.
//
// Parsing happens in the extension host and only the tree crosses into the webview,
// which builds DOM from it. That is deliberate: everything here is agent output, so
// no HTML string is ever produced, let alone assigned to innerHTML. The webview can
// only create the element kinds this file names.
//
// The subset covers what a coding agent actually emits: headings, fenced code,
// lists, blockquotes, rules, paragraphs, and inline code/bold/italic/links.
// Anything unrecognised stays literal text rather than being silently dropped.

/** Inline run inside a block. */
export type Inline =
  | { t: 'text'; v: string }
  | { t: 'code'; v: string }
  | { t: 'strong'; v: Inline[] }
  | { t: 'em'; v: Inline[] }
  | { t: 'link'; v: Inline[]; href: string }
  /**
   * A file reference the host confirmed exists in the workspace. Never produced by
   * the parser — decorateFileRefs rewrites `code` nodes into these, because only the
   * host can check the filesystem.
   */
  | { t: 'file'; v: string; path: string; line?: number; endLine?: number };

/** Top-level block. */
export type Block =
  | { t: 'p'; v: Inline[] }
  | { t: 'h'; level: number; v: Inline[] }
  | { t: 'code'; lang: string; v: string }
  | { t: 'ul'; items: Inline[][] }
  | { t: 'ol'; items: Inline[][]; start: number }
  | { t: 'quote'; v: Inline[] }
  | { t: 'hr' }
  | {
      t: 'table';
      head: Inline[][];
      rows: Inline[][][];
      /** Per-column alignment from the delimiter row; null means unspecified. */
      align: (Align | null)[];
    };

export type Align = 'left' | 'center' | 'right';

/**
 * Splits a table row into cells.
 *
 * GFM makes the outer pipes optional, and `\|` escapes a literal pipe inside a
 * cell — without handling that, a cell containing a pipe silently becomes two.
 */
function splitRow(line: string): string[] {
  const cells: string[] = [];
  let cur = '';
  let i = 0;
  const body = line.trim().replace(/^\|/, '').replace(/\|$/, '');
  while (i < body.length) {
    const ch = body[i];
    if (ch === '\\' && body[i + 1] === '|') {
      cur += '|';
      i += 2;
      continue;
    }
    if (ch === '|') {
      cells.push(cur.trim());
      cur = '';
      i++;
      continue;
    }
    cur += ch;
    i++;
  }
  cells.push(cur.trim());
  return cells;
}

/**
 * Reads the delimiter row that makes a table a table: `|---|:--:|---:|`.
 * Returns per-column alignment, or null when the line is not a delimiter row.
 */
function parseDelimiter(line: string): (Align | null)[] | null {
  const cells = splitRow(line);
  if (cells.length === 0) return null;
  const align: (Align | null)[] = [];
  for (const cell of cells) {
    const m = /^(:?)-{1,}(:?)$/.exec(cell.replace(/\s+/g, ''));
    if (!m) return null;
    align.push(m[1] && m[2] ? 'center' : m[2] ? 'right' : m[1] ? 'left' : null);
  }
  return align;
}

/** Only these schemes become links; anything else stays literal text. */
const SAFE_LINK = /^https?:\/\//i;

/**
 * Splits inline markup.
 *
 * Code spans bind tightest and are extracted first, so `**` inside backticks stays
 * literal — otherwise a snippet like `a ** b` would turn half the message bold.
 */
export function parseInline(src: string): Inline[] {
  const out: Inline[] = [];
  let rest = src;

  while (rest !== '') {
    // Inline code: the earliest backtick run wins, and its content is never re-parsed.
    const code = /`([^`\n]+)`/.exec(rest);
    const strong = /(\*\*|__)(?=\S)([\s\S]*?\S)\1/.exec(rest);
    const em = /(?<![*\w])(\*|_)(?=\S)([^*_\n]*?\S)\1(?![*\w])/.exec(rest);
    const link = /\[([^\]\n]*)\]\(([^)\s]+)\)/.exec(rest);

    const candidates = [code, strong, em, link].filter((m): m is RegExpExecArray => m !== null);
    if (candidates.length === 0) break;
    const first = candidates.reduce((a, b) => (a.index <= b.index ? a : b));

    if (first.index > 0) out.push({ t: 'text', v: rest.slice(0, first.index) });

    if (first === code) {
      out.push({ t: 'code', v: first[1] });
    } else if (first === strong) {
      out.push({ t: 'strong', v: parseInline(first[2]) });
    } else if (first === em) {
      out.push({ t: 'em', v: parseInline(first[2]) });
    } else {
      const href = first[2];
      const label = first[1] === '' ? href : first[1];
      // An unsafe scheme degrades to the literal source rather than a dead link.
      if (SAFE_LINK.test(href)) out.push({ t: 'link', v: parseInline(label), href });
      else out.push({ t: 'text', v: first[0] });
    }
    rest = rest.slice(first.index + first[0].length);
  }

  if (rest !== '') out.push({ t: 'text', v: rest });
  return out.length === 0 ? [{ t: 'text', v: '' }] : out;
}

/** Parses a Markdown document into blocks. */
export function parseMarkdown(src: string): Block[] {
  const text = typeof src === 'string' ? src : '';
  const lines = text.replace(/\r\n?/g, '\n').split('\n');
  const blocks: Block[] = [];
  let i = 0;

  /** Collects consecutive lines while they satisfy `pred`. */
  const take = (pred: (l: string) => boolean): string[] => {
    const acc: string[] = [];
    while (i < lines.length && pred(lines[i])) acc.push(lines[i++]);
    return acc;
  };

  while (i < lines.length) {
    const line = lines[i];

    if (line.trim() === '') {
      i++;
      continue;
    }

    // Fenced code. An unterminated fence still closes at end of input, which matters
    // while a message is still streaming in.
    const fence = /^\s*(`{3,}|~{3,})\s*(\S*)/.exec(line);
    if (fence) {
      const marker = fence[1][0];
      i++;
      const body: string[] = [];
      while (i < lines.length && !new RegExp(`^\\s*${marker}{3,}\\s*$`).test(lines[i])) body.push(lines[i++]);
      if (i < lines.length) i++; // consume the closing fence
      blocks.push({ t: 'code', lang: fence[2] ?? '', v: body.join('\n') });
      continue;
    }

    const heading = /^(#{1,6})\s+(.*)$/.exec(line);
    if (heading) {
      blocks.push({ t: 'h', level: heading[1].length, v: parseInline(heading[2].trim()) });
      i++;
      continue;
    }

    if (/^\s*([-*_])\1{2,}\s*$/.test(line) || /^\s*(-\s*){3,}$/.test(line)) {
      blocks.push({ t: 'hr' });
      i++;
      continue;
    }

    if (/^\s*>\s?/.test(line)) {
      const quoted = take((l) => /^\s*>\s?/.test(l)).map((l) => l.replace(/^\s*>\s?/, ''));
      blocks.push({ t: 'quote', v: parseInline(quoted.join('\n')) });
      continue;
    }

    if (/^\s*[-*+]\s+/.test(line)) {
      const items = take((l) => /^\s*[-*+]\s+/.test(l)).map((l) => parseInline(l.replace(/^\s*[-*+]\s+/, '')));
      blocks.push({ t: 'ul', items });
      continue;
    }

    const ordered = /^\s*(\d+)[.)]\s+/.exec(line);
    if (ordered) {
      const items = take((l) => /^\s*\d+[.)]\s+/.test(l)).map((l) => parseInline(l.replace(/^\s*\d+[.)]\s+/, '')));
      blocks.push({ t: 'ol', items, start: Number(ordered[1]) });
      continue;
    }

    // Table: a header row followed by a delimiter row. Checked before the paragraph
    // branch, which would otherwise swallow it as pipe-laden prose.
    if (line.includes('|') && i + 1 < lines.length) {
      const align = parseDelimiter(lines[i + 1]);
      if (align !== null) {
        const head = splitRow(line).map((c) => parseInline(c));
        i += 2;
        const rows: Inline[][][] = [];
        while (i < lines.length && lines[i].trim() !== '' && lines[i].includes('|')) {
          const cells = splitRow(lines[i++]);
          // Normalise to the header width: GFM drops extra cells and pads short rows,
          // and an uneven row would otherwise break the column grid.
          const row: Inline[][] = [];
          for (let c = 0; c < head.length; c++) row.push(parseInline(cells[c] ?? ''));
          rows.push(row);
        }
        blocks.push({ t: 'table', head, rows, align });
        continue;
      }
    }

    // Paragraph: run to the next blank line or block starter, joined with newlines
    // so soft wrapping is preserved.
    const starts = (l: string): boolean =>
      l.trim() === '' ||
      /^\s*(`{3,}|~{3,})/.test(l) ||
      /^#{1,6}\s/.test(l) ||
      /^\s*>/.test(l) ||
      /^\s*[-*+]\s+/.test(l) ||
      /^\s*\d+[.)]\s+/.test(l) ||
      parseDelimiter(l) !== null; // a delimiter row means the line above was a header
    const para: string[] = [];
    while (i < lines.length && !starts(lines[i])) {
      // A header row is only a header if a delimiter row follows; stop before it so
      // the table branch gets both lines.
      if (lines[i].includes('|') && i + 1 < lines.length && parseDelimiter(lines[i + 1]) !== null) break;
      para.push(lines[i++]);
    }
    if (para.length === 0) { i++; continue; }
    blocks.push({ t: 'p', v: parseInline(para.join('\n')) });
  }

  return blocks;
}

/** Plain-text rendering, for one-line previews such as a collapsed thought summary. */
export function inlineToText(nodes: Inline[]): string {
  return nodes
    .map((n) => (n.t === 'text' || n.t === 'code' || n.t === 'file' ? n.v : inlineToText(n.v)))
    .join('');
}
