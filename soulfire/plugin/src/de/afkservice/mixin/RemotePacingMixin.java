package de.afkservice.mixin;

import de.afkservice.CameraPacing;
import com.soulfiremc.server.bot.BotConnection;
import org.spongepowered.asm.mixin.Mixin;
import org.spongepowered.asm.mixin.Shadow;
import org.spongepowered.asm.mixin.Final;
import org.spongepowered.asm.mixin.Unique;
import org.spongepowered.asm.mixin.injection.At;
import org.spongepowered.asm.mixin.injection.Inject;
import org.spongepowered.asm.mixin.injection.ModifyArg;
import org.spongepowered.asm.mixin.injection.callback.CallbackInfo;

@Mixin(targets = "com.soulfiremc.server.grpc.PovServiceImpl$Session", remap = false)
public final class RemotePacingMixin {
  @Shadow @Final private BotConnection bot;
  @Unique private long afk$frameStart;
  @Inject(method = "frame", at = @At("HEAD"))
  private void started(CallbackInfo ci) { afk$frameStart = System.nanoTime(); }
  @ModifyArg(method = "frame", at = @At(value = "INVOKE", target = "Lcom/soulfiremc/server/grpc/PovServiceImpl$Session;schedule(J)V"), index = 0)
  private long pace(long delayNanos) {
    if (!bot.settingsSource().stem().settings().containsKey("afk-service")) return delayNanos;
    return CameraPacing.delayNanos(delayNanos, System.nanoTime() - afk$frameStart);
  }
}
