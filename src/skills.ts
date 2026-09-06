// src/skills.ts — discovers the skills an agent can use, by reading them off disk.
//
// ACP exposes no skill surface, but dsh-skill-filesystem documents exactly where
// skills live and what they look like, so the catalog can be rebuilt independently
// of the agent. Unlike slash commands — plugin-registered handlers with no
// client-side equivalent — a skill is just a Markdown file, which is why this one is
// recoverable and commands are not.
//
// Format (from dsh-skill-filesystem): a directory bundle `<name>/SKILL.md` or a flat
// `<name>.md`, at the TOP level of a root only — nested `**/SKILL.md` is deliberately
// not discovered. YAML frontmatter requires `name` and `description`.
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { agentsHome, dshHome } from './dshHome';

export interface Skill {
  name: string;
  description: string;
  /** Which root it came from, for grouping and precedence. */
  source: string;
  path: string;
  /** `disable-model-invocation: true` keeps it out of model-facing catalogs. */
  modelInvocable: boolean;
  /** `user-invocable: false` keeps it out of human-facing surfaces. */
  userInvocable: boolean;
}

/** A scanned root, in dsh's documented rank order (lower rank wins on name clash). */
export interface SkillRoot {
  rank: number;
  source: string;
  dir: string;
}

/**
 * The default roots, mirroring dsh-skill-filesystem's table.
 *
 * @param projectRoot nearest ancestor containing `.git`, else the cwd
 * @param dshHome     `$DSH_HOME` or `~/.dsh`
 * @param agentsHome  `~/.agents`, the agent-agnostic location
 */
export function defaultSkillRoots(projectRoot: string, dshHome: string, agentsHome: string): SkillRoot[] {
  return [
    { rank: 100, source: 'project-dsh', dir: join(projectRoot, '.dsh', 'skills') },
    { rank: 200, source: 'project-agents', dir: join(projectRoot, '.agents', 'skills') },
    { rank: 400, source: 'user-dsh', dir: join(dshHome, 'skills') },
    { rank: 500, source: 'user-agents', dir: join(agentsHome, 'skills') },
  ];
}

/** Reads the documented boolean spellings; anything else is not a boolean. */
function parseBool(raw: string): boolean | null {
  const v = raw.trim().toLowerCase().replace(/^['"]|['"]$/g, '');
  if (['true', 'yes', 'on', '1'].includes(v)) return true;
  if (['false', 'no', 'off', '0'].includes(v)) return false;
  return null;
}

/**
 * Extracts the frontmatter keys we need.
 *
 * Deliberately not a YAML parser: only top-level scalars and block scalars are read,
 * and nested structures such as `metadata` are skipped. A skill file whose
 * frontmatter we cannot read is dropped rather than guessed at.
 */
export function parseFrontmatter(text: string): Record<string, string> | null {
  const m = /^﻿?---\r?\n([\s\S]*?)\r?\n---\s*(\r?\n|$)/.exec(text);
  if (!m) return null;
  const out: Record<string, string> = {};
  const lines = m[1].split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const kv = /^([A-Za-z][A-Za-z0-9_-]*)\s*:\s*(.*)$/.exec(line);
    if (!kv) continue; // Continuation or nested content; the block reader below owns it.
    const key = kv[1];
    let value = kv[2];
    if (value === '>' || value === '|' || value === '>-' || value === '|-') {
      // Block scalar: take the indented lines that follow.
      const body: string[] = [];
      while (i + 1 < lines.length && /^\s+\S/.test(lines[i + 1])) body.push(lines[++i].trim());
      value = body.join(value.startsWith('>') ? ' ' : '\n');
    } else {
      value = value.trim().replace(/^'([\s\S]*)'$/, '$1').replace(/^"([\s\S]*)"$/, '$1');
    }
    out[key] = value;
  }
  return out;
}

/** Lists the skill files at the top level of one root. */
function skillFilesIn(dir: string): { name: string; file: string }[] {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return []; // Root absent: normal, most projects define none.
  }
  const found: { name: string; file: string }[] = [];
  for (const entry of entries) {
    // The user DSH root's `.system` child is excluded by the provider; dotfiles in
    // general are not skills.
    if (entry.startsWith('.')) continue;
    const full = join(dir, entry);
    try {
      if (statSync(full).isDirectory()) {
        const bundle = join(full, 'SKILL.md');
        if (existsSync(bundle)) found.push({ name: entry, file: bundle });
      } else if (entry.toLowerCase().endsWith('.md')) {
        found.push({ name: entry.replace(/\.md$/i, ''), file: full });
      }
    } catch {
      // Unreadable entry: skip it rather than failing the whole scan.
    }
  }
  return found;
}

/**
 * Discovers skills across roots.
 *
 * Lower rank wins a name clash, matching the provider's precedence, so a project
 * skill shadows a user one of the same name.
 */
export function discoverSkills(roots: SkillRoot[]): Skill[] {
  const byName = new Map<string, { rank: number; skill: Skill }>();
  for (const root of [...roots].sort((a, b) => a.rank - b.rank)) {
    for (const { name, file } of skillFilesIn(root.dir)) {
      let front: Record<string, string> | null;
      try {
        front = parseFrontmatter(readFileSync(file, 'utf8'));
      } catch {
        continue;
      }
      // `name` and `description` are required; without them it is not a skill.
      if (!front || !front.name || !front.description) continue;
      const existing = byName.get(front.name);
      if (existing && existing.rank <= root.rank) continue;
      byName.set(front.name, {
        rank: root.rank,
        skill: {
          name: front.name,
          description: front.description,
          source: root.source,
          path: file,
          modelInvocable: parseBool(front['disable-model-invocation'] ?? 'false') !== true,
          userInvocable: parseBool(front['user-invocable'] ?? 'true') !== false,
        },
      });
      void name; // Directory name is informational; the frontmatter name is authoritative.
    }
  }
  return [...byName.values()].map((v) => v.skill).sort((a, b) => a.name.localeCompare(b.name));
}

/** Convenience wrapper using the default roots. */
export function loadSkills(projectRoot: string, dshHomeOverride?: string, agentsHomeOverride?: string): Skill[] {
  return discoverSkills(
    defaultSkillRoots(
      projectRoot,
      dshHomeOverride ?? dshHome(),
      agentsHomeOverride ?? agentsHome(),
    ),
  );
}
