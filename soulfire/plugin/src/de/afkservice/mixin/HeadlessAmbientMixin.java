package de.afkservice.mixin;

import com.soulfiremc.server.bot.BotConnection;
import net.minecraft.client.multiplayer.ClientLevel;
import org.spongepowered.asm.mixin.Mixin;
import org.spongepowered.asm.mixin.injection.At;
import org.spongepowered.asm.mixin.injection.Inject;
import org.spongepowered.asm.mixin.injection.callback.CallbackInfo;

/** Vanilla samples 1,334 blocks per tick solely for ambient sounds/particles.
 * These display ticks trigger expensive custom-block lookups even on Java
 * clients. Server updates, world/entity ticks and inventory input run elsewhere.
 */
@Mixin(ClientLevel.class)
public abstract class HeadlessAmbientMixin {
  @Inject(method = "animateTick", at = @At("HEAD"), cancellable = true)
  private void skipAmbientSamples(int x, int y, int z, CallbackInfo ci) {
    if (BotConnection.currentOptional().isPresent()) ci.cancel();
  }
}
