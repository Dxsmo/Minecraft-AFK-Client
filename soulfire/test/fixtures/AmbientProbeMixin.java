package de.afkservice.mixin;

import de.afkservice.RuntimeProbe;
import net.minecraft.client.multiplayer.ClientLevel;
import org.spongepowered.asm.mixin.Mixin;
import org.spongepowered.asm.mixin.injection.At;
import org.spongepowered.asm.mixin.injection.Inject;
import org.spongepowered.asm.mixin.injection.callback.CallbackInfo;

@Mixin(ClientLevel.class)
public abstract class AmbientProbeMixin {
  @Inject(method = "doAnimateTick", at = @At("HEAD"))
  private void sampled(CallbackInfo ci) {
    RuntimeProbe.SAMPLES.set(RuntimeProbe.SAMPLES.get() + 1);
  }
}
