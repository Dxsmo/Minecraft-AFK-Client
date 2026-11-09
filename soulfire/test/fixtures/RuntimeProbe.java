package de.afkservice;

import com.google.gson.Gson;
import com.soulfiremc.server.api.SoulFireAPI;
import com.soulfiremc.server.api.event.bot.BotPreTickEvent;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.concurrent.atomic.AtomicBoolean;
import net.fabricmc.api.ModInitializer;

/** Test-only: uses a real offline bot; no Microsoft identity or server login. */
public final class RuntimeProbe implements ModInitializer {
  public static final ThreadLocal<Integer> SAMPLES = ThreadLocal.withInitial(() -> 0);
  private static final AtomicBoolean RAN = new AtomicBoolean();

  @Override public void onInitialize() {
    SoulFireAPI.registerListener(BotPreTickEvent.class, event -> {
      var mc = event.connection().minecraft();
      if (mc.player == null || mc.level == null || !RAN.compareAndSet(false, true)) return;
      var result = new LinkedHashMap<String, Object>();
      try {
        SAMPLES.set(0);
        for (int i = 0; i < 20; i++) mc.level.animateTick(0, 64, 0);
        result.put("ambientSamples", SAMPLES.get());
        result.put("botContext", com.soulfiremc.server.bot.BotConnection.currentOptional().isPresent());
        var sky = Class.forName("com.viaversion.viafabricplus.bedrock.appearance.BedrockEndSkyTexture");
        sky.getMethod("clear").invoke(null);
        for (int i = 0; i < 20; i++) sky.getMethod("tick").invoke(null);
        var pendingSky = sky.getDeclaredField("pending");
        pendingSky.setAccessible(true);
        var skyResources = sky.getDeclaredField("resources");
        skyResources.setAccessible(true);
        result.put("skyLoadScheduled", pendingSky.get(null) != null);
        result.put("skyResourcesChanged", skyResources.get(null) != null);
        sky.getMethod("clear").invoke(null);
        var protocolType = Class.forName("com.viaversion.viaversion.api.protocol.version.ProtocolVersion");
        var bedrock = Class.forName("net.raphimc.viabedrock.api.BedrockProtocolVersion").getField("BEDROCK_LATEST").get(null);
        var parse = Class.forName("com.soulfiremc.server.bot.BotConnectionFactory").getMethod("parseAddress", String.class, protocolType);
        var access = Class.forName("com.viaversion.viafabricplus.bedrock.injection.access.IServerAddress").getMethod("viaFabricPlusBedrock$getNetherNetAddress");
        var addresses = new ArrayList<Map<String, Object>>();
        for (String input : new String[]{"example.invalid:19132", "127.0.0.1:19133", "[::1]:19134", "nethernet://example.invalid:19135"}) {
          var address = parse.invoke(null, input, bedrock);
          addresses.add(Map.of("input", input, "host", address.getClass().getMethod("getHost").invoke(address),
              "port", address.getClass().getMethod("getPort").invoke(address), "nethernet", access.invoke(address) != null));
        }
        result.put("bedrockAddresses", addresses);
        var javaAddress = parse.invoke(null, "example.invalid", protocolType.getField("v1_8").get(null));
        result.put("javaPort", javaAddress.getClass().getMethod("getPort").invoke(javaAddress));
        result.put("javaNethernet", access.invoke(javaAddress) != null);
        var bufferClass = Class.forName("net.raphimc.viabedrock.protocol.storage.WorldPacketBuffer");
        var packetClass = Class.forName("net.raphimc.viabedrock.protocol.ClientboundBedrockPackets");
        Object packet = packetClass.getEnumConstants()[0];
        var queue = bufferClass.getMethod("queue", packetClass, byte[].class);
        Object buffer = bufferClass.getConstructor().newInstance();
        int count = 0;
        for (; count < 70_000; count++) {
          try { queue.invoke(buffer, packet, new byte[1]); }
          catch (java.lang.reflect.InvocationTargetException error) {
            if (!(error.getCause() instanceof IllegalStateException)) throw error;
            break;
          }
        }
        result.put("worldBufferPacketLimit", count);
        Object bounded = bufferClass.getConstructor().newInstance();
        boolean byteLimit = false;
        try { queue.invoke(bounded, packet, new byte[64 * 1024 * 1024 + 1]); }
        catch (java.lang.reflect.InvocationTargetException error) {
          if (!(error.getCause() instanceof IllegalStateException)) throw error;
          byteLimit = true;
        }
        result.put("worldBufferRejectsOver64MiB", byteLimit);
        var sink = new java.util.concurrent.atomic.AtomicInteger();
        bufferClass.getMethod("drain", java.util.function.BiConsumer.class).invoke(buffer,
            (java.util.function.BiConsumer<Object, byte[]>) (type, payload) -> sink.addAndGet(payload.length));
        result.put("worldBufferDrainedBytes", sink.get());
        result.put("worldBufferAfterDrain", bufferClass.getMethod("packetCount").invoke(buffer));
      } catch (Throwable error) { result.put("error", error.toString()); }
      try { Files.writeString(Path.of("/data/afk-runtime-probe.json"), new Gson().toJson(result)); }
      catch (Exception error) { throw new IllegalStateException(error); }
    });
  }
}
