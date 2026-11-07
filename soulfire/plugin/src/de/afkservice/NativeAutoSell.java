package de.afkservice;

import com.google.gson.JsonParser;
import com.soulfiremc.server.bot.BotConnection;
import net.minecraft.client.gui.screens.inventory.AbstractContainerScreen;
import net.minecraft.world.inventory.ContainerInput;
import net.minecraft.world.inventory.AbstractContainerMenu;
import java.lang.ref.WeakReference;
import java.util.Collections;
import java.util.Map;
import java.util.WeakHashMap;
import java.util.concurrent.atomic.AtomicLong;

/** Runs on the bot game thread. No menu snapshots/RPC roundtrips per sale.
 * Only vanilla inventory actions are used; the server owns prices/acceptance.
 * The short renewable lease stops automation if the website controller dies.
 */
public final class NativeAutoSell {
  private static final System.Logger LOG = System.getLogger("afk-service.auto-sell");
  private static final Map<BotConnection, State> STATES = Collections.synchronizedMap(new WeakHashMap<>());
  private static final class State {
    String config = "", command = "/sell";
    boolean enabled, waiting;
    int player, level;
    long next, requested, lastWarning, interval = 2000;
    double x, y, z;
    WeakReference<AbstractContainerMenu> sellingMenu = new WeakReference<>(null);
    int nextSlot, contentMenu = -1, pendingSlot = -1;
    final AtomicLong revision = new AtomicLong();
    long pendingRevision, pendingAt;
    boolean contentReady;
    final SellRecovery recovery = new SellRecovery();
  }
  public static void disconnected(BotConnection bot) { STATES.remove(bot); }
  public static void opened(BotConnection bot, int menu) {
    var state = STATES.get(bot);
    if (state == null) return;
    state.contentMenu = menu; state.contentReady = false;
    var mc = bot.minecraft();
    long now = System.currentTimeMillis();
    if (state.requested > 0 && now - state.requested < 15_000
        && mc.player != null && mc.gui.screen() instanceof AbstractContainerScreen<?> screen
        && saleTitle(screen.getTitle().getString())) {
      if (state.waiting) {
        state.sellingMenu = new WeakReference<>(mc.player.containerMenu);
        state.nextSlot = 0; state.pendingSlot = -1;
      } else if (number(bot.settingsSource().stem().settings().get("afk-service"), "sell-manual-until") <= now) {
        // An abandoned native open request replied late. Discard its own sale
        // GUI without transferring; manual-command menus remain untouched.
        mc.player.closeContainer();
      }
    }
  }
  public static void inventoryAck(BotConnection bot, int menu, int slot) {
    var state = STATES.get(bot);
    if (state == null) return;
    if (menu == state.contentMenu && slot == -1) state.contentReady = true;
    var owned = state.sellingMenu.get();
    if (owned != null && menu == owned.containerId && (slot == -1 || slot == state.pendingSlot)) state.revision.incrementAndGet();
  }
  public static void serverMessage(BotConnection bot, String message) {
    var state = STATES.get(bot);
    if (state == null) return;
    if (SellRecovery.inventoryBlocked(message)) state.recovery.rejected(System.currentTimeMillis());
    if (SellRecovery.payout(message)) { state.recovery.confirmed(); state.revision.incrementAndGet(); }
  }
  public static void tick(BotConnection bot) {
    try { tickSale(bot); }
    catch (RuntimeException error) {
      var state = STATES.get(bot);
      if (state == null) return;
      long now = System.currentTimeMillis();
      state.recovery.rejected(now); state.pendingSlot = -1;
      if (now - state.lastWarning >= 30_000) {
        state.lastWarning = now;
        LOG.log(System.Logger.Level.WARNING, "AutoSell: Inventaraktion abgebrochen; erneuter Versuch nach Pause", error);
      }
    }
  }
  private static void tickSale(BotConnection bot) {
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
    if (moved) { state.next = now + 2000; cancel(bot, state); }
    if (!state.enabled || !SellLease.valid(bot.instanceManager().id(), bot.accountProfileId(), now)
        || (settings.get("sell-home-pending") != null && settings.get("sell-home-pending").getAsBoolean())
        || number(settings, "sell-manual-until") > now
        || state.recovery.paused(now)
        || (now >= number(settings, "sell-pause-from") && now < number(settings, "sell-pause-until"))) {
      cancel(bot, state);
      state.next = Math.max(state.next, state.recovery.until());
      return;
    }

    var menu = mc.player.containerMenu;
    if (mc.gui.screen() instanceof AbstractContainerScreen<?> screen) {
      var title = screen.getTitle().getString().replaceAll("§.", "").trim();
      if (!saleTitle(title)) return;
      if (!state.waiting && state.sellingMenu.get() != menu) return;
      if (now - state.requested >= 15_000) { state.recovery.rejected(now); cancel(bot, state); return; }
      if (state.sellingMenu.get() != menu) { state.sellingMenu = new WeakReference<>(menu); state.nextSlot = 0; state.pendingSlot = -1; }
      if (state.contentMenu != menu.containerId || !state.contentReady) return;
      if (state.pendingSlot >= 0) {
        if (state.pendingRevision == state.revision.get()) {
          if (now - state.pendingAt >= 5000) { state.recovery.rejected(now); cancel(bot, state); }
          return;
        }
        state.pendingSlot = -1;
      }
      boolean stock = menu.slots.stream().anyMatch(slot -> slot.container == mc.player.getInventory() && slot.isActive() && slot.hasItem());
      if (!stock && state.sellingMenu.get() != menu && state.waiting && now - state.requested < 500) return;
      // One transfer per game tick and server acknowledgment. Keep the cursor
      // across ticks so instant refills cannot revisit the same slot forever.
      while (state.nextSlot < menu.slots.size() && mc.player.containerMenu == menu) {
        int index = state.nextSlot++;
        var slot = menu.slots.get(index);
        if (slot.container == mc.player.getInventory() && slot.isActive() && slot.hasItem()) {
          state.pendingSlot = index; state.pendingRevision = state.revision.get(); state.pendingAt = now;
          mc.gameMode.handleContainerInput(menu.containerId, index, 0, ContainerInput.QUICK_MOVE, mc.player);
          return;
        }
      }
      if (mc.player.containerMenu == menu) mc.player.closeContainer();
      state.sellingMenu.clear();
      state.waiting = false;
      state.pendingSlot = -1;
      return;
    }
    state.sellingMenu.clear();
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
      state.recovery.rejected(now);
      state.next = Math.max(state.next, state.recovery.until());
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
  private static void cancel(BotConnection bot, State state) {
    var mc = bot.minecraft();
    var owned = state.sellingMenu.get();
    if (owned != null && mc.player != null && mc.player.containerMenu == owned) mc.player.closeContainer();
    state.pendingSlot = -1; state.sellingMenu.clear();
    // Keep a still-outstanding open request recognizable until its finite
    // deadline, so a delayed sale menu can be closed safely when it arrives.
    if (System.currentTimeMillis() - state.requested >= 3000 || owned != null) state.waiting = false;
  }
  private static long number(Map<String, com.google.gson.JsonElement> settings, String key) {
    if (settings == null) return 0;
    var value = settings.get(key); return value != null && value.isJsonPrimitive() && value.getAsJsonPrimitive().isNumber() ? value.getAsLong() : 0;
  }
  private static boolean saleTitle(String title) {
    return title.replaceAll("§.", "").trim().matches("(?i)^(?:Items verkaufen|Sell)$");
  }
}
