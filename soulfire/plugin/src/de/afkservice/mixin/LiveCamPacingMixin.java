package de.afkservice.mixin;

import de.afkservice.CameraPacing;
import com.soulfiremc.grpc.generated.BotRenderPovRequest;
import org.spongepowered.asm.mixin.Mixin;
import org.spongepowered.asm.mixin.Shadow;
import org.spongepowered.asm.mixin.Final;
import org.spongepowered.asm.mixin.Unique;
import org.spongepowered.asm.mixin.injection.At;
import org.spongepowered.asm.mixin.injection.Inject;
import org.spongepowered.asm.mixin.injection.ModifyArg;
import org.spongepowered.asm.mixin.injection.callback.CallbackInfo;

@Mixin(targets = "com.soulfiremc.server.grpc.BotServiceImpl$1", remap = false)
public final class LiveCamPacingMixin {
  @Shadow @Final private BotRenderPovRequest val$renderRequest;
  @Unique private long afk$frameStart;
  @Inject(method = "run", at = @At("HEAD"))
  private void started(CallbackInfo ci) { afk$frameStart = System.nanoTime(); }
  @ModifyArg(method = "run", at = @At(value = "INVOKE", target = "Lcom/soulfiremc/server/SoulFireScheduler;schedule(Ljava/lang/Runnable;JLjava/util/concurrent/TimeUnit;)V"), index = 1)
  private long pace(long delayMs) {
    if (val$renderRequest.getIncludeDebugTrace() || val$renderRequest.getWidth() > 480 || val$renderRequest.getHeight() > 270) return delayMs;
    return CameraPacing.delayNanos(delayMs * 1_000_000L, System.nanoTime() - afk$frameStart) / 1_000_000L;
  }
}
