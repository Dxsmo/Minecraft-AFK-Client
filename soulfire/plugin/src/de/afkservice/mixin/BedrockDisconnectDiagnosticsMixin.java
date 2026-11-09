package de.afkservice.mixin;

import io.netty.channel.ChannelHandlerContext;
import io.netty.util.AttributeKey;
import org.spongepowered.asm.mixin.Mixin;
import org.spongepowered.asm.mixin.Unique;
import org.spongepowered.asm.mixin.injection.At;
import org.spongepowered.asm.mixin.injection.Inject;
import org.spongepowered.asm.mixin.injection.callback.CallbackInfo;

/** Preserve RakNet's transport reason before vanilla reduces it to EOF. */
@Mixin(targets = "net.raphimc.viabedrock.netty.DisconnectHandler", remap = false)
public abstract class BedrockDisconnectDiagnosticsMixin {
  @Unique private boolean afk$reported;

  @Inject(method = "userEventTriggered", at = @At("HEAD"))
  private void reportTransportClose(ChannelHandlerContext context, Object event, CallbackInfo ci) {
    if (!event.getClass().getName().equals("org.cloudburstmc.netty.channel.raknet.RakDisconnectReason")) return;
    String reason = event.toString();
    context.channel().attr(AttributeKey.<String>valueOf("afk-service:bedrock-disconnect")).set(reason);
    if (afk$reported) return;
    afk$reported = true;
    System.err.println("[afk-service] Bedrock transport closed: " + reason
        + " (socket=" + context.channel().localAddress() + ")");
  }
}
