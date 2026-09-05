// src/composerKeys.ts — composer key decisions, injected into the panel script.
//
// Defined here rather than inline so the tested code is the shipped code, same as
// slashMenu.ts.

/** The fields of a KeyboardEvent this decision needs. */
export interface KeyLike {
  key?: string;
  shiftKey?: boolean;
  /** True while an IME is composing. */
  isComposing?: boolean;
  /** Legacy IME signal; some browsers report 229 instead of setting isComposing. */
  keyCode?: number;
}

/**
 * Whether a keypress should send the message.
 *
 * The IME check is the point. An input method uses Enter to accept its candidate, and
 * that keydown reaches us with `isComposing` set *before* the text is committed. Acting
 * on it sent the message and then let the IME commit the accepted word into the
 * now-empty box — the "last word left behind after sending" bug. Enter during
 * composition belongs to the IME, never to us.
 */
export function shouldSubmit(e: KeyLike): boolean {
  if (e.isComposing === true || e.keyCode === 229) return false;
  return e.key === 'Enter' && e.shiftKey !== true;
}

/**
 * Whether the slash menu should react to this key at all.
 *
 * Same reasoning: while an IME is composing, arrows and Enter are moving through
 * candidates, not through our menu.
 */
export function menuHandlesKey(e: KeyLike): boolean {
  return e.isComposing !== true && e.keyCode !== 229;
}
