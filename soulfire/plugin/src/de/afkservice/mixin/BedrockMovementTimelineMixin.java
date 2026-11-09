package de.afkservice.mixin;

import org.spongepowered.asm.mixin.Mixin;

/** Marker for StartupMixinPlugin's per-instance synchronization. SoulFire's
 * game thread reads this timeline while ViaBedrock's Netty thread changes it. */
@Mixin(targets = "net.raphimc.viabedrock.api.model.MovementEffectTimeline", remap = false)
public abstract class BedrockMovementTimelineMixin {}
