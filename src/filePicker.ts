// src/filePicker.ts — the workspace file list used to add files to a conversation.
//
// A QuickPick over `workspace.findFiles`, not an editor picker: it is the same list
// and filtering as Cmd/Ctrl+P, it returns to the composer without a round trip
// through the OS dialog, and it can be multi-select. The result is workspace-relative
// paths, ready to be written as `@path` mentions (see fileMention.ts).
import * as path from 'node:path';
import * as vscode from 'vscode';

/** Refuses to build an unbounded list; a huge monorepo stops here rather than hanging. */
const MAX_FILES = 20000;

interface FileItem extends vscode.QuickPickItem {
  rel: string;
}

/** Workspace-relative, forward-slashed path, or null when it escapes the workspace. */
export function relativeWorkspacePath(root: string, file: string): string | null {
  const rel = path.relative(root, file);
  // On Windows a file on another drive comes back absolute rather than as `..`
  // segments, so test the raw result before normalising the separators.
  if (rel === '' || path.isAbsolute(rel)) return null;
  const slash = rel.split(path.sep).join('/');
  if (slash === '..' || slash.startsWith('../')) return null;
  return slash;
}

/**
 * Every workspace file, workspace-relative and sorted. This is the shared index behind
 * both the QuickPick and the composer's `@` menu.
 *
 * `exclude` is left undefined on purpose: `findFiles` then honours the user's
 * `files.exclude` and `search.exclude`, so ignored trees (node_modules, out, .git)
 * never reach the list.
 */
export async function listWorkspaceFiles(root: string): Promise<string[]> {
  const uris = await vscode.workspace.findFiles('**/*', undefined, MAX_FILES);
  const rels: string[] = [];
  for (const uri of uris) {
    if (uri.scheme !== 'file') continue;
    const rel = relativeWorkspacePath(root, uri.fsPath);
    if (rel !== null) rels.push(rel);
  }
  rels.sort((a, b) => a.localeCompare(b));
  return rels;
}

/** Shows the workspace file list and returns the paths the user picked. */
export async function pickWorkspaceFiles(root: string): Promise<string[]> {
  const rels = await listWorkspaceFiles(root);
  const items: FileItem[] = rels.map((rel) => {
    const dir = path.posix.dirname(rel);
    return { label: path.posix.basename(rel), description: dir === '.' ? '' : dir, rel };
  });
  const truncated = rels.length >= MAX_FILES;
  const picked = await vscode.window.showQuickPick(items, {
    canPickMany: true,
    matchOnDescription: true,
    title: 'Add files to the DSH conversation',
    placeHolder: truncated
      ? `First ${MAX_FILES} workspace files — type to filter, then pick one or more`
      : 'Type to filter, then pick one or more files (adds @path mentions)',
  });
  return picked === undefined ? [] : picked.map((p) => p.rel);
}

