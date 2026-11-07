package de.afkservice.mixin;

import com.soulfiremc.server.bot.BotConnection;
import java.util.concurrent.atomic.AtomicBoolean;
import net.kyori.adventure.text.Component;
import org.spongepowered.asm.mixin.Mixin;
import org.spongepowered.asm.mixin.Unique;
import org.spongepowered.asm.mixin.injection.At;
import org.spongepowered.asm.mixin.injection.Inject;
import org.spongepowered.asm.mixin.injection.callback.CallbackInfo;

/** Test-only: fail after every channel closed but before isDisconnected=true.
 * Never packaged by the production build. */
@Mixin(value = BotConnection.class, remap = false)
public abstract class DisconnectFaultMixin {
  @Unique private static final AtomicBoolean afk$injected = new AtomicBoolean();
  @Inject(method = "disconnectNow", at = @At(value = "INVOKE", target = "Lcom/soulfiremc/server/bot/NetworkChannelTracker;hasOpenChannels()Z"))
  private void failClosedShutdown(Component reason, CallbackInfo ci) {
    if (((BotConnection) (Object) this).accountName().startsWith("CleanupFault") && afk$injected.compareAndSet(false, true)) {
      try {
        java.nio.file.Files.writeString(java.nio.file.Path.of(System.getProperty("sf.baseDir"), "afk-disconnect-fault.marker"), Long.toString(System.currentTimeMillis()));
      } catch (java.io.IOException error) { throw new IllegalStateException(error); }
      throw new IllegalStateException("AFK fixture: closed-channel shutdown failure");
    }
  }
}
