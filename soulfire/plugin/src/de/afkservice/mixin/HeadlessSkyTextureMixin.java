package de.afkservice.mixin;

import com.soulfiremc.server.bot.BotConnection;
import org.spongepowered.asm.mixin.Mixin;
import org.spongepowered.asm.mixin.injection.At;
import org.spongepowered.asm.mixin.injection.Inject;
import org.spongepowered.asm.mixin.injection.callback.CallbackInfo;

/** This process-wide display texture follows each bot's resource manager and
 * repeatedly schedules image loading without a native world resource context.
 * A headless bot needs neither the End sky image nor its GPU texture upload.
 * World resources, packet decoding and the rest of the client tick stay live.
 */
@Mixin(targets = "com.viaversion.viafabricplus.bedrock.appearance.BedrockEndSkyTexture", remap = false)
public abstract class HeadlessSkyTextureMixin {
  @Inject(method = "tick()V", at = @At("HEAD"), cancellable = true)
  private static void skipBotSkyTexture(CallbackInfo ci) {
    if (BotConnection.currentOptional().isPresent()) ci.cancel();
  }
}
