package de.afkservice.mixin;

import com.soulfiremc.server.bot.BotConnection;
import com.soulfiremc.mod.access.IMenuIdentity;
import net.minecraft.client.Minecraft;
import net.minecraft.client.gui.screens.inventory.AbstractContainerScreen;
import net.minecraft.world.inventory.ContainerInput;
import org.spongepowered.asm.mixin.Mixin;
import org.spongepowered.asm.mixin.Shadow;
import org.spongepowered.asm.mixin.injection.At;
import org.spongepowered.asm.mixin.injection.Inject;
import org.spongepowered.asm.mixin.injection.callback.CallbackInfo;

/** Called inside SoulFire's existing authenticated, leased, menu-bound action.
 * Batching removes one RPC and one control-task/game tick per inventory stack.
 * Every transfer still uses the normal vanilla prediction and packet path.
 */
@Mixin(targets = "com.soulfiremc.server.grpc.ContainerClicks", remap = false)
public final class SellBatchMixin {
  @Shadow static void click(Minecraft mc, int slot, int button, ContainerInput input) { throw new AssertionError(); }
  @Inject(method = "click", at = @At("HEAD"), cancellable = true)
  private static void transferSaleInventory(Minecraft mc, int slot, int button, ContainerInput input, CallbackInfo ci) {
    if (slot != -1048576) return;
    ci.cancel();
    var bot = BotConnection.currentOptional().orElseThrow();
    var settings = bot.settingsSource().stem().settings().get("afk-service");
    if (settings != null && settings.containsKey("remote-control") && settings.get("remote-control").getAsBoolean())
      throw new IllegalStateException("Remote control owns this account");
    if (input != ContainerInput.QUICK_MOVE || button != 0 || mc.player == null || mc.gameMode == null
        || !(mc.gui.screen() instanceof AbstractContainerScreen<?> screen))
      throw new IllegalStateException("Sale menu is not available");
    var title = screen.getTitle().getString().replaceAll("§.", "").trim();
    if (!title.equalsIgnoreCase("Items verkaufen") && !title.equalsIgnoreCase("Sell"))
      throw new IllegalStateException("Not a sale menu");
    var menu = mc.player.containerMenu;
    var identity = ((IMenuIdentity) menu).soulfire$getMenuId();
    for (int index = 0; index < menu.slots.size(); index++) {
      if (mc.player.containerMenu != menu || !identity.equals(((IMenuIdentity) mc.player.containerMenu).soulfire$getMenuId())) break;
      var entry = menu.slots.get(index);
      if (entry.container == mc.player.getInventory() && entry.hasItem())
        click(mc, index, 0, ContainerInput.QUICK_MOVE);
    }
  }
}
