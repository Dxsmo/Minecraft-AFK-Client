package de.afkservice.mixin;

import de.afkservice.SneakReassertion;
import net.minecraft.client.player.LocalPlayer;
import org.spongepowered.asm.mixin.Mixin;

/** ViaFabricPlus sends legacy START_SNEAKING only when this cache changes.
 * Apply after its priority-1000 mixin has introduced the field. Re-arming
 * that cache sends another START on the regular game tick, never a STOP.
 * Modern Java/Bedrock input still uses the native input packet unchanged.
 * The exact ViaFabricPlus build is embedded in our checksum-pinned release. */
@Mixin(value = LocalPlayer.class, priority = 900)
public abstract class LegacySneakMixin implements SneakReassertion {
  @Override
  public void afkService$reassertSneak() {
    // StartupMixinPlugin fills this after ViaFabricPlus has merged its field.
  }
}
