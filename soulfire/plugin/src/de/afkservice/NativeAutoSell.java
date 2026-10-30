package de.afkservice;

import com.google.gson.JsonParser;
import com.soulfiremc.server.bot.BotConnection;
import net.minecraft.client.gui.screens.inventory.AbstractContainerScreen;
import net.minecraft.world.inventory.ContainerInput;
import java.util.Collections;
import java.util.Map;
import java.util.WeakHashMap;

/** Runs on the bot game thread. No menu snapshots/RPC roundtrips per sale.
 * Only vanilla inventory actions are used; the server owns prices/acceptance.
 * The short renewable lease stops automation if the website controller dies.
 */
public final class NativeAutoSell {
  private static final System.Logger LOG = System.getLogger("afk-service.auto-sell");
  private static final Map<BotConnection, State> STATES = Collections.synchronizedMap(new WeakHashMap<>());
  private static final class State {
    String config = "", command = "/sell";
    boolean enabled, waiting, remote;
    int player, level;
    long next, requested, lastWarning, interval = 2000;
    double x, y, z;
  }
  public static void tick(BotConnection bot) {
    var mc = bot.minecraft();
    if (mc.player == null || mc.level == null || mc.gameMode == null) return;
    var settings = bot.settingsSource().stem().settings().get("afk-service");
    if (settings == null) return;
    var state = STATES.computeIfAbsent(bot, ignored -> new State());
    long now = System.currentTimeMillis();
    var encoded = settings.get("native-auto-sell");
    String config = encoded != null && encoded.isJsonPrimitive() ? encoded.getAsString() : "";
    if (!config.equals(state.config)) {
      state.config = config; state.enabled = false; state.waiting = false; state.next = now;
      if (!config.isEmpty()) {
        var json = JsonParser.parseString(config).getAsJsonObject();
        state.enabled = json.get("enabled").getAsBoolean();
        state.interval = Math.clamp(json.get("intervalMs").getAsLong(), 250L, 3_600_000L);
        state.command = json.get("command").getAsString().trim();
      }
    }
    int player = System.identityHashCode(mc.player), level = System.identityHashCode(mc.level);
    boolean moved = state.player != player || state.level != level
      || Math.sqrt(Math.pow(mc.player.getX() - state.x, 2) + Math.pow(mc.player.getY() - state.y, 2) + Math.pow(mc.player.getZ() - state.z, 2)) > 2;
    state.player = player; state.level = level;
    state.x = mc.player.getX(); state.y = mc.player.getY(); state.z = mc.player.getZ();
    if (moved) { state.next = now + 2000; state.waiting = false; }
    boolean remote = settings.containsKey("remote-control") && settings.get("remote-control").getAsBoolean();
    if (remote || state.remote != remote) { state.next = now; state.waiting = false; }
    state.remote = remote;
    if (!state.enabled || remote || number(settings, "sell-lease-until") < now
        || number(settings, "sell-manual-until") > now
        || (now >= number(settings, "sell-pause-from") && now < number(settings, "sell-pause-until"))) return;

    var menu = mc.player.containerMenu;
    if (mc.gui.screen() instanceof AbstractContainerScreen<?> screen) {
      var title = screen.getTitle().getString().replaceAll("§.", "").trim();
      if (!title.equalsIgnoreCase("Items verkaufen") && !title.equalsIgnoreCase("Sell")) return;
      boolean stock = menu.slots.stream().anyMatch(slot -> slot.container == mc.player.getInventory() && slot.isActive() && slot.hasItem());
      if (!stock && state.waiting && now - state.requested < 500) return;
      for (int index = 0; index < menu.slots.size() && mc.player.containerMenu == menu; index++) {
        var slot = menu.slots.get(index);
        if (slot.container == mc.player.getInventory() && slot.isActive() && slot.hasItem())
          mc.gameMode.handleContainerInput(menu.containerId, index, 0, ContainerInput.QUICK_MOVE, mc.player);
      }
      if (mc.player.containerMenu == menu) mc.player.closeContainer();
      state.waiting = false;
      return;
    }
    // Never type through a foreign screen. Lost/delayed GUI replies retry
    // at most once per 3s, without the old 10s website-side snapshot timeout.
    if (mc.gui.screen() != null) return;
    if (state.waiting) {
      if (now - state.requested < 3000) return;
      if (now - state.lastWarning >= 30_000) {
        LOG.log(System.Logger.Level.WARNING, "AutoSell ({0}): Server hat nach 3s kein Verkaufsmenü geöffnet; erneuter Versuch",
            mc.player.getName().getString());
        state.lastWarning = now;
      }
      state.waiting = false;
      state.next = now;
    }
    if (now < state.next) return;
    boolean stock = false;
    for (int slot = 0; slot < 36; slot++) if (!mc.player.getInventory().getItem(slot).isEmpty()) { stock = true; break; }
    if (!stock) return;
    if (state.command.isEmpty() || state.command.matches("(?i)^/?(?:[^ :/]+:)?afk(?:\\s.*)?$")) return;
    state.requested = now; state.waiting = true; state.next = now + state.interval;
    if (state.command.startsWith("/")) mc.player.connection.sendCommand(state.command.substring(1));
    else mc.player.connection.sendChat(state.command);
  }
  private static long number(Map<String, com.google.gson.JsonElement> settings, String key) {
    var value = settings.get(key); return value != null && value.isJsonPrimitive() && value.getAsJsonPrimitive().isNumber() ? value.getAsLong() : 0;
  }
}
