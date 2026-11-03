package de.afkservice.mixin;

import com.soulfiremc.server.bot.BotConnection;
import de.afkservice.ItemCollisionSource;
import net.minecraft.world.entity.Entity;
import net.minecraft.world.entity.item.ItemEntity;
import net.minecraft.world.level.EntityGetter;
import net.minecraft.world.phys.AABB;
import net.minecraft.world.phys.shapes.VoxelShape;
import java.util.List;
import org.spongepowered.asm.mixin.Mixin;
import org.spongepowered.asm.mixin.injection.At;
import org.spongepowered.asm.mixin.injection.Inject;
import org.spongepowered.asm.mixin.injection.callback.CallbackInfoReturnable;

@Mixin(EntityGetter.class)
public interface ItemCollisionMixin {
  @Inject(method = "getEntityCollisions", at = @At("HEAD"), cancellable = true)
  default void afk$itemCollisions(Entity entity, AABB box, CallbackInfoReturnable<List<VoxelShape>> cir) {
    if (!(entity instanceof ItemEntity) || !((Object) this instanceof ItemCollisionSource source)) return;
    var bot = BotConnection.currentOptional();
    if (bot.isEmpty() || !bot.get().settingsSource().stem().settings().containsKey("afk-service")) return;
    cir.setReturnValue(source.afk$itemCollisions(entity, box));
  }
}
