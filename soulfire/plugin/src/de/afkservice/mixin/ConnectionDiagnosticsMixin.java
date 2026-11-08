package de.afkservice.mixin;

import com.soulfiremc.server.bot.BotConnection;
import io.netty.channel.ChannelHandlerContext;
import io.netty.handler.codec.DecoderException;
import net.minecraft.network.Connection;
import org.spongepowered.asm.mixin.Mixin;
import org.spongepowered.asm.mixin.Unique;
import org.spongepowered.asm.mixin.injection.At;
import org.spongepowered.asm.mixin.injection.Inject;
import org.spongepowered.asm.mixin.injection.callback.CallbackInfo;

/** Vanilla's ordinary disconnect reason discards the decoder's cause. Keep a
 * bounded full stack trace in the private service log, without packet payloads.
 */
@Mixin(Connection.class)
public abstract class ConnectionDiagnosticsMixin {
  @Unique private long afk$lastDecoderWarning;

  @Inject(method = "exceptionCaught", at = @At("HEAD"))
  private void reportDecoderCause(ChannelHandlerContext context, Throwable error, CallbackInfo ci) {
    long now = System.currentTimeMillis();
    if (!(error instanceof DecoderException) || now - afk$lastDecoderWarning < 30_000) return;
    afk$lastDecoderWarning = now;
    String account = BotConnection.currentOptional().map(BotConnection::accountName).orElse("ohne Bot-Kontext");
    System.getLogger("afk-service.connection").log(System.Logger.Level.WARNING,
        "Minecraft-Paketfehler (" + account + "): vollständige Decoder-Ursache", error);
  }
}
