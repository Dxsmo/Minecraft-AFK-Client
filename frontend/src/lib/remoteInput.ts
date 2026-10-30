export type RemoteEvent = { kind: number; code?: number; action?: number; modifiers?: number; x?: number; y?: number; relative?: boolean; key?: string };

/** Combine consecutive pointer samples, preserving clicks and key ordering. */
export function queueRemoteEvent(events: RemoteEvent[], event: RemoteEvent): void {
  const previous = events.at(-1);
  if (event.kind === 3 && previous?.kind === 3 && !!previous.relative === !!event.relative) {
    if (event.relative) {
      previous.x = Math.max(-10000, Math.min(10000, (previous.x ?? 0) + (event.x ?? 0)));
      previous.y = Math.max(-10000, Math.min(10000, (previous.y ?? 0) + (event.y ?? 0)));
    } else events[events.length - 1] = { ...event };
  } else events.push({ ...event });
}
const keys: Record<string, number> = {
  Space: 32, Quote: 39, Comma: 44, Minus: 45, Period: 46, Slash: 47, Semicolon: 59, Equal: 61,
  BracketLeft: 91, Backslash: 92, BracketRight: 93, Backquote: 96, IntlBackslash: 161,
  Enter: 257, Tab: 258, Backspace: 259, Insert: 260, Delete: 261, ArrowRight: 262, ArrowLeft: 263,
  ArrowDown: 264, ArrowUp: 265, PageUp: 266, PageDown: 267, Home: 268, End: 269,
  CapsLock: 280, ScrollLock: 281, NumLock: 282, PrintScreen: 283, Pause: 284,
  NumpadDecimal: 330, NumpadDivide: 331, NumpadMultiply: 332, NumpadSubtract: 333,
  NumpadAdd: 334, NumpadEnter: 335, NumpadEqual: 336,
  ShiftLeft: 340, ControlLeft: 341, AltLeft: 342, MetaLeft: 343,
  ShiftRight: 344, ControlRight: 345, AltRight: 346, MetaRight: 347, ContextMenu: 348,
};
export function glfwKey(code: string): number | undefined {
  if (/^Key[A-Z]$/.test(code)) return code.charCodeAt(3);
  if (/^Digit[0-9]$/.test(code)) return code.charCodeAt(5);
  if (/^Numpad[0-9]$/.test(code)) return 320 + Number(code.slice(6));
  if (/^F(?:[1-9]|1[0-9]|2[0-5])$/.test(code)) return 289 + Number(code.slice(1));
  return keys[code]; // Escape intentionally has no native mapping.
}
export const modifiers = (event: Pick<KeyboardEvent, "shiftKey" | "ctrlKey" | "altKey" | "metaKey">) =>
  Number(event.shiftKey) | Number(event.ctrlKey) * 2 | Number(event.altKey) * 4 | Number(event.metaKey) * 8;
