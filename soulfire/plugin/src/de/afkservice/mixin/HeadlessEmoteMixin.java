package de.afkservice.mixin;

import com.soulfiremc.server.bot.BotConnection;
import org.spongepowered.asm.mixin.Mixin;
import org.spongepowered.asm.mixin.injection.At;
import org.spongepowered.asm.mixin.injection.Inject;
import org.spongepowered.asm.mixin.injection.callback.CallbackInfo;

/** The Bedrock add-on has one process-wide emote-wheel account. Every bot
 * tick switches that account and starts another wardrobe request. Its async
 * completion uses the unscoped Minecraft singleton, whose queue is never
 * ticked by SoulFire. The Pi retained 739,456 callbacks and their HTTP errors.
 * Automated clients have no emote-wheel UI; skip its background catalogue.
 * Authentication, skins, protocol handling and normal bot ticks stay live. */
@Mixin(targets = "com.viaversion.viafabricplus.bedrock.appearance.BedrockEmotePlayback", remap = false)
public abstract class HeadlessEmoteMixin {
  @Inject(method = "refresh()V", at = @At("HEAD"), cancellable = true)
  private static void skipBotCatalogue(CallbackInfo ci) {
    if (BotConnection.currentOptional().isPresent()) ci.cancel();
  }
}
