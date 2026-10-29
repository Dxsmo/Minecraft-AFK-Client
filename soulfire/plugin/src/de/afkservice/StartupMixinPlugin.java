package de.afkservice;

import java.util.List;
import java.util.Set;
import org.objectweb.asm.Opcodes;
import org.objectweb.asm.tree.AbstractInsnNode;
import org.objectweb.asm.tree.ClassNode;
import org.objectweb.asm.tree.FieldInsnNode;
import org.objectweb.asm.tree.LdcInsnNode;
import org.objectweb.asm.tree.MethodInsnNode;
import org.spongepowered.asm.mixin.extensibility.IMixinConfigPlugin;
import org.spongepowered.asm.mixin.extensibility.IMixinInfo;

/** Adjusts the pinned release's deadline after SoulFire has merged its initializer. */
public final class StartupMixinPlugin implements IMixinConfigPlugin {
  @Override public void onLoad(String mixinPackage) {}
  @Override public String getRefMapperConfig() { return null; }
  @Override public boolean shouldApplyMixin(String target, String mixin) { return true; }
  @Override public void acceptTargets(Set<String> ours, Set<String> others) {}
  @Override public List<String> getMixins() { return null; }
  @Override public void preApply(String target, ClassNode node, String mixin, IMixinInfo info) {}

  @Override
  public void postApply(String target, ClassNode node, String mixin, IMixinInfo info) {
    if (!mixin.equals("de.afkservice.mixin.StartupTimeoutMixin")) return;
    long seconds = Math.max(30L, Math.min(1800L,
        Long.getLong("afk.initialClientLoadTimeoutSeconds", 300L)));
    int changed = 0;
    for (var method : node.methods) {
      if (!method.name.equals("<clinit>")) continue;
      for (var instruction : method.instructions) {
        if (!(instruction instanceof FieldInsnNode field)
            || field.getOpcode() != Opcodes.PUTSTATIC
            || !field.owner.equals(node.name) || !field.desc.equals("J")
            || !field.name.contains("INITIAL_CLIENT_LOAD_TIMEOUT_NANOS")) continue;
        var call = previous(instruction);
        if (!(call instanceof MethodInsnNode conversion)
            || conversion.getOpcode() != Opcodes.INVOKEVIRTUAL
            || !conversion.owner.equals("java/util/concurrent/TimeUnit")
            || !conversion.name.equals("toNanos") || !conversion.desc.equals("(J)J")) continue;
        var value = previous(call);
        var unit = previous(value);
        if (!(value instanceof LdcInsnNode constant) || !Long.valueOf(30L).equals(constant.cst)
            || !(unit instanceof FieldInsnNode timeUnit)
            || timeUnit.getOpcode() != Opcodes.GETSTATIC
            || !timeUnit.owner.equals("java/util/concurrent/TimeUnit")
            || !timeUnit.name.equals("SECONDS")) continue;
        constant.cst = seconds;
        changed++;
      }
    }
    if (changed != 1) {
      throw new IllegalStateException("Expected one SoulFire 2.10.6 resource deadline, found " + changed);
    }
    System.out.println("[afk-service] Initial Minecraft resource load timeout: " + seconds + " seconds");
  }

  private static AbstractInsnNode previous(AbstractInsnNode instruction) {
    if (instruction == null) return null;
    var previous = instruction.getPrevious();
    while (previous != null && previous.getOpcode() < 0) previous = previous.getPrevious();
    return previous;
  }
}
