package de.afkservice;

import net.minecraft.world.entity.Entity;
import net.minecraft.world.phys.AABB;
import net.minecraft.world.phys.shapes.VoxelShape;
import java.util.List;

/** Per-level candidate membership; boxes and collision predicates stay live. */
public interface ItemCollisionSource {
  List<VoxelShape> afk$itemCollisions(Entity item, AABB box);
}
