package de.afkservice.mixin;

import de.afkservice.ItemCollisionSource;
import net.minecraft.client.multiplayer.ClientLevel;
import net.minecraft.world.entity.Entity;
import net.minecraft.world.entity.EntitySelector;
import net.minecraft.world.entity.item.ItemEntity;
import net.minecraft.world.phys.AABB;
import net.minecraft.world.phys.shapes.Shapes;
import net.minecraft.world.phys.shapes.VoxelShape;
import java.util.ArrayList;
import java.util.List;
import org.spongepowered.asm.mixin.Mixin;
import org.spongepowered.asm.mixin.Unique;
import org.spongepowered.asm.mixin.injection.At;
import org.spongepowered.asm.mixin.injection.Inject;
import org.spongepowered.asm.mixin.injection.callback.CallbackInfo;

/** Vanilla scans the entire item pile for EACH moving item, although dropped
 * items cannot collide with one another. Cache only candidate membership once
 * per entity tick: O(items + items * non-items), instead of O(items squared).
 * Physics, block collisions, server packets and pickup handling are untouched.
 */
@Mixin(ClientLevel.class)
public abstract class ItemCollisionCandidatesMixin implements ItemCollisionSource {
  @Unique private List<Entity> afk$nonItems;

  @Inject(method = { "tickEntities", "addEntity", "removeEntity" }, at = @At("HEAD"))
  private void invalidate(CallbackInfo ci) { afk$nonItems = null; }

  @Override
  public List<VoxelShape> afk$itemCollisions(Entity item, AABB box) {
    if (box.getSize() < 1.0E-7) return List.of();
    if (afk$nonItems == null) {
      var level = (ClientLevel) (Object) this;
      afk$nonItems = new ArrayList<>();
      for (var entity : level.entitiesForRendering())
        if (!(entity instanceof ItemEntity)) afk$nonItems.add(entity);
      afk$nonItems.addAll(level.dragonParts());
    }
    var expanded = box.inflate(1.0E-7);
    List<VoxelShape> collisions = null;
    for (var candidate : afk$nonItems) {
      if (candidate == item || candidate.isRemoved() || !EntitySelector.NO_SPECTATORS.test(candidate)
          || !candidate.getBoundingBox().intersects(expanded) || !item.canCollideWith(candidate)) continue;
      if (collisions == null) collisions = new ArrayList<>();
      collisions.add(Shapes.create(candidate.getBoundingBox()));
    }
    return collisions == null ? List.of() : collisions;
  }
}
