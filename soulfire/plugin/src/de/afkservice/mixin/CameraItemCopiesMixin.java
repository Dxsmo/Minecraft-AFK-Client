package de.afkservice.mixin;

import com.soulfiremc.server.bot.BotConnection;
import com.soulfiremc.server.renderer.VulkanRenderer;
import net.minecraft.client.renderer.entity.ItemEntityRenderer;
import net.minecraft.client.renderer.entity.state.ItemEntityRenderState;
import net.minecraft.world.entity.item.ItemEntity;
import org.spongepowered.asm.mixin.Mixin;
import org.spongepowered.asm.mixin.injection.At;
import org.spongepowered.asm.mixin.injection.Inject;
import org.spongepowered.asm.mixin.injection.callback.CallbackInfo;

@Mixin(ItemEntityRenderer.class)
public final class CameraItemCopiesMixin {
  @Inject(method = "extractRenderState(Lnet/minecraft/world/entity/item/ItemEntity;Lnet/minecraft/client/renderer/entity/state/ItemEntityRenderState;F)V", at = @At("TAIL"))
  private void oneModel(ItemEntity entity, ItemEntityRenderState state, float partialTick, CallbackInfo ci) {
    if (VulkanRenderer.isCapturing() && BotConnection.currentOptional().isPresent()) state.count = 1;
  }
}
