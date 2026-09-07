#!/usr/bin/env node
// Regenerates backend/src/minecraft/itemRegistry.ts from PrismarineJS minecraft-data.
//
//   node scripts/generate-item-registry.mjs [version...]
//
// Without arguments the versions in DEFAULT_VERSIONS are merged. Items are the
// union of all requested versions so that a scan still covers items the server
// gained (or lost) in a point release. `air` is dropped because asking the
// server for its worth is meaningless.

import { writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const DEFAULT_VERSIONS = ['1.21.9', '1.21.11'];
const BASE_URL = 'https://raw.githubusercontent.com/PrismarineJS/minecraft-data/master/data/pc';

const versions = process.argv.slice(2);
const wanted = versions.length > 0 ? versions : DEFAULT_VERSIONS;

const items = new Map();

for (const version of wanted) {
  const url = `${BASE_URL}/${version}/items.json`;
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Failed to fetch ${url}: ${response.status} ${response.statusText}`);
  }
  const parsed = await response.json();
  for (const item of parsed) {
    if (!item?.name || item.name === 'air') continue;
    if (!items.has(item.name)) {
      items.set(item.name, item.displayName ?? item.name);
    }
  }
  console.log(`${version}: ${parsed.length} items`);
}

const sorted = [...items.entries()].sort(([a], [b]) => a.localeCompare(b));

const escape = (value) => value.replace(/\\/g, '\\\\').replace(/'/g, "\\'");

const body = sorted.map(([id, name]) => `  { id: '${escape(id)}', name: '${escape(name)}' },`).join('\n');

const contents = `// Generated from PrismarineJS minecraft-data (pc ${wanted.join(' union ')}).
// Regenerate with scripts/generate-item-registry.mjs when the server updates.

export interface RegistryItem {
  /** Registry id without the \`minecraft:\` namespace, e.g. \`pumpkin\`. */
  id: string;
  /** English display name as the server prints it, e.g. \`Pumpkin\`. */
  name: string;
}

export const ITEM_REGISTRY: readonly RegistryItem[] = [
${body}
];

export const ITEM_REGISTRY_TOTAL = ITEM_REGISTRY.length;

const BY_ID = new Map(ITEM_REGISTRY.map((item) => [item.id, item]));

export function findRegistryItem(id: string): RegistryItem | undefined {
  return BY_ID.get(id.replace(/^minecraft:/, '').toLowerCase());
}
`;

const here = dirname(fileURLToPath(import.meta.url));
const target = join(here, '..', 'backend', 'src', 'minecraft', 'itemRegistry.ts');
await writeFile(target, contents, 'utf8');

console.log(`Wrote ${sorted.length} items to ${target}`);
