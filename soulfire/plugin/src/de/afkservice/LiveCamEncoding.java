package de.afkservice;

import com.soulfiremc.server.bot.BotConnection;
import java.awt.image.BufferedImage;
import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.util.Base64;
import javax.imageio.IIOImage;
import javax.imageio.ImageIO;
import javax.imageio.ImageWriteParam;
import javax.imageio.stream.MemoryCacheImageOutputStream;

/** Encode on the RPC worker, after native rendering has released the game thread. */
public final class LiveCamEncoding {
  public static boolean enabled(BotConnection bot, boolean debug) {
    return !debug && bot.settingsSource().stem().settings().containsKey("afk-service");
  }

  public static String jpeg(BufferedImage image) {
    var rgb = new BufferedImage(image.getWidth(), image.getHeight(), BufferedImage.TYPE_INT_RGB);
    var graphics = rgb.createGraphics();
    try { graphics.drawImage(image, 0, 0, null); } finally { graphics.dispose(); }
    var writer = ImageIO.getImageWritersByFormatName("jpeg").next();
    try (var bytes = new ByteArrayOutputStream(); var output = new MemoryCacheImageOutputStream(bytes)) {
      var parameters = writer.getDefaultWriteParam();
      parameters.setCompressionMode(ImageWriteParam.MODE_EXPLICIT);
      parameters.setCompressionQuality(.72F);
      writer.setOutput(output);
      writer.write(null, new IIOImage(rgb, null, null), parameters);
      output.flush();
      return Base64.getEncoder().encodeToString(bytes.toByteArray());
    } catch (IOException error) { throw new IllegalStateException("Failed to encode live camera image", error); }
    finally { writer.dispose(); }
  }
}
