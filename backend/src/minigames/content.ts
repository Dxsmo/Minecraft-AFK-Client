import { z } from "zod";
import { prisma } from "../database/prisma.js";
import { SUPPORTED_VERSIONS, itemId } from "./protocol.js";
import { vanillaCatalog } from "./catalog.generated.js";
import { forbiddenBingo } from "./games/items.js";
import { creativeOnly, isSurvivalItem } from "./item-policy.js";
export { creativeOnly } from "./item-policy.js";
const difficulty = z.enum(["LEICHT", "MITTEL", "SCHWER"]);
export const itemContentSchema = z
  .object({
    itemId,
    displayNameDe: z.string().min(1).max(100),
    survivalObtainable: z.boolean(),
    difficulty,
    bingoEligible: z.boolean(),
    itemHuntEligible: z.boolean(),
    collectorEligible: z.boolean(),
    supportedVersions: z
      .array(z.enum(SUPPORTED_VERSIONS as [string, ...string[]]))
      .min(1),
    category: z
      .enum(["OVERWORLD", "NETHER", "END", "MOB", "STRUCTURE"])
      .default("OVERWORLD"),
  })
  .strict()
  .refine(
    (x) => !x.survivalObtainable || isSurvivalItem(x.itemId),
    "Creative-only items are not survival-obtainable",
  )
  .refine(
    (x) =>
      !x.bingoEligible ||
      (x.survivalObtainable && !forbiddenBingo.test(x.itemId)),
    "Bingo eligibility violates survival/fairness rules",
  )
  .refine(
    (x) =>
      x.survivalObtainable || (!x.itemHuntEligible && !x.collectorEligible),
    "Creative-only items must be excluded",
  );
const german = z
  .string()
  .trim()
  .min(2)
  .max(200)
  .regex(/^[A-Za-zÄÖÜäöüß0-9 ,.!?()\-]+$/);
export const wordContentSchema = z
  .object({ word: german.max(80), difficulty })
  .strict();
export const photoContentSchema = z
  .object({ textDe: german.min(10), difficulty })
  .strict();
