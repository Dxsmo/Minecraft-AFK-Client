package de.afkservice;

import com.soulfiremc.server.bot.BotConnection;
import java.lang.ScopedValue;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.atomic.AtomicBoolean;

/** Two actual offline connections, actual transformed client methods. */
public final class BedrockIsolationProbe {
  private static final Map<UUID, BotConnection> BOTS = new ConcurrentHashMap<>();
  private static final AtomicBoolean RAN = new AtomicBoolean();
  @SuppressWarnings("unchecked")
  public static void observe(BotConnection bot) {
    BOTS.putIfAbsent(bot.accountProfileId(), bot);
    if (BOTS.size() < 2 || !RAN.compareAndSet(false, true)) return;
    var result = new LinkedHashMap<String, Object>();
    try {
      var current = BotConnection.class.getDeclaredField("CURRENT"); current.setAccessible(true);
      var key = (ScopedValue<BotConnection>) current.get(null);
      var bots = BOTS.values().stream().limit(2).toList();
      var values = new Object[2][];
      for (int index = 0; index < 2; index++) {
        final int slot = index;
        ScopedValue.where(key, bots.get(index)).run(() -> {
          var initialized = new java.util.ArrayList<Object>();
          for (var entry : BedrockStateFields.FIELDS.entrySet()) {
            try {
              var owner = Class.forName(entry.getKey().replace('/', '.'));
              for (String name : entry.getValue()) {
                var field = owner.getDeclaredField(name); field.setAccessible(true);
                initialized.add(BedrockClientState.read(field.get(null), entry.getKey() + "#" + name));
              }
            } catch (ReflectiveOperationException error) { throw new IllegalStateException(error); }
          }
          values[slot] = initialized.toArray();
        });
      }
      var fieldNames = BedrockStateFields.FIELDS.entrySet().stream().flatMap(entry -> entry.getValue().stream().map(name -> entry.getKey() + "#" + name)).toList();
      int independent = 0;
      for (int index = 0; index < values[0].length; index++) {
        Object a = values[0][index], b = values[1][index];
        if (a == null || a instanceof Number || a instanceof Boolean || a instanceof Enum<?> || a.getClass().isRecord()) continue;
        if (a == b) throw new IllegalStateException("Mutable Bedrock client state was shared: " + fieldNames.get(index) + " type=" + a.getClass().getName());
        independent++;
      }
      result.put("fieldsInitializedPerClient", values[0].length);
      result.put("independentMutableObjects", independent);
      String owner = "com/viaversion/viafabricplus/bedrock/input/BedrockMovementEffects";
      var effects = Class.forName(owner.replace('/', '.'));
      var timelineField = effects.getDeclaredField("TIMELINE"); timelineField.setAccessible(true);
      var globalTimeline = timelineField.get(null);
      var timelineType = globalTimeline.getClass();
      var actualFrame = new long[2];
      for (int index = 0; index < 2; index++) {
        final int slot = index;
        ScopedValue.where(key, bots.get(index)).run(() -> {
          try {
            Object timeline = BedrockClientState.read(globalTimeline, owner + "#TIMELINE");
            if (slot == 0) { timelineType.getMethod("beginFrame").invoke(timeline); timelineType.getMethod("completeFrame").invoke(timeline); }
            long expected = (long) timelineType.getMethod("frameId").invoke(timeline);
            actualFrame[slot] = (long) effects.getMethod("frameId").invoke(null);
            if (expected != actualFrame[slot]) throw new IllegalStateException("Transformed Bedrock frameId used another client's timeline: expected=" + expected + " actual=" + actualFrame[slot]);
          } catch (ReflectiveOperationException error) { throw new IllegalStateException(error); }
        });
      }
      if (actualFrame[0] == actualFrame[1]) throw new IllegalStateException("Client timelines advanced together");
      var actors = Class.forName("com.viaversion.viafabricplus.bedrock.render.BedrockActorState");
      String actorFlag = actors.getName().replace('.', '/') + "#uniqueIdsAvailable";
      ScopedValue.where(key, bots.getFirst()).run(() -> BedrockClientState.write(true, actorFlag));
      ScopedValue.where(key, bots.get(1)).run(() -> {
        try {
          actors.getMethod("clear").invoke(null);
          if ((boolean) actors.getMethod("supportsUniqueIds").invoke(null)) throw new IllegalStateException("Client B inherited A's actor mode");
        } catch (ReflectiveOperationException error) { throw new IllegalStateException(error); }
      });
      ScopedValue.where(key, bots.getFirst()).run(() -> {
        try {
          if (!(boolean) actors.getMethod("supportsUniqueIds").invoke(null)) throw new IllegalStateException("Clearing B reset A's actor state");
          if ((long) effects.getMethod("frameId").invoke(null) != actualFrame[0]) throw new IllegalStateException("Clearing B changed A's timeline");
        } catch (ReflectiveOperationException error) { throw new IllegalStateException(error); }
      });
      result.put("timelineA", actualFrame[0]); result.put("timelineB", actualFrame[1]);
      result.put("otherClientClearPreservedState", true);
      result.put("passed", true);
    } catch (Throwable error) {
      result.put("passed", false); result.put("error", error.toString());
      if (error.getCause() != null) result.put("cause", error.getCause().toString());
    }
    try { Files.writeString(Path.of("/data/afk-bedrock-isolation.json"), new com.google.gson.Gson().toJson(result)); }
    catch (Exception error) { throw new IllegalStateException(error); }
  }
}
