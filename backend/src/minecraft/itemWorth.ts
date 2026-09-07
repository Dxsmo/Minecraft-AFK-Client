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

/** The item a query is waiting for, used to correlate a reply to it. */
export interface ExpectedItem {
  id: string;
  name: string;
}

const VALUE_PATTERN = /wert\s+von\s+(.+?)\s+betr[äa]gt\s*\$?\s*(-?[\d.,]*\d)/i;
const NO_VALUE_PATTERN =
  /(kein(en)?\s+(festgelegten\s+)?wert|nicht\s+verkauf(t|bar)|wertlos|no\s+(set\s+)?(worth|value)|cannot\s+be\s+sold)/i;

/** A `$`-prefixed amount anywhere in the line, e.g. "... $1.234,56 ...". */
const DOLLAR_AMOUNT_PATTERN = /\$\s*(-?[\d.,]*\d)/;

/** Any standalone number, used only once a line is already correlated by name. */
const ANY_AMOUNT_PATTERN = /(?:^|[^\w.,])(-?\d[\d.,]*)/g;

/**
 * Reduce a name to comparable letters and digits, so that `Oak Log`, `oak_log`
 * and `OAK LOG` all match. Servers are wildly inconsistent about whether they
 * echo the display name, the registry id or something in between.
 */
export function normaliseItemName(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "");
}

/**
 * The argument to pass to `/worth`. The server does not accept registry ids:
 * `/worth leaf_litter` is rejected, `/worth leaf litter` works. So underscores
 * become spaces.
 */
export function worthCommandArgument(itemId: string): string {
  return itemId.replace(/_/g, " ");
}


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
 * Correlate one chat line with the item we are currently waiting for.
 *
 * The strict phrasing above is only what this particular server was *reported*
 * to use; wording, punctuation and whether it echoes the display name or the
 * registry id can all differ. So once a line demonstrably mentions the item we
 * just asked about, a `$` amount (or, failing that, the single number on the
 * line) is accepted regardless of the sentence around it. Correlating by name
 * is what keeps another player's chat out of the price table, so this stays
 * safe while being far less brittle than matching one exact sentence.
 *
 * Returns null when the line is not an answer to this query.
 */
export function matchWorthReply(line: string, expected: ExpectedItem): WorthReply | null {
  const text = line.replace(/^<[^>]*>\s*/, "").trim();
  if (text === "") return null;

  const wanted = [normaliseItemName(expected.name), normaliseItemName(expected.id)].filter(
    (name) => name.length > 0,
  );
  const haystack = normaliseItemName(text);
  const mentionsItem = wanted.some((name) => haystack.includes(name));

  // "No price" replies carry no item name at all, so they cannot be correlated
  // and are accepted as-is — they arrive inside the query window anyway.
  if (NO_VALUE_PATTERN.test(text)) return { itemName: null, value: null };

  const strict = VALUE_PATTERN.exec(text);
  if (strict) {
    const value = parseWorthNumber(strict[2]!);
    const echoed = strict[1]!.trim();
    // The strict pattern still has to be about the right item.
    if (value !== null && (mentionsItem || wanted.includes(normaliseItemName(echoed)))) {
      return { itemName: echoed, value };
    }
  }

  if (!mentionsItem) return null;

  const dollar = DOLLAR_AMOUNT_PATTERN.exec(text);
  if (dollar) {
    const value = parseWorthNumber(dollar[1]!);
    if (value !== null) return { itemName: expected.name, value };
  }

  // No currency marker: fall back to the only number on the line. More than one
  // number is ambiguous (stack sizes, "1x", per-unit vs total), so bail out
  // rather than record a guess.
  const numbers = [...text.matchAll(ANY_AMOUNT_PATTERN)]
    .map((match) => parseWorthNumber(match[1]!))
    .filter((value): value is number => value !== null);
  if (numbers.length === 1) return { itemName: expected.name, value: numbers[0]! };

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
