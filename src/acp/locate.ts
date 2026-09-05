// src/acp/locate.ts — finds the dsh executable.
//
// WHY THIS IS NOT JUST spawn('dsh')
// A GUI-launched VS Code inherits the system PATH, not the shell's. On this machine
// that is `/usr/gnu/bin:/usr/local/bin:/bin:/usr/bin:.` while dsh lives under
// `~/.nvm/versions/node/<ver>/bin` — so a bare spawn fails with ENOENT even though
// `which dsh` works in any terminal. Version managers (nvm, fnm, volta, asdf) all
// put their shims outside the default PATH, so this affects most Node installs.
//
// Strategy, cheapest first: explicit setting → process PATH → well-known roots →
// the login shell's own PATH. Only the last one spawns anything.
import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

/** Result of a lookup: the path plus how it was found, for logging. */
export interface LocateResult {
  path: string;
  via: 'setting' | 'PATH' | 'well-known' | 'login-shell';
}

export interface LocateDeps {
  exists(p: string): boolean;
  readdir(p: string): string[];
  /** Runs the login shell and returns its stdout; throws on failure. */
  loginShell(shell: string, script: string): string;
  env: NodeJS.ProcessEnv;
  home: string;
}

export function nodeLocateDeps(): LocateDeps {
  return {
    exists: (p) => existsSync(p),
    readdir: (p) => readdirSync(p),
    loginShell: (shell, script) =>
      execFileSync(shell, ['-lic', script], {
        encoding: 'utf8',
        // An interactive login shell can hang on a misbehaving rc file; cap it.
        timeout: 5000,
        stdio: ['ignore', 'pipe', 'ignore'],
      }),
    env: process.env,
    home: homedir(),
  };
}

/** Is this a runnable file? */
function isFile(p: string, deps: LocateDeps): boolean {
  if (!deps.exists(p)) return false;
  try {
    return statSync(p).isFile();
  } catch {
    return false;
  }
}

/** Directories a Node version manager or package manager is likely to use. */
function wellKnownDirs(deps: LocateDeps): string[] {
  const dirs: string[] = [];
  // Every installed nvm version, newest last so the loop below prefers later ones.
  const nvmRoot = join(deps.home, '.nvm', 'versions', 'node');
  try {
    for (const version of deps.readdir(nvmRoot).sort()) dirs.push(join(nvmRoot, version, 'bin'));
  } catch {
    // No nvm on this machine.
  }
  dirs.push(
    join(deps.home, '.volta', 'bin'),
    join(deps.home, '.local', 'share', 'fnm', 'aliases', 'default', 'bin'),
    join(deps.home, '.asdf', 'shims'),
    join(deps.home, '.bun', 'bin'),
    '/opt/homebrew/bin',
    '/usr/local/bin',
    join(deps.home, '.npm-global', 'bin'),
    join(deps.home, 'node_modules', '.bin'),
  );
  return dirs;
}

/**
 * Locates the dsh executable.
 *
 * @param configured `dshAgent.executablePath`; an absolute path wins outright,
 *   a bare name is treated as the command to search for.
 * @returns the resolution, or null when nothing was found.
 */
export function locateDsh(configured: string, deps: LocateDeps = nodeLocateDeps()): LocateResult | null {
  const name = configured.trim() === '' ? 'dsh' : configured.trim();

  // 1. An explicit path from settings is authoritative — never second-guess it.
  if (name.includes('/')) {
    return isFile(name, deps) ? { path: name, via: 'setting' } : null;
  }

  // 2. The process PATH. Works when VS Code was launched from a terminal.
  for (const dir of (deps.env.PATH ?? '').split(':')) {
    if (dir === '') continue;
    const candidate = join(dir, name);
    if (isFile(candidate, deps)) return { path: candidate, via: 'PATH' };
  }

  // 3. Version-manager and package-manager directories. Pure filesystem checks, so
  //    this stays fast and is preferred over spawning a shell. Later entries win,
  //    which for nvm means the newest installed version.
  let wellKnown: string | null = null;
  for (const dir of wellKnownDirs(deps)) {
    const candidate = join(dir, name);
    if (isFile(candidate, deps)) wellKnown = candidate;
  }
  if (wellKnown !== null) return { path: wellKnown, via: 'well-known' };

  // 4. Last resort: ask the user's login shell where it is. This is the only branch
  //    that spawns a process, and it is the only one that can see a PATH built by an
  //    rc file we do not know about.
  const shell = deps.env.SHELL;
  if (shell) {
    try {
      const out = deps.loginShell(shell, `command -v ${name}`);
      // An interactive shell may print banners; the path is the last non-empty line.
      const line = out.split('\n').map((l) => l.trim()).filter((l) => l.startsWith('/')).pop();
      if (line && isFile(line, deps)) return { path: line, via: 'login-shell' };
    } catch {
      // A missing, slow, or noisy shell just means this strategy found nothing.
    }
  }
  return null;
}

/**
 * Builds the PATH the agent child needs.
 *
 * Finding the dsh file is only half the problem: dsh is a Node CLI whose shebang is
 * `#!/usr/bin/env node`, so it resolves `node` through its OWN PATH at exec time.
 * Handing it the inherited system PATH reproduces the same failure one level down —
 * `env: node: No such file or directory`, exit 127 — because the version manager's
 * node is no more visible to the child than dsh was to us.
 *
 * Prepending the directory dsh was found in normally fixes it outright: for nvm,
 * fnm, volta and homebrew, `node` sits right next to `dsh`. When it does not (a
 * global npm prefix separate from the runtime), the well-known directories are
 * searched for a node as well.
 */
export function childPathFor(dshPath: string, deps: LocateDeps = nodeLocateDeps()): string {
  const dshDir = dirname(dshPath);
  const dirs = [dshDir];
  if (!isFile(join(dshDir, 'node'), deps)) {
    // Later entries in wellKnownDirs are newer nvm versions, so search from the end.
    const nodeDir = [...wellKnownDirs(deps)].reverse().find((d) => isFile(join(d, 'node'), deps));
    if (nodeDir) dirs.push(nodeDir);
  }
  const inherited = deps.env.PATH ?? '';
  return [...dirs, inherited].filter((p) => p !== '').join(':');
}

/** Actionable message for the failure case, naming the setting to fix it. */
export function notFoundMessage(configured: string): string {
  const what = configured.trim() === '' ? '"dsh"' : `"${configured.trim()}"`;
  return (
    `DSH: could not find ${what}. VS Code launched from the Dock does not inherit your ` +
    'shell PATH, so a version-manager install (nvm, fnm, volta, asdf) is invisible to it. ' +
    'Set "dshAgent.executablePath" to the absolute path from `which dsh`.'
  );
}
