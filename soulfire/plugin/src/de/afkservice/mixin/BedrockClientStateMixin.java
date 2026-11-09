package de.afkservice.mixin;

import org.spongepowered.asm.mixin.Mixin;

/** Marker for checked static-field virtualization in StartupMixinPlugin. */
@Mixin(targets = {
  "com.viaversion.viafabricplus.bedrock.input.BedrockInputPermissions",
  "com.viaversion.viafabricplus.bedrock.input.BedrockItemUse",
  "com.viaversion.viafabricplus.bedrock.input.BedrockMovementEffects",
  "com.viaversion.viafabricplus.bedrock.input.BedrockPhysicalReplay",
  "com.viaversion.viafabricplus.bedrock.input.BedrockPhysicalReplay$Session",
  "com.viaversion.viafabricplus.bedrock.input.BedrockPlayerCorrections",
  "com.viaversion.viafabricplus.bedrock.input.BedrockPlayerModes",
  "com.viaversion.viafabricplus.bedrock.input.BedrockRemotePlayerMovement",
  "com.viaversion.viafabricplus.bedrock.input.BedrockVehiclePredictions",
  "com.viaversion.viafabricplus.bedrock.render.BedrockActorState",
  "com.viaversion.viafabricplus.bedrock.render.BedrockProjectileOwners",
  "com.viaversion.viafabricplus.bedrock.appearance.BedrockNativeBlocks",
  "com.viaversion.viafabricplus.bedrock.screen.container.BedrockNativeContainers",
  "com.viaversion.viafabricplus.bedrock.screen.container.BedrockNativePlayerInventory",
  "com.viaversion.viafabricplus.bedrock.screen.container.BedrockPlayerInventory"
}, remap = false, priority = 900)
public abstract class BedrockClientStateMixin {}
