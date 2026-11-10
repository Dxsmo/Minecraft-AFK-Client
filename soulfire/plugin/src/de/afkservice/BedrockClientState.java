package de.afkservice;

import com.soulfiremc.server.api.metadata.MetadataKey;
import com.soulfiremc.server.bot.BotConnection;
import java.lang.reflect.Field;
import java.lang.ref.WeakReference;
import java.util.HashMap;
import java.util.IdentityHashMap;
import java.util.Map;
import java.util.WeakHashMap;
import java.util.concurrent.ConcurrentHashMap;

/** The vanilla mod has one client. SoulFire has one client per connection.
 * Own mutable Bedrock input/physics state in the connection's transient
 * metadata, rather than process-wide fields or a thread-local (Netty and the
 * game thread both participate). No global map retains disconnected clients. */
public final class BedrockClientState {
  private static final MetadataKey<Storage> KEY = MetadataKey.of("afk-service", "bedrock-client-state", Storage.class);
  private static final Map<String, Field> FIELDS = new ConcurrentHashMap<>();
  private static final class Cell {
    volatile Object value;
    Cell(Object value) { this.value = value; }
  }
  public static final class Storage {
    private final Map<String, Cell> cells = new ConcurrentHashMap<>();
  }
  private BedrockClientState() {}

  /** Release transient world/input data only after connection shutdown. */
  public static void release(BotConnection bot) {
    var storage = bot.metadata().getAndRemove(KEY);
    if (storage != null) storage.cells.clear();
  }

  public static Object read(Object original, String field) {
    var bot = BotConnection.currentOptional().orElse(null);
    if (bot == null) return original;
    var storage = bot.metadata().getOrSet(KEY, Storage::new);
    var cell = storage.cells.get(field);
    if (cell != null) return cell.value;
    // A factory can depend on another per-client field (block updates own
    // their block view). Construct outside ConcurrentHashMap's bin lock.
    var created = new Cell(fresh(original));
    var existing = storage.cells.putIfAbsent(field, created);
    return existing == null ? created.value : existing.value;
  }

  public static void write(Object value, String field) {
    var bot = BotConnection.currentOptional().orElse(null);
    if (bot != null) {
      var storage = bot.metadata().getOrSet(KEY, Storage::new);
      storage.cells.computeIfAbsent(field, ignored -> new Cell(null)).value = value;
      return;
    }
    // Retain the mod's ordinary unscoped bootstrap behavior. Its class
    // initializer is never rewritten, and final fields are never written here.
    try { FIELDS.computeIfAbsent(field, BedrockClientState::field).set(null, value); }
    catch (ReflectiveOperationException error) { throw new IllegalStateException("Cannot write pinned Bedrock field " + field, error); }
  }

  private static Field field(String key) {
    try {
      int separator = key.indexOf('#');
      var field = Class.forName(key.substring(0, separator).replace('/', '.')).getDeclaredField(key.substring(separator + 1));
      field.setAccessible(true);
      return field;
    } catch (ReflectiveOperationException error) { throw new IllegalStateException("Missing pinned Bedrock field " + key, error); }
  }

  private static Object fresh(Object prototype) {
    if (prototype == null || prototype instanceof Number || prototype instanceof Boolean || prototype instanceof String || prototype instanceof Enum<?> || prototype.getClass().isRecord()) return prototype;
    if (prototype instanceof WeakReference<?>) return new WeakReference<>(null);
    if (prototype instanceof IdentityHashMap<?, ?>) return new IdentityHashMap<>();
    if (prototype instanceof WeakHashMap<?, ?>) return new WeakHashMap<>();
    if (prototype instanceof Map<?, ?>) return new HashMap<>();
    try {
      if (prototype.getClass().getName().equals("com.viaversion.viafabricplus.bedrock.appearance.BedrockNativeBlockUpdates")) {
        var view = prototype.getClass().getDeclaredField("view"); view.setAccessible(true);
        var constructor = prototype.getClass().getDeclaredConstructor(view.getType()); constructor.setAccessible(true);
        return constructor.newInstance(read(view.get(prototype), "com/viaversion/viafabricplus/bedrock/appearance/BedrockNativeBlocks#VIEW"));
      }
      if (prototype.getClass().getName().equals("net.raphimc.viabedrock.api.model.NativeProjectileOwners")) {
        // These two stateless callbacks resolve Minecraft through the current
        // connection. Reuse the callbacks, never the mutable owner maps.
        var lookup = prototype.getClass().getDeclaredField("lookup"); lookup.setAccessible(true);
        var assign = prototype.getClass().getDeclaredField("assign"); assign.setAccessible(true);
        return prototype.getClass().getConstructor(java.util.function.Function.class, java.util.function.BiConsumer.class)
            .newInstance(lookup.get(prototype), assign.get(prototype));
      }
      var constructor = prototype.getClass().getDeclaredConstructor();
      constructor.setAccessible(true);
      return constructor.newInstance();
    } catch (ReflectiveOperationException error) { throw new IllegalStateException("Cannot initialize pinned Bedrock state " + prototype.getClass().getName(), error); }
  }
}
