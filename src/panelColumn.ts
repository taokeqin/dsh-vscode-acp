// src/panelColumn.ts — which editor column a new session tab opens in.
//
// Pure and vscode-free (columns are plain numbers here) so the rule can be tested.
// It exists because `Beside` alone gets this wrong: it means "next to whatever is
// active", so opening a session while a session tab was focused split the editor
// into a new group every single time instead of adding a tab to the existing one.

/** Where to open, and whether it joins a group that already holds sessions. */
export interface ColumnChoice {
  column: number;
  /**
   * True when an existing session group is being reused. The caller uses this to
   * decide whether to lock the group: locking is a one-time act when the group is
   * first created, not something to repeat for every tab added to it.
   */
  reused: boolean;
}

/**
 * @param activeSessionColumn column of the focused session tab, if one is focused
 * @param openSessionColumns  columns of all other open session tabs
 * @param configured          fallback when no session tab is open (dshAgent.panelColumn)
 */
export function pickSessionColumn(
  activeSessionColumn: number | undefined,
  openSessionColumns: readonly (number | undefined)[],
  configured: number,
): ColumnChoice {
  // Sessions belong together: join the group the user is already looking at.
  if (activeSessionColumn !== undefined) return { column: activeSessionColumn, reused: true };
  // Otherwise any open session tab's group. A hidden panel reports no column, so
  // skip those rather than guessing at one.
  const known = openSessionColumns.find((c) => c !== undefined);
  if (known !== undefined) return { column: known, reused: true };
  // Nothing open yet: this is the first session tab, so honour the setting.
  return { column: configured, reused: false };
}
