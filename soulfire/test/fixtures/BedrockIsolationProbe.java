package de.afkservice;

import com.soulfiremc.server.bot.BotConnection;
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
  public static void observe(BotConnection bot) {
    if (bot.minecraft().player == null || bot.minecraft().level == null) return;
    BOTS.putIfAbsent(bot.accountProfileId(), bot);
    if (BOTS.size() < 2 || !RAN.compareAndSet(false, true)) return;
    var result = new LinkedHashMap<String, Object>();
    try {
      var bots = BOTS.values().stream().limit(2).toList();
      var values = new Object[2][];
      for (int index = 0; index < 2; index++) {
        final int slot = index;
        bots.get(index).runnableWrapper().runWrapped(() -> {
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
        if (a == null || a instanceof Number || a instanceof Boolean || a instanceof String || a instanceof Enum<?> || a.getClass().isRecord()) continue;
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
        bots.get(index).runnableWrapper().runWrapped(() -> {
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
      bots.getFirst().runnableWrapper().runWrapped(() -> BedrockClientState.write(true, actorFlag));
      bots.get(1).runnableWrapper().runWrapped(() -> {
        try {
          actors.getMethod("clear").invoke(null);
          if ((boolean) actors.getMethod("supportsUniqueIds").invoke(null)) throw new IllegalStateException("Client B inherited A's actor mode");
        } catch (ReflectiveOperationException error) { throw new IllegalStateException(error); }
      });
      bots.getFirst().runnableWrapper().runWrapped(() -> {
        try {
          if (!(boolean) actors.getMethod("supportsUniqueIds").invoke(null)) throw new IllegalStateException("Clearing B reset A's actor state");
          if ((long) effects.getMethod("frameId").invoke(null) != actualFrame[0]) throw new IllegalStateException("Clearing B changed A's timeline");
        } catch (ReflectiveOperationException error) { throw new IllegalStateException(error); }
      });
      result.put("timelineA", actualFrame[0]); result.put("timelineB", actualFrame[1]);
      result.put("otherClientClearPreservedState", true);
      String blocksOwner = "com/viaversion/viafabricplus/bedrock/appearance/BedrockNativeBlocks";
      var blocks = Class.forName(blocksOwner.replace('/', '.'));
      var viewField = blocks.getDeclaredField("VIEW"); viewField.setAccessible(true);
      var updatesField = blocks.getDeclaredField("UPDATES"); updatesField.setAccessible(true);
      var message = Class.forName("net.raphimc.viabedrock.api.model.NativeBlockIdentifiers");
      var reset = Class.forName(message.getName() + "$Reset").getConstructor(int.class, int.class, int.class, int.class);
      var name = Class.forName(message.getName() + "$Name").getConstructor(int.class, String.class, Map.class, int.class);
      var dictionary = Class.forName(message.getName() + "$Dictionary").getConstructor(int.class, java.util.List.class);
      var sectionType = Class.forName("net.raphimc.viabedrock.api.model.NativeBlockSection");
      var section = Class.forName(message.getName() + "$Section").getConstructor(int.class, int.class, int.class, int.class, int.class, sectionType);
      for (int index = 0; index < 2; index++) {
        final int slot = index;
        bots.get(index).runnableWrapper().runWrapped(() -> {
          try {
            Object view = BedrockClientState.read(viewField.get(null), blocksOwner + "#VIEW");
            Object updates = BedrockClientState.read(updatesField.get(null), blocksOwner + "#UPDATES");
            var linked = updates.getClass().getDeclaredField("view"); linked.setAccessible(true);
            if (linked.get(updates) != view) throw new IllegalStateException("Block updater has another client's view");
            BedrockClientState.write(bots.get(slot).minecraft().level, blocksOwner + "#level");
            var accept = view.getClass().getMethod("accept", message);
            accept.invoke(view, reset.newInstance(0, 0, 256, 0));
            accept.invoke(view, dictionary.newInstance(0, java.util.List.of(name.newInstance(101 + slot, "fixture_world_" + slot, Map.of(), -1))));
            Object palette = sectionType.getConstructor(int[].class, long[].class).newInstance(new int[]{101 + slot}, new long[0]);
            accept.invoke(view, section.newInstance(0, 0, 4, 0, 0, palette));
          } catch (ReflectiveOperationException error) { throw new IllegalStateException(error); }
        });
      }
      for (int index = 0; index < 2; index++) {
        final int slot = index;
        bots.get(index).runnableWrapper().runWrapped(() -> {
          try {
            Object actual = blocks.getMethod("state", int.class, int.class, int.class, int.class).invoke(null, 0, 64, 0, 0);
            if (actual == null || !("fixture_world_" + slot).equals(actual.getClass().getMethod("identifier").invoke(actual)))
              throw new IllegalStateException("Native block lookup lost client " + slot + " world state: " + actual);
          } catch (ReflectiveOperationException error) { throw new IllegalStateException(error); }
        });
      }
      result.put("independentWorldBlockLookups", true);
      result.put("blockUpdaterOwnsSameClientView", true);
      SoulFireControls.release(bots.getFirst());
      bots.getFirst().runnableWrapper().runWrapped(() -> {
        Object replacement = BedrockClientState.read(globalTimeline, owner + "#TIMELINE");
        if (replacement == values[0][fieldNames.indexOf(owner + "#TIMELINE")])
          throw new IllegalStateException("Released connection retained its old timeline");
      });
      bots.get(1).runnableWrapper().runWrapped(() -> {
        Object survivor = BedrockClientState.read(globalTimeline, owner + "#TIMELINE");
        if (survivor != values[1][fieldNames.indexOf(owner + "#TIMELINE")])
          throw new IllegalStateException("Releasing A cleared active client B");
      });
      result.put("releasedTransientState", true);
      result.put("releasePreservedOtherClient", true);
      result.put("passed", true);
    } catch (Throwable error) {
      result.put("passed", false); result.put("error", error.toString());
      if (error.getCause() != null) result.put("cause", error.getCause().toString());
    }
    BOTS.clear();
    try { Files.writeString(Path.of("/data/afk-bedrock-isolation.json"), new com.google.gson.Gson().toJson(result)); }
    catch (Exception error) { throw new IllegalStateException(error); }
  }
}
