package de.afkservice.mixin;

import io.netty.channel.socket.DatagramChannel;
import org.spongepowered.asm.mixin.Mixin;
import org.spongepowered.asm.mixin.injection.At;
import org.spongepowered.asm.mixin.injection.Inject;
import org.spongepowered.asm.mixin.injection.callback.CallbackInfo;

/** Dense Bedrock worlds arrive in UDP bursts. The Pi's default receive queue
 * drops packets before RakNet can read them; a bounded per-socket buffer gives
 * its event loop time to drain bursts. TCP and host-wide defaults are untouched.
 */
@Mixin(targets = "org.cloudburstmc.netty.channel.raknet.RakClientChannel", remap = false)
public abstract class BedrockReceiveBufferMixin {
  @Inject(method = "<init>(Lio/netty/channel/socket/DatagramChannel;)V", at = @At("RETURN"))
  private void enlargeReceiveQueue(DatagramChannel channel, CallbackInfo ci) {
    int requested = Math.max(channel.config().getReceiveBufferSize(), 4 * 1024 * 1024);
    channel.config().setReceiveBufferSize(requested);
    int actual = channel.config().getReceiveBufferSize();
    System.getLogger("afk-service.bedrock").log(
        actual < requested ? System.Logger.Level.WARNING : System.Logger.Level.INFO,
        "Bedrock UDP receive buffer: {0} bytes (requested {1})", actual, requested);
  }
}
