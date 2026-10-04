/** Parse a confirmed sale's total payout, never its base value or bonus. */
export function parseSellEarning(message: string): number | null {
  const text = message.replace(/§[0-9a-u]/gi, "").replace(/§/g, "");
  // HugoSMP confirmations have no sell verb, but do have a base/bonus breakdown.
  const breakdown = /\bBasis\s*:/i.test(text) && /\bBonus\s*:/i.test(text);
  const sale = /\b(?:sold|sale|selling|verkauft|verkauf)\b/i.test(text);
  if ((!breakdown && !sale) || /\b(?:pay|paid|bezahlt|received|erhalten von)\b/i.test(text)) return null;

  const match = breakdown
    ? text.match(/\+\s*\$\s*([0-9]+(?:[.,][0-9]+)*)\s*\(\s*Basis\s*:/i)
    : text.match(/\$\s*([0-9]+(?:[.,][0-9]+)*)/);
  if (!match) return null;
  const raw = match[1];
  let normalized: string;
  // Dots/commas followed by groups of three are thousands separators.
  // When both occur, the final separator is the decimal separator.
  if (/^\d{1,3}(?:\.\d{3})+(?:,\d{1,2})?$/.test(raw)) {
    normalized = raw.replace(/\./g, "").replace(",", ".");
  } else if (/^\d{1,3}(?:,\d{3})+(?:\.\d{1,2})?$/.test(raw)) {
    normalized = raw.replace(/,/g, "");
  } else if (/^\d+(?:[.,]\d{1,2})?$/.test(raw)) {
    normalized = raw.replace(",", ".");
  } else {
    return null;
  }
  const amount = Number(normalized);
  return Number.isFinite(amount) && amount > 0 && Number.isSafeInteger(Math.round(amount * 100))
    ? Math.round(amount * 100) / 100
    : null;
}
