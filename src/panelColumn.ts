// src/panelColumn.ts — which editor column a new session tab opens in.
//
// Pure and vscode-free (columns are plain numbers here) so the rule can be tested.
// It exists because `Beside` alone gets this wrong: it means "next to whatever is
// active", so opening a session while a session tab was focused split the editor
// into a new group every single time instead of adding a tab to the existing one.

/**
 * @param activeSessionColumn column of the focused session tab, if one is focused
 * @param openSessionColumns  columns of all other open session tabs
 * @param configured          fallback when no session tab is open (dshAgent.panelColumn)
 */
export function pickSessionColumn(
  activeSessionColumn: number | undefined,
  openSessionColumns: readonly (number | undefined)[],
  configured: number,
): number {
  // Sessions belong together: join the group the user is already looking at.
  if (activeSessionColumn !== undefined) return activeSessionColumn;
  // Otherwise any open session tab's group. A hidden panel reports no column, so
  // skip those rather than guessing at one.
  const known = openSessionColumns.find((c) => c !== undefined);
  if (known !== undefined) return known;
  // Nothing open yet: this is the first session tab, so honour the setting.
  return configured;
}
