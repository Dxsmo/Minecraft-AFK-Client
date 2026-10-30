package de.afkservice;

import com.google.gson.JsonElement;
import com.soulfiremc.server.api.SoulFireAPI;
import com.soulfiremc.server.api.event.bot.BotPreTickEvent;
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
  private static final Map<BotConnection, Integer> CHECKS = Collections.synchronizedMap(new WeakHashMap<>());
  private static final Map<BotConnection, Boolean> REMOTE = Collections.synchronizedMap(new WeakHashMap<>());
  @Override
  public void onInitialize() {
    SoulFireAPI.registerListener(BotPreTickEvent.class, SoulFireControls::tick);
  }

  private static void tick(BotPreTickEvent event) {
    var bot = event.connection();
    var settings = bot.settingsSource().stem().settings().get("afk-service");
    if (settings == null) return;
    var mc = bot.minecraft();
    if (mc.player == null || mc.level == null || mc.gameMode == null) return;
    boolean remote = flag(settings, "remote-control");
    var previousRemote = REMOTE.put(bot, remote);
    if (remote) {
      // Release configured input once, before native POV takes over. Later
      // remote key presses must not be overwritten by the automation tick.
      if (!Boolean.TRUE.equals(previousRemote)) {
        bot.controlState().shift(false);
        mc.options.keyShift.setDown(false);
        mc.options.keyAttack.setDown(false);
        mc.options.keyUse.setDown(false);
      }
      return;
    }
    boolean crouch = flag(settings, "crouch-enabled");
    bot.controlState().shift(crouch);
    mc.options.keyShift.setDown(crouch);
    int check = number(settings, "sneak-check");
    var previousCheck = CHECKS.put(bot, check);
    if (crouch && (previousCheck == null || previousCheck != check || !mc.player.isShiftKeyDown())) {
      // A check must also reassert actual server input when the local control
      // flag was already true. Never send a release to manufacture an edge.
      var old = mc.player.input.keyPresses;
      var held = new Input(old.forward(), old.backward(), old.left(), old.right(), old.jump(), true, old.sprint());
      mc.player.input.keyPresses = held;
      mc.player.setShiftKeyDown(true);
      mc.player.connection.send(new ServerboundPlayerInputPacket(held));
    }
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
    if (settings == null || flag(settings, "remote-control")) return false;
    var keys = bot.minecraft().options;
    return (mapping == keys.keyShift && flag(settings, "crouch-enabled"))
      || (mapping == keys.keyAttack && "LEFT".equals(text(settings, "auto-button", "OFF")))
      || (mapping == keys.keyUse && "RIGHT".equals(text(settings, "auto-button", "OFF")));
  }

  public static boolean heldPointer(BotConnection bot) {
    var settings = bot.settingsSource().stem().settings().get("afk-service");
    return settings != null && !flag(settings, "remote-control") && !"OFF".equals(text(settings, "auto-button", "OFF"))
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
