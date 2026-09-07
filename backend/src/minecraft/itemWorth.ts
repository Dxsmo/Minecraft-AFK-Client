/**
 * Parsing helpers for the server's `/worth <item>` replies.
 *
 * HugoSMP answers in German, e.g.
 *
 *   Der Wert von Dirt beträgt $1.
 *   Das Item hat keinen festgelegten Wert.
 *
 * Everything in here is deliberately pure so the (fragile, server-specific)
 * text matching can be unit tested without a running bot.
 */

/** A recognised `/worth` reply. `value === null` means "no configured price". */
export interface WorthReply {
  /** Display name the server echoed back, when it included one. */
  itemName: string | null;
  value: number | null;
}

const VALUE_PATTERN = /wert\s+von\s+(.+?)\s+betr[äa]gt\s*\$?\s*(-?[\d.,]*\d)/i;
const NO_VALUE_PATTERN = /(kein(en)?\s+festgelegten\s+wert|hat\s+keinen\s+wert)/i;

/**
 * Turn the numeric part of a price into a number.
 *
 * Servers are inconsistent about separators, so both `1,234.56` and `1.234,56`
 * have to work. The rule: whichever separator appears last is the decimal
 * point. A lone separator is a thousands separator only when it is followed by
 * exactly three digits (`1.234` -> 1234) and is otherwise a decimal point
 * (`1.5` -> 1.5). Returns null if the text is not a usable number.
 */
export function parseWorthNumber(raw: string): number | null {
  // Trailing separators are never part of the number: replies end in a
  // sentence period ("... beträgt $12.5."), and letting that period through
  // would make the grouping heuristic below read 12.5 as 125.
  const text = raw.trim().replace(/[$\s]/g, "").replace(/[.,]+$/, "");
  if (text === "" || !/\d/.test(text)) return null;

  const negative = text.startsWith("-");
  const digits = negative ? text.slice(1) : text;
  if (!/^[\d.,]+$/.test(digits)) return null;

  const lastComma = digits.lastIndexOf(",");
  const lastDot = digits.lastIndexOf(".");

  let normalised: string;
  if (lastComma >= 0 && lastDot >= 0) {
    // Both present: the later one is the decimal separator.
    const decimalAt = Math.max(lastComma, lastDot);
    const intPart = digits.slice(0, decimalAt).replace(/[.,]/g, "");
    const fracPart = digits.slice(decimalAt + 1).replace(/[.,]/g, "");
    normalised = `${intPart}.${fracPart}`;
  } else if (lastComma >= 0 || lastDot >= 0) {
    const sepAt = Math.max(lastComma, lastDot);
    const sep = digits[sepAt]!;
    const occurrences = digits.split(sep).length - 1;
    const tail = digits.slice(sepAt + 1);
    // Repeated separators, or a single one grouping exactly three digits, mean
    // thousands grouping rather than a fraction.
    const isGrouping = occurrences > 1 || (tail.length === 3 && sepAt > 0);
    normalised = isGrouping
      ? digits.replace(/[.,]/g, "")
      : `${digits.slice(0, sepAt).replace(/[.,]/g, "")}.${tail}`;
  } else {
    normalised = digits;
  }

  const parsed = Number(normalised);
  if (!Number.isFinite(parsed)) return null;
  return negative ? -parsed : parsed;
}

/**
 * Match a single chat line against the known `/worth` reply shapes. Returns
 * null for every unrelated line, so this is safe to run over the whole chat
 * stream.
 */
export function parseWorthReply(line: string): WorthReply | null {
  // Strip a leading `<Sender> ` prefix so both chat and server messages work.
  const text = line.replace(/^<[^>]*>\s*/, "").trim();
  if (text === "") return null;

  const valueMatch = VALUE_PATTERN.exec(text);
  if (valueMatch) {
    const value = parseWorthNumber(valueMatch[2]!);
    if (value !== null) {
      return { itemName: valueMatch[1]!.trim(), value };
    }
  }

  if (NO_VALUE_PATTERN.test(text)) {
    return { itemName: null, value: null };
  }

  return null;
}

/**
 * Whether two scanned prices differ. Both may be null ("no price"), which
 * counts as equal. A tiny epsilon absorbs float round-trips through SQLite.
 */
export function worthChanged(previous: number | null, next: number | null): boolean {
  if (previous === null && next === null) return false;
  if (previous === null || next === null) return true;
  return Math.abs(previous - next) > 1e-9;
}

/**
 * Random pause between two `/worth` queries, in milliseconds. Kept random so
 * the command stream does not look like a metronome to server anti-spam.
 */
export function nextQueryDelayMs(
  minSeconds: number,
  maxSeconds: number,
  random: () => number = Math.random,
): number {
  const low = Math.max(0, Math.min(minSeconds, maxSeconds));
  const high = Math.max(minSeconds, maxSeconds);
  return Math.round((low + random() * (high - low)) * 1000);
}
