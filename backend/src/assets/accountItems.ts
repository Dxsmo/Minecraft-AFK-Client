import { readFile } from "node:fs/promises";
import { readFileSync } from "node:fs";

export type AccountItem = { id: string; name: string; url: string };
const directory = new URL("../../assets/account-items/", import.meta.url);
export const accountItems: AccountItem[] = JSON.parse(readFileSync(new URL("catalog.json", directory), "utf8"));
const ids = new Set(accountItems.map(item => item.id));

export async function getAccountItem(id: string): Promise<Buffer | null> {
  if (!ids.has(id)) return null;
  return readFile(new URL(`${id}.png`, directory));
}
