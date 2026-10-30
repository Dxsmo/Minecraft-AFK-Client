package de.afkservice.mixin;

import de.afkservice.LiveCamEncoding;
import com.soulfiremc.server.bot.BotConnection;
import com.soulfiremc.server.grpc.BotServiceImpl;
import com.soulfiremc.grpc.generated.BotRenderPovRequest;
import com.soulfiremc.grpc.generated.BotRenderPovResponse;
import java.awt.image.BufferedImage;
import org.spongepowered.asm.mixin.Mixin;
import org.spongepowered.asm.mixin.Shadow;
import org.spongepowered.asm.mixin.injection.At;
import org.spongepowered.asm.mixin.injection.Redirect;

/** Only website camera snapshots change format. Inventory icons/debug stay PNG. */
@Mixin(value = BotServiceImpl.class, remap = false)
public final class LiveCamEncodingMixin {
  @Shadow private static String toBase64PNG(BufferedImage image) { throw new AssertionError(); }

  @Redirect(method = "lambda$renderPovFrame$0", at = @At(value = "INVOKE", target = "Lcom/soulfiremc/server/grpc/BotServiceImpl;toBase64PNG(Ljava/awt/image/BufferedImage;)Ljava/lang/String;"))
  private static String encode(BufferedImage image, BotConnection bot, BotRenderPovRequest request, int width, int height, boolean hud, boolean hands) {
    return LiveCamEncoding.enabled(bot, request.getIncludeDebugTrace()) ? LiveCamEncoding.jpeg(image) : toBase64PNG(image);
  }

  @Redirect(method = "lambda$renderPovFrame$0", at = @At(value = "INVOKE", target = "Lcom/soulfiremc/grpc/generated/BotRenderPovResponse$Builder;setImageMimeType(Ljava/lang/String;)Lcom/soulfiremc/grpc/generated/BotRenderPovResponse$Builder;"))
  private static BotRenderPovResponse.Builder mime(BotRenderPovResponse.Builder response, String mime, BotConnection bot, BotRenderPovRequest request, int width, int height, boolean hud, boolean hands) {
    return response.setImageMimeType(LiveCamEncoding.enabled(bot, request.getIncludeDebugTrace()) ? "image/jpeg" : mime);
  }
}
