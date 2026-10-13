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
  const multiplier = lines.map(line => line.match(/^(?:Aktueller Multiplikator|Current multiplier)\s*:\s*(\d+(?:[.,]\d+)?[x×])\s*$/iu)?.[1]).find(Boolean);
  const progress = readProgress(lines);
  return multiplier && multiplier.length <= 32 && progress ? { name: displayName, multiplier, progress } : null;
}

function money(value: string): number {
  const pieces = value.split(/[.,]/);
  if (pieces.some(piece => !/^\d+$/.test(piece))) return NaN;
  const lastDot = value.lastIndexOf('.'), lastComma = value.lastIndexOf(',');
  if (lastDot >= 0 && lastComma >= 0) {
    const decimal = Math.max(lastDot, lastComma);
    return Number(value.slice(0, decimal).replace(/[.,]/g, '') + '.' + value.slice(decimal + 1));
  }
  if (pieces.length > 1 && pieces.slice(1).every(piece => piece.length === 3)) return Number(pieces.join(''));
  return Number(value.replace(',', '.'));
}

function percentage(line: string): string | null {
  const match = line.match(/(?:^|[^\d.,])(\d+(?:[.,]\d+)?)\s*%/u);
  if (!match || match[1].length > 10) return null;
  const value = Number(match[1].replace(',', '.'));
  return value >= 0 && value <= 100 ? match[1] : null;
}

function readProgress(lines: string[]): string | null {
  for (let index = 0; index < lines.length; index++) {
    const match = lines[index].match(/^(?:Fortschritt|Progress)\s*:\s*\$?\s*(\d[\d.,]*)\s*\$?\s*\/\s*\$?\s*(\d[\d.,]*)\s*\$?(.*)$/iu);
    if (!match || match[1].length > 32 || match[2].length > 32) continue;
    const current = money(match[1]), target = money(match[2]);
    if (!Number.isFinite(current) || !Number.isFinite(target)) continue;
    const nextLine = lines.slice(index + 1).find(line => line.length > 0) ?? '';
    // Preserve the server's displayed percentage, even if its money amounts
    // were rounded. Only compute a fallback when the tooltip omits the value.
    const percent = percentage(match[3]) ?? percentage(nextLine)
      ?? (target > 0 ? String(Math.floor(Math.min(100, current / target * 100))) : null);
    if (percent !== null) return `${match[1]}$/${match[2]}$ - ${percent}%`;
  }
  return null;
}
