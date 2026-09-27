import type { KeyboardEvent } from 'react';

/**
 * An Enter that means "send" or "done" — not the Enter that confirms a
 * Japanese conversion.
 *
 * While an IME is composing, the Enter that picks a candidate arrives as a
 * keydown too, flagged `isComposing` (keyCode 229 in older engines). Every
 * handler here used to check only `e.key === 'Enter'`, so typing 「ざいこ」 and
 * pressing Enter to turn it into 「在庫」 sent the request half-written (found by
 * the keyboard E2E test, 2026-09-27). test/enter-key.test.mjs keeps every
 * Enter handler going through here.
 */
export function isCommitEnter(e: KeyboardEvent): boolean {
  return e.key === 'Enter' && !e.nativeEvent.isComposing && e.keyCode !== 229;
}
