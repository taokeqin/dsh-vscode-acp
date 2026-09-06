// src/dshHome.ts — where dsh keeps its state.
//
// One definition, because four copies of the same `??` chain is four places to get
// the override wrong. dsh reads DSH_HOME itself, so honouring it here keeps the
// extension looking at the same directory the agent uses.
import { homedir } from 'node:os';
import { join } from 'node:path';

/** `$DSH_HOME`, else `~/.dsh`. */
export function dshHome(): string {
  const fromEnv = process.env.DSH_HOME;
  return fromEnv !== undefined && fromEnv.trim() !== '' ? fromEnv : join(homedir(), '.dsh');
}

/**
 * Root for agent-agnostic configuration, used for the `<agentsHome>/skills` root.
 *
 * `AGENTS_HOME` is honoured on the same reasoning as DSH_HOME: if a user relocates
 * it, the skill list should follow rather than silently come up empty.
 */
export function agentsHome(): string {
  const fromEnv = process.env.AGENTS_HOME;
  return fromEnv !== undefined && fromEnv.trim() !== '' ? fromEnv : join(homedir(), '.agents');
}
