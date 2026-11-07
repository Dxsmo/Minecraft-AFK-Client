package de.afkservice.mixin;

import com.soulfiremc.server.bot.BotConnection;
import de.afkservice.NativeAutoSell;
import net.minecraft.client.multiplayer.ClientPacketListener;
import net.minecraft.network.protocol.game.ClientboundContainerSetContentPacket;
import net.minecraft.network.protocol.game.ClientboundContainerSetSlotPacket;
import net.minecraft.network.protocol.game.ClientboundOpenScreenPacket;
import net.minecraft.network.protocol.game.ClientboundSystemChatPacket;
import org.spongepowered.asm.mixin.Mixin;
import org.spongepowered.asm.mixin.injection.At;
import org.spongepowered.asm.mixin.injection.Inject;
import org.spongepowered.asm.mixin.injection.callback.CallbackInfo;

/** Observe authoritative packets after vanilla has applied them. Local click
 * prediction is never an acknowledgment, nor is an unrelated player's slot. */
@Mixin(ClientPacketListener.class)
public final class SellInventoryMixin {
  @Inject(method = "handleSystemChat", at = @At("TAIL"))
  private void serverMessage(ClientboundSystemChatPacket packet, CallbackInfo ci) {
    // Stop on the game thread before an asynchronously delivered website chat
    // event can lag behind another batch of inventory clicks.
    BotConnection.currentOptional().ifPresent(bot -> NativeAutoSell.inventoryMessage(bot, packet.content().getString()));
  }
  @Inject(method = "handleOpenScreen", at = @At("TAIL"))
  private void opened(ClientboundOpenScreenPacket packet, CallbackInfo ci) {
    BotConnection.currentOptional().ifPresent(bot -> NativeAutoSell.opened(bot, packet.getContainerId()));
  }
  @Inject(method = "handleContainerContent", at = @At("TAIL"))
  private void content(ClientboundContainerSetContentPacket packet, CallbackInfo ci) {
    BotConnection.currentOptional().ifPresent(bot -> NativeAutoSell.inventoryAck(bot, packet.containerId(), -1));
  }
  @Inject(method = "handleContainerSetSlot", at = @At("TAIL"))
  private void slot(ClientboundContainerSetSlotPacket packet, CallbackInfo ci) {
    BotConnection.currentOptional().ifPresent(bot -> NativeAutoSell.inventoryAck(bot, packet.getContainerId(), packet.getSlot()));
  }
}
