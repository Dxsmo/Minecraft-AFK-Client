export interface SellMultiplier { name: string; multiplier: string; progress: string }

/** Plain tooltip text may be legacy-coloured strings or JSON text components. */
export function tooltipText(value: unknown): string {
  if (typeof value === "string") {
    if (/^[\[{]/.test(value.trim())) {
      try { return tooltipText(JSON.parse(value)); } catch { /* Plain item text. */ }
    }
    return value.replace(/§[0-9a-z]/gi, "").replace(/§/g, "");
  }
  if (Array.isArray(value)) return value.map(tooltipText).join("");
  if (value && typeof value === "object") {
    const component = value as { text?: unknown; extra?: unknown; rawtext?: unknown };
    return tooltipText(component.text) + tooltipText(component.extra ?? component.rawtext);
  }
  return "";
}

export function readMultiplier(name: unknown, lore: unknown[]): SellMultiplier | null {
  const displayName = tooltipText(name).replace(/[\r\n]/g, " ").trim();
  if (!displayName || displayName.length > 256) return null;
  const lines = lore.map(line => tooltipText(line).trim());
  const multiplier = lines.map(line => line.match(/^(?:Aktueller\s+Multiplikator|Current\s+multiplier)\s*:?\s*(\d+(?:[.,]\d+)?[x×])\s*$/iu)?.[1]).find(Boolean);
  const progress = readProgress(lines);
  return multiplier && multiplier.length <= 32 && progress ? { name: displayName, multiplier, progress } : null;
}

const MONEY_FACTORS: Record<string, number> = { K: 1e3, M: 1e6, B: 1e9, T: 1e12 };

function amount(input: string): { text: string; rest: string } | null {
  const text = input.trim().replace(/^\$\s*/, '');
  const match = text.match(/^(\d[\d.,]*)/u);
  if (!match || match[1].length > 32) return null;
  let rest = text.slice(match[1].length).trimStart();
  const unit = rest.match(/^[a-z]+/iu)?.[0].toUpperCase() ?? '';
  if (unit && !Object.hasOwn(MONEY_FACTORS, unit)) return null;
  if (unit) rest = rest.slice(unit.length).trimStart();
  return { text: match[1] + unit, rest: rest.replace(/^\$/, '').trim() };
}

function money(input: string): number {
  const unit = input.match(/[KMBT]$/iu)?.[0].toUpperCase();
  const value = unit ? input.slice(0, -1) : input;
  const factor = unit ? MONEY_FACTORS[unit] : 1;
  const pieces = value.split(/[.,]/);
  if (pieces.some(piece => !/^\d+$/.test(piece))) return NaN;
  const lastDot = value.lastIndexOf('.'), lastComma = value.lastIndexOf(',');
  if (lastDot >= 0 && lastComma >= 0) {
    const decimal = Math.max(lastDot, lastComma);
    return Number(value.slice(0, decimal).replace(/[.,]/g, '') + '.' + value.slice(decimal + 1)) * factor;
  }
  // A compact amount uses its separator as a decimal point (e.g. 1.234M).
  if (unit && pieces.length === 2) return Number(pieces.join('.')) * factor;
  if (pieces.length > 1 && pieces.slice(1).every(piece => piece.length === 3)) return Number(pieces.join('')) * factor;
  return Number(value.replace(',', '.')) * factor;
}

function percentage(line: string): string | null {
  const match = line.match(/(?:^|[^\d.,])(\d+(?:[.,]\d+)?)\s*%/u);
  if (!match || match[1].length > 10) return null;
  const value = Number(match[1].replace(',', '.'));
  return value >= 0 && value <= 100 ? match[1] : null;
}

function readProgress(lines: string[]): string | null {
  for (let index = 0; index < lines.length; index++) {
    const match = lines[index].match(/^(?:Fortschritt|Progress)\s*:?\s*(.*?)\/(.*)$/iu);
    if (!match) continue;
    const left = amount(match[1]), right = amount(match[2]);
    if (!left || left.rest || !right) continue;
    const current = money(left.text), target = money(right.text);
    if (!Number.isFinite(current) || !Number.isFinite(target)) continue;
    const nextLine = lines.slice(index + 1).find(line => line.length > 0) ?? '';
    // Preserve the server's displayed percentage, even if its money amounts
    // were rounded. Only compute a fallback when the tooltip omits the value.
    const percent = percentage(right.rest) ?? percentage(nextLine)
      ?? (target > 0 ? String(Math.floor(Math.min(100, current / target * 100))) : null);
    if (percent !== null) return `${left.text}$/${right.text}$ - ${percent}%`;
  }
  return null;
}
