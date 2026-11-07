package de.afkservice.mixin;

import com.soulfiremc.server.api.SoulFireAPI;
import com.soulfiremc.server.api.event.bot.BotConnectionRemovedEvent;
import com.soulfiremc.server.bot.BotConnection;
import de.afkservice.NativeAutoSell;
import io.netty.channel.Channel;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.ConcurrentLinkedQueue;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.atomic.AtomicReference;
import net.kyori.adventure.text.Component;
import net.minecraft.client.Minecraft;
import org.spongepowered.asm.mixin.Final;
import org.spongepowered.asm.mixin.Mixin;
import org.spongepowered.asm.mixin.Shadow;
import org.spongepowered.asm.mixin.Unique;
import org.spongepowered.asm.mixin.injection.At;
import org.spongepowered.asm.mixin.injection.Inject;
import org.spongepowered.asm.mixin.injection.callback.CallbackInfo;
import org.spongepowered.asm.mixin.injection.callback.CallbackInfoReturnable;

/** 2.10.6 marks a connection disconnected only on its successful shutdown path.
 * A failed shutdown can leave an already stopped, socketless bot in the map;
 * drainQueue then refuses every subsequent connection for that profile.
 * Release only after the shutdown actually failed, the game client stopped,
 * and every tracked channel closed. Never evict a running/connected client. */
@Mixin(value = BotConnection.class, remap = false)
public abstract class DisconnectCleanupMixin {
  @Shadow @Final private Minecraft minecraft;
  @Shadow private volatile boolean isDisconnected;
  @Unique private final ConcurrentLinkedQueue<Channel> afk$channels = new ConcurrentLinkedQueue<>();
  @Unique private final AtomicReference<CompletableFuture<Void>> afk$shutdown = new AtomicReference<>();
  @Unique private final AtomicBoolean afk$released = new AtomicBoolean();

  @Inject(method = "trackNetworkChannel", at = @At("HEAD"))
  private void track(Channel channel, CallbackInfo ci) {
    afk$channels.add(channel);
    channel.closeFuture().addListener(ignored -> afk$releaseFailedShutdown());
  }

  @Inject(method = "disconnect", at = @At("RETURN"))
  private void observe(Component reason, CallbackInfoReturnable<CompletableFuture<Void>> ci) {
    var future = ci.getReturnValue();
    if (afk$shutdown.compareAndSet(null, future)) future.whenComplete((ignored, error) -> afk$releaseFailedShutdown());
  }

  @Unique private void afk$releaseFailedShutdown() {
    var future = afk$shutdown.get();
    if (future == null || !future.isCompletedExceptionally() || minecraft.isRunning()
        || afk$channels.stream().anyMatch(Channel::isOpen) || !afk$released.compareAndSet(false, true)) return;
    var bot = (BotConnection) (Object) this;
    isDisconnected = true;
    NativeAutoSell.disconnected(bot);
    if (bot.instanceManager().botStateManager().removeConnection(bot)) {
      System.getLogger("afk-service.disconnect").log(System.Logger.Level.WARNING,
          "Reconnect ({0}): vollständig gestoppte Verbindung nach fehlgeschlagenem Aufräumen freigegeben", bot.accountName());
      SoulFireAPI.postEvent(new BotConnectionRemovedEvent(bot));
    }
    afk$channels.clear();
  }
}
