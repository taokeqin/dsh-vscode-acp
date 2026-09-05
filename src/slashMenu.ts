// src/slashMenu.ts — when the composer's slash menu opens, and what it offers.
//
// These run inside the webview, but they are defined here and injected into the
// panel script via `Function.prototype.toString()`, so exactly one implementation
// exists: the tested one is the shipped one. Anything touching the DOM stays in the
// script; only decisions live here.

/** Where a slash trigger starts, and what has been typed after it. */
export interface SlashTrigger {
  query: string;
  /** Caret offset of the '/' itself, so accepting can replace from there. */
  from: number;
}

/**
 * Detects a slash trigger at the caret.
 *
 * The slash must open a line. Requiring that keeps ordinary prose — a path like
 * `src/x.ts`, or "and/or" — from popping the menu mid-sentence, which is the whole
 * reason it is not simply "the last token starts with /".
 */
export function slashTrigger(value: string, caret: number): SlashTrigger | null {
  const pos = Math.max(0, Math.min(caret, value.length));
  const before = value.slice(0, pos);
  const lineStart = before.lastIndexOf('\n') + 1;
  const line = before.slice(lineStart);
  const m = /^\/([\w-]*)$/.exec(line);
  return m ? { query: m[1], from: lineStart } : null;
}

/** Skills whose name matches what has been typed, case-insensitively. */
export function filterSkills<T extends { name: string }>(skills: readonly T[], query: string): T[] {
  const q = query.toLowerCase();
  if (q === '') return [...skills];
  // Prefix matches first: typing "lo" should put "longbridge" above a skill that
  // merely contains "lo" somewhere in the middle.
  const starts = skills.filter((s) => s.name.toLowerCase().startsWith(q));
  const contains = skills.filter(
    (s) => !s.name.toLowerCase().startsWith(q) && s.name.toLowerCase().includes(q),
  );
  return [...starts, ...contains];
}
