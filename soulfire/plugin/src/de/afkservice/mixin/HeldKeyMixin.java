package de.afkservice.mixin;

import de.afkservice.SoulFireControls;

import com.soulfiremc.server.bot.BotConnection;
import net.minecraft.client.KeyMapping;
import org.spongepowered.asm.mixin.Mixin;
import org.spongepowered.asm.mixin.injection.At;
import org.spongepowered.asm.mixin.injection.Inject;
import org.spongepowered.asm.mixin.injection.callback.CallbackInfo;

@Mixin(KeyMapping.class)
public final class HeldKeyMixin {
  @Inject(method = "setDown", at = @At("HEAD"), cancellable = true)
  private void keepHeld(boolean pressed, CallbackInfo ci) {
    if (pressed) return;
    var bot = BotConnection.currentOptional().orElse(null);
    if (bot != null && SoulFireControls.forcedDown(bot, (KeyMapping) (Object) this)) ci.cancel();
  }
}
