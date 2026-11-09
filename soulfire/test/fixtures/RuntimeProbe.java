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
      BedrockIsolationProbe.observe(event.connection());
      var mc = event.connection().minecraft();
      if (mc.player == null || mc.level == null || !RAN.compareAndSet(false, true)) return;
      var result = new LinkedHashMap<String, Object>();
      try {
        result.put("movementTimelineRace", TimelineRace.run());
        SAMPLES.set(0);
        for (int i = 0; i < 20; i++) mc.level.animateTick(0, 64, 0);
        result.put("ambientSamples", SAMPLES.get());
        result.put("botContext", com.soulfiremc.server.bot.BotConnection.currentOptional().isPresent());
        var disconnectHandler = (io.netty.channel.ChannelHandler) Class.forName("net.raphimc.viabedrock.netty.DisconnectHandler").getConstructor().newInstance();
        var transport = new io.netty.channel.embedded.EmbeddedChannel(disconnectHandler);
        var disconnectReason = Class.forName("org.cloudburstmc.netty.channel.raknet.RakDisconnectReason").getField("CLOSED_BY_REMOTE_PEER").get(null);
        transport.pipeline().fireUserEventTriggered(disconnectReason);
        result.put("bedrockTransportCloseReason", transport.attr(io.netty.util.AttributeKey.<String>valueOf("afk-service:bedrock-disconnect")).get());
        transport.finishAndReleaseAll();
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
        try (var socket = java.nio.channels.DatagramChannel.open();
             var sender = new java.net.DatagramSocket()) {
          socket.configureBlocking(false);
          result.put("udpReceiveBufferBefore", socket.socket().getReceiveBufferSize());
          var datagram = new io.netty.channel.socket.nio.NioDatagramChannel(socket);
          Class.forName("org.cloudburstmc.netty.channel.raknet.RakClientChannel")
              .getConstructor(io.netty.channel.socket.DatagramChannel.class).newInstance(datagram);
          result.put("udpReceiveBufferAfter", socket.socket().getReceiveBufferSize());
          socket.bind(new java.net.InetSocketAddress(java.net.InetAddress.getLoopbackAddress(), 0));
          byte[] payload = new byte[1200];
          for (int i = 0; i < 600; i++) sender.send(new java.net.DatagramPacket(payload, payload.length, socket.getLocalAddress()));
          var incoming = java.nio.ByteBuffer.allocate(1500);
          int received = 0;
          long deadline = System.nanoTime() + 100_000_000L;
          while (System.nanoTime() < deadline) {
            incoming.clear();
            if (socket.receive(incoming) != null) received++;
          }
          result.put("udpBurstSent", 600);
          result.put("udpBurstReceived", received);
        }
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
        for (; count < 270_000; count++) {
          try { queue.invoke(buffer, packet, new byte[1]); }
          catch (java.lang.reflect.InvocationTargetException error) {
            if (!(error.getCause() instanceof IllegalStateException)) throw error;
            result.put("worldBufferOverflow", error.getCause().getMessage());
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
