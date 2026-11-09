package de.afkservice;

import com.google.gson.JsonElement;
import com.soulfiremc.server.api.SoulFireAPI;
import com.soulfiremc.server.api.event.bot.BotPreTickEvent;
import com.soulfiremc.server.api.event.bot.ChatMessageReceiveEvent;
import com.soulfiremc.server.api.event.bot.BotDisconnectedEvent;
import net.fabricmc.api.ModInitializer;
import net.minecraft.world.InteractionHand;
import net.minecraft.world.phys.EntityHitResult;
import net.minecraft.client.KeyMapping;
import com.soulfiremc.server.bot.BotConnection;
import java.util.Map;
import java.util.Collections;
import java.util.WeakHashMap;
import net.minecraft.world.entity.player.Input;
import net.minecraft.network.protocol.game.ServerboundPlayerInputPacket;

/** Native, persistent input on the bot's own game thread. No POV session,
 * video stream, synthetic release cycles, or network roundtrips per tick. */
public final class SoulFireControls implements ModInitializer {
  private static final Map<BotConnection, SneakState> CHECKS = Collections.synchronizedMap(new WeakHashMap<>());
  private static final Map<BotConnection, Boolean> VISUALS = Collections.synchronizedMap(new WeakHashMap<>());
  private static final class SneakState {
    int check;
    int player, level;
    double x, y, z;
    long next;
  }

  @Override
  public void onInitialize() {
    SoulFireAPI.registerListener(BotPreTickEvent.class, SoulFireControls::tick);
    SoulFireAPI.registerListener(ChatMessageReceiveEvent.class,
        event -> NativeAutoSell.serverMessage(event.connection(), event.parseToPlainText()));
    SoulFireAPI.registerListener(BotDisconnectedEvent.class,
        event -> NativeAutoSell.disconnected(event.connection()));
  }

  private static void tick(BotPreTickEvent event) {
    var bot = event.connection();
    var settings = bot.settingsSource().stem().settings().get("afk-service");
    if (settings == null) return;
    var mc = bot.minecraft();
    if (mc.player == null || mc.level == null || mc.gameMode == null) return;
    if (VISUALS.put(bot, true) == null) {
      mc.options.graphicsPreset().set(net.minecraft.client.GraphicsPreset.FAST);
      mc.options.cloudStatus().set(net.minecraft.client.CloudStatus.OFF);
      mc.options.particles().set(net.minecraft.server.level.ParticleStatus.MINIMAL);
      mc.options.entityShadows().set(false);
      // A tiny advertised radius also limits chunks sent by servers that
      // honor client send distance. Keep the original six-chunk request.
      mc.options.renderDistance().set(6);
    }
    NativeAutoSell.tick(bot);
    boolean crouch = flag(settings, "crouch-enabled");
    bot.controlState().shift(crouch);
    mc.options.keyShift.setDown(crouch);
    var state = CHECKS.computeIfAbsent(bot, ignored -> new SneakState());
    int check = number(settings, "sneak-check");
    long now = System.nanoTime();
    int player = System.identityHashCode(mc.player), level = System.identityHashCode(mc.level);
    boolean moved = state.player != player || state.level != level
      || Math.abs(mc.player.getX() - state.x) > 2 || Math.abs(mc.player.getY() - state.y) > 2
      || Math.abs(mc.player.getZ() - state.z) > 2;
    state.player = player; state.level = level;
    state.x = mc.player.getX(); state.y = mc.player.getY(); state.z = mc.player.getZ();
    if (crouch && (moved || state.check != check || now >= state.next || !mc.player.isShiftKeyDown())) {
      // Native input alone does not re-send legacy START_SNEAKING: VFP has
      // its own edge cache. Re-arm it on this same game thread, without ever
      // releasing Shift locally or on the network. The bounded refresh also
      // repairs silent server resets that have no recognizable chat message.
      var old = mc.player.input.keyPresses;
      var held = new Input(old.forward(), old.backward(), old.left(), old.right(), old.jump(), true, old.sprint());
      mc.player.input.keyPresses = held;
      mc.player.setShiftKeyDown(true);
      ((SneakReassertion) mc.player).afkService$reassertSneak();
      mc.player.connection.send(new ServerboundPlayerInputPacket(held));
      state.next = now + 5_000_000_000L;
    }
    state.check = check;
    var button = text(settings, "auto-button", "OFF");
    boolean left = "LEFT".equals(button), right = "RIGHT".equals(button);
    mc.options.keyAttack.setDown(left);
    mc.options.keyUse.setDown(right);
    // Held mining/use runs through Minecraft's regular input handling. Entity
    // attacks additionally repeat at the actual weapon's attack cooldown.
    if (left && mc.gui.screen() == null && mc.hitResult instanceof EntityHitResult target
        && mc.player.getAttackStrengthScale(0.0F) >= 1.0F && target.getEntity().isAlive()) {
      mc.gameMode.attack(mc.player, target.getEntity());
      mc.player.swingAndResetAttackStrength(InteractionHand.MAIN_HAND, net.minecraft.world.item.component.SwingAnimation.DEFAULT, true);
    }
  }

  private static boolean flag(Map<String, JsonElement> settings, String key) {
    var value = settings.get(key);
    return value != null && value.isJsonPrimitive() && value.getAsJsonPrimitive().isBoolean() && value.getAsBoolean();
  }

  /** Vanilla releases mappings on menu/focus changes. Preserve the user's
   * held setting even there; only an explicit setting change may release it. */
  public static boolean forcedDown(BotConnection bot, KeyMapping mapping) {
    var settings = bot.settingsSource().stem().settings().get("afk-service");
    if (settings == null) return false;
    var keys = bot.minecraft().options;
    return (mapping == keys.keyShift && flag(settings, "crouch-enabled"))
      || (mapping == keys.keyAttack && "LEFT".equals(text(settings, "auto-button", "OFF")))
      || (mapping == keys.keyUse && "RIGHT".equals(text(settings, "auto-button", "OFF")));
  }

  public static boolean heldPointer(BotConnection bot) {
    var settings = bot.settingsSource().stem().settings().get("afk-service");
    return settings != null && !"OFF".equals(text(settings, "auto-button", "OFF"))
      && bot.minecraft().gui.screen() == null;
  }

  private static String text(Map<String, JsonElement> settings, String key, String fallback) {
    var value = settings.get(key);
    return value != null && value.isJsonPrimitive() && value.getAsJsonPrimitive().isString() ? value.getAsString() : fallback;
  }

  private static int number(Map<String, JsonElement> settings, String key) {
    var value = settings.get(key);
    return value != null && value.isJsonPrimitive() && value.getAsJsonPrimitive().isNumber() ? value.getAsInt() : 0;
  }
}
