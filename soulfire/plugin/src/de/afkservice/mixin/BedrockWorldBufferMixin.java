package de.afkservice.mixin;

import org.spongepowered.asm.mixin.Mixin;
import org.spongepowered.asm.mixin.Shadow;
import org.spongepowered.asm.mixin.Final;
import org.spongepowered.asm.mixin.injection.Constant;
import org.spongepowered.asm.mixin.injection.ModifyConstant;
import org.spongepowered.asm.mixin.injection.ModifyArg;
import org.spongepowered.asm.mixin.injection.At;

/** Dense farms exceed 10,000 small spawn/metadata packets before Java's
 * initialization acknowledgement. Retain the upstream 64 MiB byte ceiling;
 * allow the many small packets without discarding authoritative world state.
 */
@Mixin(targets = "net.raphimc.viabedrock.protocol.storage.WorldPacketBuffer", remap = false)
public abstract class BedrockWorldBufferMixin {
  @Shadow @Final private java.util.Queue<?> packets;
  @Shadow private int bytes;

  @ModifyConstant(method = "queue", constant = @Constant(intValue = 10000))
  private int denseWorldPacketLimit(int original) { return 65536; }

  @ModifyArg(method = "queue", at = @At(value = "INVOKE",
      target = "Ljava/lang/IllegalStateException;<init>(Ljava/lang/String;)V"), index = 0)
  private String describeOverflow(String message) {
    return message + " (packets=" + packets.size() + ", bytes=" + bytes + ")";
  }
}
