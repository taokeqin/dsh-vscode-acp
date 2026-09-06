// src/fileRef.ts — recognising a file reference in agent output.
//
// Agents write locations as `src/panel/html.ts:42` or `src/panel/html.ts:42-51`,
// usually inside backticks. Turning those into links needs a parser that is strict
// on purpose: a false positive makes ordinary prose look clickable and then fails
// when clicked, which is worse than leaving it as text.
//
// Existence is checked separately, by the host, which is what keeps precision high
// without guessing here.

export interface FileRef {
  /** Path as written, workspace-relative or absolute. */
  path: string;
  /** 1-based line, when the reference carried one. */
  line?: number;
  /** End of a range such as `:42-51`. */
  endLine?: number;
}

/**
 * A reference must look like a path with a file extension, optionally followed by
 * `:line` or `:line-line`.
 *
 * The extension requirement is what excludes prose: "and/or" or "sender/receiver"
 * would otherwise read as paths. URLs are excluded by rejecting `://`, and Windows
 * drive letters are not accepted because the panel only ever opens workspace files.
 */
const REF = /^(?![a-zA-Z][a-zA-Z0-9+.-]*:\/\/)([\w@~./][\w./@+-]*\.[A-Za-z][\w]{0,9})(?::(\d{1,7})(?:[-:](\d{1,7}))?)?$/;

/** Parses a candidate token. Returns null when it is not a file reference. */
export function parseFileRef(text: string): FileRef | null {
  const raw = typeof text === 'string' ? text.trim() : '';
  if (raw === '' || raw.length > 400) return null;
  // A reference is a single token; whitespace means it is prose or a command.
  if (/\s/.test(raw)) return null;
  const m = REF.exec(raw);
  if (!m) return null;
  const ref: FileRef = { path: m[1] };
  if (m[2] !== undefined) {
    const line = Number(m[2]);
    // Line 0 is not a thing in an editor; treat it as a plain path reference.
    if (line > 0) ref.line = line;
  }
  if (m[3] !== undefined) {
    const end = Number(m[3]);
    if (ref.line !== undefined && end >= ref.line) ref.endLine = end;
  }
  return ref;
}

/**
 * Extracts the reference from a token that may carry surrounding punctuation, e.g.
 * a path at the end of a sentence. Only trailing characters that cannot belong to a
 * path are stripped.
 */
export function parseFileRefLoose(text: string): FileRef | null {
  const direct = parseFileRef(text);
  if (direct) return direct;
  const trimmed = typeof text === 'string' ? text.trim().replace(/[)\]},.;:!?'"]+$/, '') : '';
  return trimmed === '' ? null : parseFileRef(trimmed);
}
