// One-time asset provisioning script, run as its own cached Docker build
// stage (see ../Dockerfile's "assets-builder" stage).
//
// Downloads every file in the Minecraft Wiki's "Category:InvSprite files"
// (the full set of inventory-slot item/block icon sprites used by the wiki's
// {{Inventory slot}} template — ~5073 files at the time this was written) via
// the public MediaWiki API, and writes them to ./invicons/<slug>.png plus a
// ./invicons/manifest.json index of every slug for the dashboard icon picker.
//
// This runs once per Docker build (the layer is cached unless this script or
// the Dockerfile stage changes), so the running app never needs network
// access to the wiki at runtime.
import { writeFile, mkdir } from "node:fs/promises";
import path from "node:path";

const API = "https://minecraft.wiki/api.php";
const CATEGORY = "Category:InvSprite files";
const OUT_DIR = path.resolve(process.cwd(), "invicons");
const USER_AGENT = "MinecraftAFKClient-IconSync/1.0 (self-hosted personal project; icon sync build step)";
const CONCURRENCY = 12;

async function apiGet(params) {
  const url = `${API}?${new URLSearchParams({ format: "json", ...params }).toString()}`;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const res = await fetch(url, { headers: { "User-Agent": USER_AGENT } });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.json();
    } catch (err) {
      if (attempt === 3) throw err;
      await new Promise((r) => setTimeout(r, 500 * attempt));
    }
  }
}

/** Every "File:" title directly in the category (subcategories are not recursed into). */
async function listCategoryFiles() {
  const titles = [];
  let cmcontinue;
  for (;;) {
    const data = await apiGet({
      action: "query",
      list: "categorymembers",
      cmtitle: CATEGORY,
      cmtype: "file",
      cmlimit: "500",
      ...(cmcontinue ? { cmcontinue } : {}),
    });
    for (const m of data.query?.categorymembers ?? []) titles.push(m.title);
    cmcontinue = data.continue?.cmcontinue;
    if (!cmcontinue) break;
  }
  return titles;
}

/** Resolves File: titles to their direct image URL, in batches of 50 (API limit for anonymous requests). */
async function resolveImageUrls(titles) {
  const map = new Map();
  for (let i = 0; i < titles.length; i += 50) {
    const batch = titles.slice(i, i + 50);
    const data = await apiGet({ action: "query", titles: batch.join("|"), prop: "imageinfo", iiprop: "url" });
    for (const page of Object.values(data.query?.pages ?? {})) {
      const url = page.imageinfo?.[0]?.url;
      if (page.title && url) map.set(page.title, url);
    }
  }
  return map;
}

/** file title -> url-safe, lowercase_with_underscores slug, deduped. */
function slugify(title, used) {
  let name = title.replace(/^File:/, "").replace(/\.[a-z0-9]+$/i, "");
  name = name.replace(/^Invicon\s+/i, "");
  let slug = name
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
  if (!slug) slug = "icon";
  let candidate = slug;
  let n = 2;
  while (used.has(candidate)) candidate = `${slug}_${n++}`;
  used.add(candidate);
  return candidate;
}

async function runPool(items, worker, concurrency) {
  let index = 0;
  let ok = 0;
  let failed = 0;
  async function next() {
    for (;;) {
      const i = index++;
      if (i >= items.length) return;
      try {
        await worker(items[i]);
        ok++;
      } catch (err) {
        failed++;
        console.warn(`  ! failed: ${items[i].slug} (${err.message})`);
      }
      if ((ok + failed) % 500 === 0) console.log(`  ... ${ok + failed}/${items.length}`);
    }
  }
  await Promise.all(Array.from({ length: concurrency }, next));
  return { ok, failed };
}

async function main() {
  await mkdir(OUT_DIR, { recursive: true });

  console.log(`Listing "${CATEGORY}" members...`);
  const titles = await listCategoryFiles();
  console.log(`Found ${titles.length} files.`);

  console.log("Resolving image URLs...");
  const urlMap = await resolveImageUrls(titles);
  console.log(`Resolved ${urlMap.size}/${titles.length} URLs.`);

  const used = new Set();
  const jobs = titles
    .filter((t) => urlMap.has(t))
    .map((t) => ({ title: t, url: urlMap.get(t), slug: slugify(t, used) }));

  console.log(`Downloading ${jobs.length} icons (concurrency ${CONCURRENCY})...`);
  const { ok, failed } = await runPool(
    jobs,
    async (job) => {
      const res = await fetch(job.url, { headers: { "User-Agent": USER_AGENT } });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const buf = Buffer.from(await res.arrayBuffer());
      await writeFile(path.join(OUT_DIR, `${job.slug}.png`), buf);
    },
    CONCURRENCY,
  );
  console.log(`Downloaded ${ok} icons, ${failed} failed.`);

  if (ok < jobs.length * 0.9) {
    throw new Error(`Too many icon downloads failed (${failed}/${jobs.length}) — aborting build.`);
  }

  const manifest = jobs.map((j) => j.slug).sort();
  await writeFile(path.join(OUT_DIR, "manifest.json"), JSON.stringify(manifest));
  console.log(`Wrote manifest.json with ${manifest.length} entries.`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