export async function seedContent() {
  const items: [string, string, string][] = [
    ["oak_log", "Eichenstamm", "LEICHT"],
    ["oak_planks", "Eichenholzbretter", "LEICHT"],
    ["stick", "Stock", "LEICHT"],
    ["crafting_table", "Werkbank", "LEICHT"],
    ["dirt", "Erde", "LEICHT"],
    ["cobblestone", "Bruchstein", "LEICHT"],
    ["stone", "Stein", "LEICHT"],
    ["sand", "Sand", "LEICHT"],
    ["gravel", "Kies", "LEICHT"],
    ["glass", "Glas", "LEICHT"],
    ["coal", "Kohle", "LEICHT"],
    ["charcoal", "Holzkohle", "LEICHT"],
    ["torch", "Fackel", "LEICHT"],
    ["furnace", "Ofen", "LEICHT"],
    ["chest", "Truhe", "LEICHT"],
    ["ladder", "Leiter", "LEICHT"],
    ["bowl", "Schüssel", "LEICHT"],
    ["oak_boat", "Eichenholzboot", "LEICHT"],
    ["oak_door", "Eichenholztür", "LEICHT"],
    ["oak_fence", "Eichenholzzaun", "LEICHT"],
    ["oak_slab", "Eichenholzstufe", "LEICHT"],
    ["oak_stairs", "Eichenholztreppe", "LEICHT"],
    ["oak_trapdoor", "Eichenholzfalltür", "LEICHT"],
    ["oak_button", "Eichenholzknopf", "LEICHT"],
    ["oak_pressure_plate", "Eichenholzdruckplatte", "LEICHT"],
    ["oak_sign", "Eichenholzschild", "LEICHT"],
    ["spruce_log", "Fichtenstamm", "LEICHT"],
    ["birch_log", "Birkenstamm", "LEICHT"],
    ["wheat", "Weizen", "LEICHT"],
    ["wheat_seeds", "Weizenkörner", "LEICHT"],
    ["bread", "Brot", "LEICHT"],
    ["apple", "Apfel", "LEICHT"],
    ["poppy", "Mohn", "LEICHT"],
    ["dandelion", "Löwenzahn", "LEICHT"],
    ["sugar_cane", "Zuckerrohr", "LEICHT"],
    ["sugar", "Zucker", "LEICHT"],
    ["paper", "Papier", "LEICHT"],
    ["white_wool", "Weiße Wolle", "LEICHT"],
    ["white_bed", "Weißes Bett", "LEICHT"],
    ["wooden_pickaxe", "Holzspitzhacke", "LEICHT"],
    ["stone_pickaxe", "Steinspitzhacke", "LEICHT"],
    ["stone_axe", "Steinaxt", "LEICHT"],
    ["stone_sword", "Steinschwert", "LEICHT"],
    ["stone_shovel", "Steinschaufel", "LEICHT"],
    ["wooden_hoe", "Holzhacke", "LEICHT"],
    ["leather", "Leder", "LEICHT"],
    ["feather", "Feder", "LEICHT"],
    ["egg", "Ei", "LEICHT"],
    ["beef", "Rohes Rindfleisch", "LEICHT"],
    ["porkchop", "Rohes Schweinefleisch", "LEICHT"],
    ["chicken", "Rohes Hühnchen", "LEICHT"],
    ["mutton", "Rohes Hammelfleisch", "LEICHT"],
    ["cooked_beef", "Steak", "LEICHT"],
    ["cooked_porkchop", "Gebratenes Schweinefleisch", "LEICHT"],
    ["cooked_chicken", "Gebratenes Hühnchen", "LEICHT"],
    ["cooked_mutton", "Gebratenes Hammelfleisch", "LEICHT"],
    ["flint", "Feuerstein", "LEICHT"],
    ["clay_ball", "Tonklumpen", "LEICHT"],
    ["brick", "Ziegel", "LEICHT"],
    ["bricks", "Ziegelsteine", "LEICHT"],
    ["flower_pot", "Blumentopf", "LEICHT"],
    ["terracotta", "Keramik", "LEICHT"],
    ["sandstone", "Sandstein", "LEICHT"],
    ["granite", "Granit", "LEICHT"],
    ["diorite", "Diorit", "LEICHT"],
    ["andesite", "Andesit", "LEICHT"],
    ["cobbled_deepslate", "Bruchtiefenschiefer", "LEICHT"],
    ["deepslate", "Tiefenschiefer", "LEICHT"],
    ["copper_ingot", "Kupferbarren", "LEICHT"],
    ["raw_copper", "Rohkupfer", "LEICHT"],
    ["iron_ingot", "Eisenbarren", "MITTEL"],
    ["raw_iron", "Roheisen", "MITTEL"],
    ["iron_pickaxe", "Eisenspitzhacke", "MITTEL"],
    ["iron_sword", "Eisenschwert", "MITTEL"],
    ["iron_axe", "Eisenaxt", "MITTEL"],
    ["iron_shovel", "Eisenschaufel", "MITTEL"],
    ["iron_helmet", "Eisenhelm", "MITTEL"],
    ["iron_chestplate", "Eisenbrustpanzer", "MITTEL"],
    ["iron_leggings", "Eisenbeinschutz", "MITTEL"],
    ["iron_boots", "Eisenstiefel", "MITTEL"],
    ["bucket", "Eimer", "MITTEL"],
    ["water_bucket", "Wassereimer", "MITTEL"],
    ["lava_bucket", "Lavaeimer", "MITTEL"],
    ["shears", "Schere", "MITTEL"],
    ["shield", "Schild", "MITTEL"],
    ["flint_and_steel", "Feuerzeug", "MITTEL"],
    ["compass", "Kompass", "MITTEL"],
    ["clock", "Uhr", "MITTEL"],
    ["redstone", "Redstone", "MITTEL"],
    ["redstone_torch", "Redstone-Fackel", "MITTEL"],
    ["repeater", "Redstone-Verstärker", "MITTEL"],
    ["piston", "Kolben", "MITTEL"],
    ["hopper", "Trichter", "MITTEL"],
    ["rail", "Schiene", "MITTEL"],
    ["minecart", "Lore", "MITTEL"],
    ["gold_ingot", "Goldbarren", "MITTEL"],
    ["raw_gold", "Rohgold", "MITTEL"],
    ["gold_nugget", "Goldklumpen", "MITTEL"],
    ["golden_carrot", "Goldene Karotte", "MITTEL"],
    ["lapis_lazuli", "Lapislazuli", "MITTEL"],
    ["book", "Buch", "MITTEL"],
    ["bookshelf", "Bücherregal", "MITTEL"],
    ["item_frame", "Rahmen", "MITTEL"],
    ["painting", "Gemälde", "MITTEL"],
    ["leather_boots", "Lederschuhe", "MITTEL"],
    ["leather_helmet", "Lederkappe", "MITTEL"],
    ["bow", "Bogen", "MITTEL"],
    ["arrow", "Pfeil", "MITTEL"],
    ["string", "Faden", "MITTEL"],
    ["bone", "Knochen", "MITTEL"],
    ["bone_meal", "Knochenmehl", "MITTEL"],
    ["gunpowder", "Schwarzpulver", "MITTEL"],
    ["rotten_flesh", "Verrottetes Fleisch", "MITTEL"],
    ["spider_eye", "Spinnenauge", "MITTEL"],
    ["slime_ball", "Schleimball", "MITTEL"],
    ["pumpkin", "Kürbis", "MITTEL"],
    ["melon_slice", "Melonenscheibe", "MITTEL"],
    ["carrot", "Karotte", "MITTEL"],
    ["potato", "Kartoffel", "MITTEL"],
    ["baked_potato", "Ofenkartoffel", "MITTEL"],
    ["beetroot", "Rote Bete", "MITTEL"],
    ["beetroot_seeds", "Rote-Bete-Samen", "MITTEL"],
    ["cactus", "Kaktus", "MITTEL"],
    ["green_dye", "Grüner Farbstoff", "MITTEL"],
    ["blue_dye", "Blauer Farbstoff", "MITTEL"],
    ["red_dye", "Roter Farbstoff", "MITTEL"],
    ["yellow_dye", "Gelber Farbstoff", "MITTEL"],
    ["black_dye", "Schwarzer Farbstoff", "MITTEL"],
    ["ink_sac", "Tintenbeutel", "MITTEL"],
    ["glass_bottle", "Glasflasche", "MITTEL"],
    ["honey_bottle", "Honigflasche", "MITTEL"],
    ["honeycomb", "Honigwabe", "MITTEL"],
    ["campfire", "Lagerfeuer", "MITTEL"],
    ["lantern", "Laterne", "MITTEL"],
    ["barrel", "Fass", "MITTEL"],
    ["smoker", "Räucherofen", "MITTEL"],
    ["blast_furnace", "Schmelzofen", "MITTEL"],
    ["stonecutter", "Steinsäge", "MITTEL"],
    ["loom", "Webstuhl", "MITTEL"],
    ["cartography_table", "Kartentisch", "MITTEL"],
    ["fletching_table", "Bognertisch", "MITTEL"],
    ["smithing_table", "Schmiedetisch", "MITTEL"],
    ["grindstone", "Schleifstein", "MITTEL"],
    ["anvil", "Amboss", "MITTEL"],
    ["cauldron", "Kessel", "MITTEL"],
    ["rabbit_hide", "Kaninchenfell", "MITTEL"],
    ["rabbit", "Rohes Kaninchen", "MITTEL"],
    ["cod", "Roher Kabeljau", "MITTEL"],
    ["salmon", "Roher Lachs", "MITTEL"],
    ["pufferfish", "Kugelfisch", "MITTEL"],
    ["tropical_fish", "Tropenfisch", "MITTEL"],
    ["kelp", "Seetang", "MITTEL"],
    ["dried_kelp", "Getrockneter Seetang", "MITTEL"],
    ["seagrass", "Seegras", "MITTEL"],
    ["lily_pad", "Seerosenblatt", "MITTEL"],
    ["snowball", "Schneeball", "MITTEL"],
    ["snow_block", "Schneeblock", "MITTEL"],
    ["bamboo", "Bambus", "MITTEL"],
    ["scaffolding", "Gerüst", "MITTEL"],
    ["cocoa_beans", "Kakaobohnen", "MITTEL"],
    ["cookie", "Keks", "MITTEL"],
    ["mushroom_stew", "Pilzsuppe", "MITTEL"],
    ["brown_mushroom", "Brauner Pilz", "MITTEL"],
    ["red_mushroom", "Roter Pilz", "MITTEL"],
    ["sweet_berries", "Süßbeeren", "MITTEL"],
    ["diamond", "Diamant", "SCHWER"],
    ["diamond_pickaxe", "Diamantspitzhacke", "SCHWER"],
    ["diamond_sword", "Diamantschwert", "SCHWER"],
    ["diamond_axe", "Diamantaxt", "SCHWER"],
    ["diamond_shovel", "Diamantschaufel", "SCHWER"],
    ["diamond_hoe", "Diamanthacke", "SCHWER"],
    ["diamond_helmet", "Diamanthelm", "SCHWER"],
    ["diamond_boots", "Diamantstiefel", "SCHWER"],
    ["diamond_leggings", "Diamantbeinschutz", "SCHWER"],
    ["diamond_chestplate", "Diamantbrustpanzer", "SCHWER"],
    ["emerald", "Smaragd", "SCHWER"],
    ["obsidian", "Obsidian", "SCHWER"],
    ["enchanting_table", "Zaubertisch", "SCHWER"],
    ["ender_pearl", "Enderperle", "SCHWER"],
    ["ender_eye", "Enderauge", "SCHWER"],
    ["netherrack", "Netherrack", "SCHWER"],
    ["quartz", "Netherquarz", "SCHWER"],
    ["quartz_block", "Quarzblock", "SCHWER"],
    ["glowstone_dust", "Glowstonestaub", "SCHWER"],
    ["glowstone", "Glowstone", "SCHWER"],
    ["soul_sand", "Seelensand", "SCHWER"],
    ["soul_soil", "Seelenerde", "SCHWER"],
    ["nether_brick", "Netherziegel", "SCHWER"],
    ["nether_bricks", "Netherziegelsteine", "SCHWER"],
    ["blaze_rod", "Lohenrute", "SCHWER"],
    ["blaze_powder", "Lohenstaub", "SCHWER"],
    ["magma_cream", "Magmacreme", "SCHWER"],
    ["nether_wart", "Netherwarze", "SCHWER"],
    ["brewing_stand", "Braustand", "SCHWER"],
    ["ghast_tear", "Ghastträne", "SCHWER"],
    ["prismarine_shard", "Prismarinscherbe", "SCHWER"],
    ["prismarine_crystals", "Prismarinkristalle", "SCHWER"],
    ["sea_lantern", "Seelaterne", "SCHWER"],
    ["end_stone", "Endstein", "SCHWER"],
    ["chorus_fruit", "Chorusfrucht", "SCHWER"],
    ["purpur_block", "Purpurblock", "SCHWER"],
    ["amethyst_shard", "Amethystscherbe", "SCHWER"],
    ["spyglass", "Fernrohr", "SCHWER"],
    ["tinted_glass", "Getöntes Glas", "SCHWER"],
    ["tnt", "TNT", "SCHWER"],
    ["firework_rocket", "Feuerwerksrakete", "SCHWER"],
    ["crossbow", "Armbrust", "SCHWER"],
    ["golden_apple", "Goldener Apfel", "SCHWER"],
    ["cake", "Kuchen", "SCHWER"],
    ["pumpkin_pie", "Kürbiskuchen", "SCHWER"],
    ["rabbit_stew", "Kaninchenragout", "SCHWER"],
    ["fermented_spider_eye", "Fermentiertes Spinnenauge", "SCHWER"],
    ["glistering_melon_slice", "Glitzernde Melonenscheibe", "SCHWER"],
    ["chiseled_bookshelf", "Gemeißeltes Bücherregal", "SCHWER"],
    ["lectern", "Lesepult", "SCHWER"],
    ["name_tag", "Namensschild", "SCHWER"],
    ["saddle", "Sattel", "MITTEL"],
    ["heart_of_the_sea", "Herz des Meeres", "SCHWER"],
  ];
  for (const [id, name, diff] of items) {
    const key = "minecraft:" + id;
    const category =
      /nether|netherrack|quartz|glowstone|soul_|blaze|ghast|magma/.test(id)
        ? "NETHER"
        : /end_stone|chorus|purpur/.test(id)
          ? "END"
          : /name_tag|saddle|heart_of_the_sea/.test(id)
            ? "STRUCTURE"
            : /bone|gunpowder|rotten|spider|slime/.test(id)
              ? "MOB"
              : "OVERWORLD";
    await prisma.minigameContent.upsert({
      where: { id: key },
      create: {
        id: key,
        kind: "item",
        data: JSON.stringify({
          itemId: key,
          displayNameDe: name,
          survivalObtainable: true,
          difficulty: diff,
          bingoEligible: true,
          itemHuntEligible: true,
          collectorEligible: true,
          supportedVersions: SUPPORTED_VERSIONS,
          category,
        }),
      },
      update: {},
    });
  }
  const existingItems = new Set(
    (
      await prisma.minigameContent.findMany({
        where: { kind: "item" },
        select: { id: true },
      })
    ).map((x) => x.id),
  );
  const additionalItems = vanillaCatalog
    .filter((x) => !existingItems.has(x.itemId))
    .map((x) => {
      const survivalObtainable = isSurvivalItem(x.itemId);
      return {
        id: x.itemId,
        kind: "item",
        data: JSON.stringify({
          ...x,
          survivalObtainable,
          difficulty: "MITTEL",
          bingoEligible: false,
          itemHuntEligible: false,
          collectorEligible: survivalObtainable,
          category:
            /nether|netherrack|quartz|glowstone|soul_|blaze|ghast|magma|crimson|warped/.test(
              x.itemId,
            )
              ? "NETHER"
              : /end_stone|chorus|purpur|shulker/.test(x.itemId)
                ? "END"
                : "OVERWORLD",
        }),
      };
    });
  if (additionalItems.length)
    await prisma.minigameContent.createMany({ data: additionalItems });
  // Hard exclusions are security policy, so repair older invalid flags without overwriting other admin edits.
  const forbiddenIds = vanillaCatalog
    .filter((x) => !isSurvivalItem(x.itemId))
    .map((x) => x.itemId);
  for (const row of await prisma.minigameContent.findMany({
    where: { kind: "item", id: { in: forbiddenIds } },
  })) {
    const data = JSON.parse(row.data);
    if (
      data.survivalObtainable ||
      data.bingoEligible ||
      data.itemHuntEligible ||
      data.collectorEligible
    )
      await prisma.minigameContent.update({
        where: { id: row.id },
        data: {
          data: JSON.stringify({
            ...data,
            survivalObtainable: false,
            bingoEligible: false,
            itemHuntEligible: false,
            collectorEligible: false,
          }),
        },
      });
  }
  const words =
    "Pinguin Burg Vulkan Rakete Kaktus Leuchtturm Brücke Baumhaus Schiff Pirat Drache Katze Hund Biene Roboter Dinosaurier Windmühle Schloss Schneemann Eiffelturm Flugzeug U-Boot Gitarre Klavier Traktor Zug Lokomotive Fahrrad Motorrad Karussell Riesenrad Rutsche Schwert Krone Ritter Zauberer Hexe Meerjungfrau Octopus Tintenfisch Schildkröte Elefant Giraffe Löwe Zebra Fuchs Eule Pilz Blume Sonnenblume Palme Insel Wasserfall Höhle Zelt Lagerfeuer Sofa Fernseher Computer Tastatur Telefon Uhr Kamera Fernglas Regenschirm Stiefel Hut Brille Herz Stern Mond Sonne Regenbogen Wolke Schneeflocke Geschenk Kuchen Pizza Hamburger Eiscreme Melone Apfel Banane Karotte Kürbis Tasse Teekanne Flasche Buch Bibliothek Schule Krankenhaus Feuerwache Tankstelle Bäckerei Bahnhof Stadion Schwimmbad Zoo Garten Bauernhof Säge Hammer Amboss Angel Schatztruhe Diamant Portal Creeper Enderman Dorfbewohner".split(
      " ",
    );
  for (const [i, word] of words.entries())
    await prisma.minigameContent.upsert({
      where: { id: `word-${i}` },
      create: {
        id: `word-${i}`,
        kind: "word",
        data: JSON.stringify({ word, difficulty: "MITTEL" }),
      },
      update: {},
    });
  const challenges = [
    "Mache ein Bild mit einem Creeper.",
    "Mache ein Bild von einer Mohnblume.",
    "Mache ein Bild von einem Ertrunkenen mit einem Dreizack.",
    "Mache ein Bild von einem Dorf bei Nacht.",
    "Mache ein Bild von einer Biene neben einer Blume.",
    "Fotografiere einen Sonnenuntergang über dem Meer.",
    "Fotografiere eine Katze auf einem Bett.",
    "Fotografiere einen Fuchs im Wald.",
    "Fotografiere ein Schaf neben einer Werkbank.",
    "Fotografiere eine Brücke über einen Fluss.",
    "Fotografiere einen Wasserfall.",
    "Fotografiere ein Netherportal.",
    "Fotografiere einen Schneemann.",
    "Fotografiere eine Schildkröte am Strand.",
    "Fotografiere ein Pferd neben einem Baum.",
    "Fotografiere einen Regenbogen aus bunten Blöcken.",
    "Fotografiere einen Eisberg.",
    "Fotografiere eine Höhle mit Tropfsteinen.",
    "Fotografiere eine Axolotl im Wasser.",
    "Fotografiere eine Kuh und ein Schwein gemeinsam.",
    "Fotografiere einen Dorfbewohner bei seiner Arbeit.",
    "Fotografiere einen Eisengolem mit einer Blume.",
    "Fotografiere einen Kürbis vor einem Haus.",
    "Fotografiere einen Ozelot im Dschungel.",
    "Fotografiere einen Papagei auf deiner Schulter.",
    "Fotografiere einen Pilz auf einer Pilzinsel.",
    "Fotografiere eine Lore auf einer Schiene.",
    "Fotografiere einen Doppelkasten neben einem Ofen.",
    "Fotografiere einen Wüstenbrunnen.",
    "Fotografiere einen Bambuswald.",
    "Fotografiere einen Pandabären.",
    "Fotografiere einen Frosch auf einem Seerosenblatt.",
    "Fotografiere eine Blume auf einem Berg.",
    "Fotografiere ein Lagerfeuer bei Nacht.",
    "Fotografiere eine Hängebrücke.",
    "Fotografiere ein Schiff im Wasser.",
    "Fotografiere einen Strand mit Muscheln aus Blöcken.",
    "Fotografiere ein Haus aus mindestens drei Holzarten.",
    "Fotografiere eine große rote Pilzkappe.",
    "Fotografiere eine Laterne unter einem Baum.",
  ];
  for (const [i, textDe] of challenges.entries())
    await prisma.minigameContent.upsert({
      where: { id: `photo-${i}` },
      create: {
        id: `photo-${i}`,
        kind: "photo",
        data: JSON.stringify({ textDe, difficulty: "MITTEL" }),
      },
      update: {},
    });
}
