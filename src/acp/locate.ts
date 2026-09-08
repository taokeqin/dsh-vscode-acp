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
import { delimiter, posix, win32 } from 'node:path';

/** Result of a lookup: the path plus how it was found, for logging. */
export interface LocateResult {
  path: string;
  via: 'setting' | 'PATH' | 'well-known' | 'login-shell';
}

export interface LocateDeps {
  /**
   * True when the path is an existing, runnable *file*.
   *
   * The whole check lives behind the injection point on purpose: an earlier version
   * consulted this and then called the real `statSync` anyway, which silently
   * bypassed the injection and made the Windows branches untestable.
   */
  exists(p: string): boolean;
  readdir(p: string): string[];
  /** Runs the login shell and returns its stdout; throws on failure. */
  loginShell(shell: string, script: string): string;
  env: NodeJS.ProcessEnv;
  home: string;
  /** `process.platform`, injected so the Windows branches are testable off Windows. */
  platform: string;
  /** PATH separator for the target platform (`;` on Windows, `:` elsewhere). */
  pathSep: string;
}

export function nodeLocateDeps(): LocateDeps {
  return {
    exists: (p) => {
      try {
        return existsSync(p) && statSync(p).isFile();
      } catch {
        return false;
      }
    },
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
    platform: process.platform,
    pathSep: delimiter,
  };
}

/**
 * The path flavour for the target platform.
 *
 * Selected rather than implied: Node's default `path` follows the *host*, so joining
 * a Windows path on macOS yields `C:\\dir/file` and `dirname` does not recognise a
 * backslash at all. Choosing explicitly makes the Windows branches both correct on
 * Windows and exercisable from anywhere.
 */
function paths(deps: LocateDeps): typeof win32 {
  return deps.platform === 'win32' ? win32 : (posix as unknown as typeof win32);
}

/** Is this a runnable file? Delegated entirely, so injection is complete. */
function isFile(p: string, deps: LocateDeps): boolean {
  return deps.exists(p);
}

/**
 * Candidate names for the executable.
 *
 * On Windows an npm-installed CLI ships a `.cmd` shim (plus a `.ps1` and a shell
 * script), so a bare name finds nothing. A real `.exe` is preferred when present:
 * unlike `.cmd`/`.bat` it needs no cmd.exe layer to run. Order matters only in that
 * the first hit wins.
 */
function candidateNames(name: string, deps: LocateDeps): string[] {
  if (deps.platform !== 'win32') return [name];
  return [`${name}.exe`, `${name}.cmd`, `${name}.bat`, name];
}

/**
 * Directories a Node version manager or package manager is likely to use.
 *
 * Split by platform: the POSIX list was written against this machine and would find
 * nothing on Windows, where the equivalents live under APPDATA and the version
 * managers use different layouts. The Windows entries are derived from those tools'
 * documented locations and are NOT verified here — no Windows host was available.
 */
function wellKnownDirs(deps: LocateDeps): string[] {
  const p = paths(deps);
  const dirs: string[] = [];
  if (deps.platform === 'win32') {
    const appData = deps.env.APPDATA ?? p.join(deps.home, 'AppData', 'Roaming');
    const localAppData = deps.env.LOCALAPPDATA ?? p.join(deps.home, 'AppData', 'Local');
    // nvm-windows keeps each version in its own directory with node.exe at the root.
    const nvmWin = deps.env.NVM_HOME ?? p.join(appData, 'nvm');
    try {
      for (const version of deps.readdir(nvmWin).sort()) dirs.push(p.join(nvmWin, version));
    } catch {
      // No nvm-windows.
    }
    dirs.push(
      p.join(appData, 'npm'),
      p.join(localAppData, 'Volta', 'bin'),
      p.join(localAppData, 'fnm_multishells'),
      p.join(deps.home, 'scoop', 'shims'),
      p.join(deps.home, '.bun', 'bin'),
    );
    return dirs;
  }
  // Every installed nvm version, newest last so the loop below prefers later ones.
  const nvmRoot = p.join(deps.home, '.nvm', 'versions', 'node');
  try {
    for (const version of deps.readdir(nvmRoot).sort()) dirs.push(p.join(nvmRoot, version, 'bin'));
  } catch {
    // No nvm on this machine.
  }
  dirs.push(
    p.join(deps.home, '.volta', 'bin'),
    p.join(deps.home, '.local', 'share', 'fnm', 'aliases', 'default', 'bin'),
    p.join(deps.home, '.asdf', 'shims'),
    p.join(deps.home, '.bun', 'bin'),
    '/opt/homebrew/bin',
    '/usr/local/bin',
    p.join(deps.home, '.npm-global', 'bin'),
    p.join(deps.home, 'node_modules', '.bin'),
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
  //    Either separator counts: a Windows setting uses backslashes.
  if (name.includes('/') || name.includes('\\')) {
    return isFile(name, deps) ? { path: name, via: 'setting' } : null;
  }

  // 2. The process PATH. Works when VS Code was launched from a terminal.
  //    The separator is platform-specific: ';' on Windows, not ':'.
  for (const dir of (deps.env.PATH ?? '').split(deps.pathSep)) {
    if (dir === '') continue;
    for (const candidate of candidateNames(name, deps)) {
      const full = paths(deps).join(dir, candidate);
      if (isFile(full, deps)) return { path: full, via: 'PATH' };
    }
  }

  // 3. Version-manager and package-manager directories. Pure filesystem checks, so
  //    this stays fast and is preferred over spawning a shell. Later entries win,
  //    which for nvm means the newest installed version.
  let wellKnown: string | null = null;
  for (const dir of wellKnownDirs(deps)) {
    for (const candidate of candidateNames(name, deps)) {
      const full = paths(deps).join(dir, candidate);
      if (isFile(full, deps)) wellKnown = full;
    }
  }
  if (wellKnown !== null) return { path: wellKnown, via: 'well-known' };

  // 4. Last resort: ask the user's login shell where it is. This is the only branch
  //    that spawns a process, and it is the only one that can see a PATH built by an
  //    rc file we do not know about. POSIX only: the -lic form and `command -v` are
  //    shell features Windows has no equivalent of.
  const shell = deps.platform === 'win32' ? undefined : deps.env.SHELL;
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
  const p = paths(deps);
  const dshDir = p.dirname(dshPath);
  const dirs = [dshDir];
  const nodeName = deps.platform === 'win32' ? 'node.exe' : 'node';
  if (!isFile(p.join(dshDir, nodeName), deps)) {
    // Later entries in wellKnownDirs are newer nvm versions, so search from the end.
    const nodeDir = [...wellKnownDirs(deps)].reverse().find((d) => isFile(p.join(d, nodeName), deps));
    if (nodeDir) dirs.push(nodeDir);
  }
  const inherited = deps.env.PATH ?? '';
  return [...dirs, inherited].filter((p) => p !== '').join(deps.pathSep);
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
