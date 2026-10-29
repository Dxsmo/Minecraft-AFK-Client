package de.afkservice.mixin;

import de.afkservice.SoulFireControls;
import com.soulfiremc.server.bot.BotConnection;
import net.minecraft.client.MouseHandler;
import org.spongepowered.asm.mixin.Mixin;
import org.spongepowered.asm.mixin.injection.At;
import org.spongepowered.asm.mixin.injection.Inject;
import org.spongepowered.asm.mixin.injection.callback.CallbackInfoReturnable;

/** Held mining requires Minecraft's gameplay pointer-capture state, even when
 * nobody has opened a POV stream. This affects the bot's virtual mouse only. */
@Mixin(MouseHandler.class)
public final class HeldMouseMixin {
  @Inject(method = "isMouseGrabbed", at = @At("HEAD"), cancellable = true)
  private void heldGameplayPointer(CallbackInfoReturnable<Boolean> cir) {
    var bot = BotConnection.currentOptional().orElse(null);
    if (bot != null && SoulFireControls.heldPointer(bot)) cir.setReturnValue(true);
  }
}
