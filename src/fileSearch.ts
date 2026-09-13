// src/fileSearch.ts — ranking workspace files for the composer's `@` menu.
//
// The host keeps one workspace path index and answers each typed query with the best
// few matches, so the whole tree never crosses to the webview. Pure and vscode-free,
// so the ranking is exercised directly by the tests.

/** Whether every character of `needle` appears in `hay`, in order. */
function isSubsequence(needle: string, hay: string): boolean {
  let i = 0;
  for (let j = 0; j < hay.length && i < needle.length; j++) {
    if (hay[j] === needle[i]) i++;
  }
  return i === needle.length;
}

/** Lower is better; null means the path does not match the query. */
function score(path: string, q: string): number | null {
  if (q === '') return 0;
  const lower = path.toLowerCase();
  const base = lower.slice(lower.lastIndexOf('/') + 1);
  if (base.startsWith(q)) return 0;
  if (base.includes(q)) return 1;
  if (lower.includes(q)) return 2;
  return isSubsequence(q, lower) ? 3 : null;
}

export interface RankOptions {
  limit?: number;
  /** Workspace-relative path of the file in the active editor, if any. */
  active?: string | null;
}

/**
 * The best matches for `query`, best first.
 *
 * Ranking is basename-prefix, basename-substring, path-substring, then subsequence —
 * so `@conn` finds `connection.ts` before a file that merely contains "conn". The
 * active editor's file wins ties and heads the empty-query list, which is what makes
 * "@ then the file I am already looking at" the first row.
 */
export function rankFiles(
  files: readonly string[],
  query: string,
  options: RankOptions = {},
): string[] {
  const q = query.trim().toLowerCase();
  const active = options.active ?? null;
  const scored: { path: string; score: number; isActive: boolean }[] = [];
  for (const path of files) {
    const s = score(path, q);
    if (s !== null) scored.push({ path, score: s, isActive: path === active });
  }
  scored.sort((a, b) => {
    if (a.isActive !== b.isActive) return a.isActive ? -1 : 1;
    if (a.score !== b.score) return a.score - b.score;
    if (a.path.length !== b.path.length) return a.path.length - b.path.length;
    return a.path < b.path ? -1 : a.path > b.path ? 1 : 0;
  });
  return scored.slice(0, options.limit ?? 50).map((s) => s.path);
}
