package de.afkservice.mixin;

import org.spongepowered.asm.mixin.Mixin;
import org.spongepowered.asm.mixin.Shadow;
import org.spongepowered.asm.mixin.Final;
import org.spongepowered.asm.mixin.Unique;
import org.spongepowered.asm.mixin.injection.Inject;
import org.spongepowered.asm.mixin.injection.callback.CallbackInfo;
import org.spongepowered.asm.mixin.injection.Constant;
import org.spongepowered.asm.mixin.injection.ModifyConstant;
import org.spongepowered.asm.mixin.injection.ModifyArg;
import org.spongepowered.asm.mixin.injection.At;

/** Dense farms exceed 10,000 small spawn/metadata packets before Java's
 * initialization acknowledgement. Retain the upstream 64 MiB byte ceiling;
 * The Pi has also reached 65,536 packets at only 3 MiB during world entry.
 * Allow at most 262,144 packets plus the unchanged byte bound; never drop
 * authoritative packets or bypass the client initialization acknowledgement.
 * Allow the many small packets without discarding authoritative world state.
 */
@Mixin(targets = "net.raphimc.viabedrock.protocol.storage.WorldPacketBuffer", remap = false)
public abstract class BedrockWorldBufferMixin {
  @Shadow @Final private java.util.Queue<?> packets;
  @Shadow private int bytes;
  @Unique private long afk$firstQueued;

  @Inject(method = "queue", at = @At("HEAD"))
  private void markInitializationWait(@org.spongepowered.asm.mixin.injection.Coerce Object type, byte[] payload, CallbackInfo ci) {
    if (packets.isEmpty()) afk$firstQueued = System.nanoTime();
  }

  @ModifyConstant(method = "queue", constant = @Constant(intValue = 10000))
  private int denseWorldPacketLimit(int original) { return 262144; }

  @ModifyArg(method = "queue", at = @At(value = "INVOKE",
      target = "Ljava/lang/IllegalStateException;<init>(Ljava/lang/String;)V"), index = 0)
  private String describeOverflow(String message) {
    return message + " (packets=" + packets.size() + ", bytes=" + bytes + ", waitMs=" + ((System.nanoTime() - afk$firstQueued) / 1_000_000L) + ")";
  }
}
