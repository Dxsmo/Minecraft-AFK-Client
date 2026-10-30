package de.afkservice.mixin;

import com.soulfiremc.server.bot.BotConnection;
import net.minecraft.client.multiplayer.ClientPacketListener;
import net.minecraft.network.chat.Component;
import org.spongepowered.asm.mixin.Mixin;
import org.spongepowered.asm.mixin.injection.At;
import org.spongepowered.asm.mixin.injection.Inject;
import org.spongepowered.asm.mixin.injection.callback.CallbackInfo;

/** Also covers commands entered through the native remote-control chat. */
@Mixin(ClientPacketListener.class)
public final class BlockedCommandMixin {
  private static boolean blocked(String text) {
    return text.trim().matches("(?i)^/?(?:[a-z0-9_.-]+:)?afk(?:\\s.*)?$");
  }
  private static void explain() {
    BotConnection.currentOptional().ifPresent(bot -> bot.minecraft().gui.chatListener().handleSystemMessage(
      Component.literal("Mit den Accounts über den AFK-Client ist es nicht erlaubt, Stars zu farmen!!"), false));
  }
  @Inject(method = "sendCommand", at = @At("HEAD"), cancellable = true)
  private void blockCommand(String command, CallbackInfo ci) {
    if (blocked(command)) { explain(); ci.cancel(); }
  }
  @Inject(method = "sendChat", at = @At("HEAD"), cancellable = true)
  private void blockChatCommand(String message, CallbackInfo ci) {
    if (message.startsWith("/") && blocked(message)) { explain(); ci.cancel(); }
  }
}
