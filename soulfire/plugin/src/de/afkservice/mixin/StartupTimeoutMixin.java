package de.afkservice.mixin;

import net.minecraft.client.main.Main;
import org.spongepowered.asm.mixin.Mixin;

/** Marker for the plugin's post-merge adjustment of SoulFire's resource deadline. */
@Mixin(value = Main.class, priority = 900)
public abstract class StartupTimeoutMixin {
}
