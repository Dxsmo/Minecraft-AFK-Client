package de.afkservice.mixin;

import de.afkservice.CameraBudget;
import com.soulfiremc.server.renderer.VulkanRenderer;
import com.soulfiremc.server.bot.BotConnection;
import net.minecraft.client.Minecraft;
import java.util.function.Function;
import org.spongepowered.asm.mixin.Mixin;
import org.spongepowered.asm.mixin.injection.At;
import org.spongepowered.asm.mixin.injection.Inject;
import org.spongepowered.asm.mixin.injection.callback.CallbackInfoReturnable;

@Mixin(value = VulkanRenderer.class, remap = false)
public final class CameraFrameMixin {
  @Inject(method = "renderWorld", at = @At("HEAD"))
  private static void start(Minecraft mc, VulkanRenderer.Options options, Function<?, ?> reader, CallbackInfoReturnable<Object> cir) {
    CameraBudget.begin(BotConnection.currentOptional().isPresent() && !options.forceDebugTrace());
  }
}
