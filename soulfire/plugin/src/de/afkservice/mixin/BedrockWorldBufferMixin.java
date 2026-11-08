package de.afkservice.mixin;

import org.spongepowered.asm.mixin.Mixin;
import org.spongepowered.asm.mixin.injection.Constant;
import org.spongepowered.asm.mixin.injection.ModifyConstant;

/** Dense farms exceed 10,000 small spawn/metadata packets before Java's
 * initialization acknowledgement. Retain the upstream 64 MiB byte ceiling;
 * allow the many small packets without discarding authoritative world state.
 */
@Mixin(targets = "net.raphimc.viabedrock.protocol.storage.WorldPacketBuffer", remap = false)
public abstract class BedrockWorldBufferMixin {
  @ModifyConstant(method = "queue", constant = @Constant(intValue = 10000))
  private int denseWorldPacketLimit(int original) { return 65536; }
}
