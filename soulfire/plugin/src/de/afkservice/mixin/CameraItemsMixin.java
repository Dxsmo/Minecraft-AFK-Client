package de.afkservice.mixin;

import de.afkservice.CameraBudget;
import com.soulfiremc.server.bot.BotConnection;
import com.soulfiremc.server.renderer.VulkanRenderer;
import net.minecraft.client.renderer.entity.EntityRenderer;
import net.minecraft.client.renderer.culling.Frustum;
import net.minecraft.world.entity.Entity;
import net.minecraft.world.entity.item.ItemEntity;
import org.spongepowered.asm.mixin.Mixin;
import org.spongepowered.asm.mixin.injection.At;
import org.spongepowered.asm.mixin.injection.Inject;
import org.spongepowered.asm.mixin.injection.callback.CallbackInfoReturnable;

@Mixin(EntityRenderer.class)
public final class CameraItemsMixin {
  @Inject(method = "shouldRender", at = @At("RETURN"), cancellable = true)
  private void limitPile(Entity entity, Frustum frustum, double x, double y, double z, float partialTick, CallbackInfoReturnable<Boolean> cir) {
    if (cir.getReturnValue() && entity instanceof ItemEntity && VulkanRenderer.isCapturing()
        && BotConnection.currentOptional().isPresent() && !CameraBudget.item()) cir.setReturnValue(false);
  }
}
