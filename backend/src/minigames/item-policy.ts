/** Item IDs that exist in registries but cannot be obtained as stacks in vanilla Survival. */
export const creativeOnly =
  /^minecraft:(?:air|barrier|bedrock|command_block(?:_minecart)?|chain_command_block|repeating_command_block|debug_stick|knowledge_book|light|jigsaw|structure_block|structure_void|spawner|trial_spawner|vault|reinforced_deepslate|budding_amethyst|end_portal_frame|player_head|petrified_oak_slab|spawn_egg|test_block|test_instance_block|frogspawn|chorus_plant|farmland|dirt_path|suspicious_sand|suspicious_gravel|infested_[a-z_]+)$/;
export function isSurvivalItem(itemId: string) {
  return !creativeOnly.test(itemId) && !itemId.endsWith("_spawn_egg");
}
