package de.afkservice;

import java.util.List;
import java.util.Set;
import org.objectweb.asm.Opcodes;
import org.objectweb.asm.tree.AbstractInsnNode;
import org.objectweb.asm.tree.ClassNode;
import org.objectweb.asm.tree.FieldInsnNode;
import org.objectweb.asm.tree.LdcInsnNode;
import org.objectweb.asm.tree.MethodInsnNode;
import org.objectweb.asm.tree.InsnList;
import org.objectweb.asm.tree.InsnNode;
import org.objectweb.asm.tree.VarInsnNode;
import org.objectweb.asm.tree.TypeInsnNode;
import org.objectweb.asm.tree.JumpInsnNode;
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
    if (mixin.equals("de.afkservice.mixin.BedrockClientStateMixin")) {
      isolateBedrockState(node);
      return;
    }
    if (mixin.equals("de.afkservice.mixin.BedrockMovementTimelineMixin")) {
      synchronizeMovementTimeline(node);
      return;
    }
    if (mixin.equals("de.afkservice.mixin.LegacySneakMixin")) {
      rearmLegacySneak(node);
      return;
    }
    if (mixin.equals("de.afkservice.mixin.CameraFrameMixin")) {
      progressiveCamera(node);
      return;
    }
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
      throw new IllegalStateException("Expected one SoulFire 2.10.7 resource deadline, found " + changed);
    }
    System.out.println("[afk-service] Initial Minecraft resource load timeout: " + seconds + " seconds");
  }

  private static void isolateBedrockState(ClassNode node) {
    var expected = BedrockStateFields.FIELDS.get(node.name);
    if (expected != null) {
      var actual = node.fields.stream().filter(field -> (field.access & Opcodes.ACC_STATIC) != 0).map(field -> field.name).toList();
      if (!actual.containsAll(expected)) throw new IllegalStateException("Unexpected pinned Bedrock state layout: " + node.name);
    }
    for (var method : node.methods) {
      if (method.name.equals("<clinit>")) continue;
      for (var instruction : method.instructions.toArray()) {
        if (!(instruction instanceof FieldInsnNode field)) continue;
        var fields = BedrockStateFields.FIELDS.get(field.owner);
        if (fields == null || !fields.contains(field.name)) continue;
        boolean read = field.getOpcode() == Opcodes.GETSTATIC;
        if (!read && field.getOpcode() != Opcodes.PUTSTATIC) continue;
        var hook = new InsnList();
        if (read) hook.add(new FieldInsnNode(Opcodes.GETSTATIC, field.owner, field.name, field.desc));
        String boxed = switch (field.desc) { case "Z" -> "java/lang/Boolean"; case "J" -> "java/lang/Long"; default -> null; };
        if (boxed != null) hook.add(new MethodInsnNode(Opcodes.INVOKESTATIC, boxed, "valueOf", "(" + field.desc + ")L" + boxed + ";", false));
        else if (!field.desc.startsWith("L") && !field.desc.startsWith("[")) throw new IllegalStateException("Unexpected Bedrock state type: " + field.desc);
        hook.add(new LdcInsnNode(field.owner + "#" + field.name));
        hook.add(new MethodInsnNode(Opcodes.INVOKESTATIC, "de/afkservice/BedrockClientState", read ? "read" : "write",
            read ? "(Ljava/lang/Object;Ljava/lang/String;)Ljava/lang/Object;" : "(Ljava/lang/Object;Ljava/lang/String;)V", false));
        if (read) {
          hook.add(new TypeInsnNode(Opcodes.CHECKCAST, boxed != null ? boxed : field.desc.substring(1, field.desc.length() - 1)));
          if (boxed != null) hook.add(new MethodInsnNode(Opcodes.INVOKEVIRTUAL, boxed, field.desc.equals("Z") ? "booleanValue" : "longValue", "()" + field.desc, false));
        }
        method.instructions.insertBefore(field, hook);
        method.instructions.remove(field);
      }
    }
  }

  /** All external reads/writes use one timeline monitor, including resets.
   * JVM synchronized methods release it on exceptional exits as well. The
   * timeline only mutates in-memory movement records; no network waits occur
   * under this lock. Each bot retains its own timeline and independent lock. */
  private static void synchronizeMovementTimeline(ClassNode node) {
    int changed = 0;
    boolean reader = false, writer = false, reset = false;
    for (var method : node.methods) {
      if ((method.access & Opcodes.ACC_PUBLIC) == 0 || (method.access & Opcodes.ACC_STATIC) != 0 || method.name.startsWith("<")) continue;
      method.access |= Opcodes.ACC_SYNCHRONIZED;
      changed++;
      reader |= method.name.equals("pendingPhysicalFrame");
      writer |= method.name.equals("beginFrame");
      reset |= method.name.equals("resetHistory");
    }
    if (changed < 20 || !reader || !writer || !reset) throw new IllegalStateException("Unexpected pinned Bedrock movement timeline layout");
  }

  /** Cross-mixin shadows are resolved before VFP introduces this field.
   * Resolve it only after both mixins have merged, and fail closed if the
   * checksum-pinned VFP layout ever changes. Never touch actual player input. */
  private static void rearmLegacySneak(ClassNode node) {
    var fields = node.fields.stream().filter(field -> field.name.endsWith("viaFabricPlus$lastSneaking") && field.desc.equals("Z")).toList();
    var methods = node.methods.stream().filter(method -> method.name.equals("afkService$reassertSneak") && method.desc.equals("()V")).toList();
    if (fields.size() != 1 || methods.size() != 1) throw new IllegalStateException("Expected one pinned ViaFabricPlus sneak cache and reassert hook");
    var method = methods.getFirst();
    method.instructions.clear(); method.tryCatchBlocks.clear();
    method.instructions.add(new VarInsnNode(Opcodes.ALOAD, 0));
    method.instructions.add(new InsnNode(Opcodes.ICONST_0));
    method.instructions.add(new FieldInsnNode(Opcodes.PUTFIELD, node.name, fields.getFirst().name, "Z"));
    // Invoke VFP's existing version guards immediately. Re-arming alone
    // leaves delivery dependent on their later tick/injection order, notably
    // across player reconstruction. Guards keep modern/Bedrock paths intact.
    var guarded = node.methods.stream().filter(candidate ->
      (candidate.name.endsWith("$sendSneakingPacket") || candidate.name.endsWith("$sendSneakingAfterSprinting"))
      && candidate.desc.equals("(Lorg/spongepowered/asm/mixin/injection/callback/CallbackInfo;)V")).toList();
    if (guarded.size() != 2) throw new IllegalStateException("Expected two pinned ViaFabricPlus sneak version guards");
    for (var guard : guarded) {
      method.instructions.add(new VarInsnNode(Opcodes.ALOAD, 0));
      method.instructions.add(new InsnNode(Opcodes.ACONST_NULL));
      method.instructions.add(new MethodInsnNode(Opcodes.INVOKESPECIAL, node.name, guard.name, guard.desc, false));
    }
    method.instructions.add(new InsnNode(Opcodes.RETURN));
    method.maxStack = 2; method.maxLocals = 1;
  }

  /** Use the interactive renderer's existing single-frame exit, including its normal cleanup. */
  private static void progressiveCamera(ClassNode node) {
    int changed = 0;
    for (var method : node.methods) {
      if (!method.name.equals("renderWorld")) continue;
      for (var instruction : method.instructions.toArray()) {
        if (!(instruction instanceof MethodInsnNode call) || !call.owner.equals(node.name)
            || !call.name.equals("finishFrame") || call.getOpcode() != Opcodes.INVOKESTATIC) continue;
        var field = next(call);
        var bound = next(field);
        var condition = next(bound);
        var exit = next(condition);
        if (!(field instanceof FieldInsnNode viewport) || !viewport.name.equals("INTERACTIVE_VIEWPORT")
            || !(bound instanceof MethodInsnNode check) || !check.name.equals("isBound")
            || !(condition instanceof JumpInsnNode branch) || branch.getOpcode() != Opcodes.IFEQ
            || !(exit instanceof JumpInsnNode jump) || jump.getOpcode() != Opcodes.GOTO) continue;
        var hook = new InsnList();
        hook.add(new MethodInsnNode(Opcodes.INVOKESTATIC, "de/afkservice/CameraBudget", "progressive", "()Z", false));
        hook.add(new JumpInsnNode(Opcodes.IFNE, jump.label));
        method.instructions.insert(call, hook);
        changed++;
      }
    }
    if (changed != 1) throw new IllegalStateException("Expected one SoulFire 2.10.7 camera frame exit, found " + changed);
    System.out.println("[afk-service] Progressive live camera enabled");
  }

  private static AbstractInsnNode next(AbstractInsnNode instruction) {
    if (instruction == null) return null;
    var next = instruction.getNext();
    while (next != null && next.getOpcode() < 0) next = next.getNext();
    return next;
  }

  private static AbstractInsnNode previous(AbstractInsnNode instruction) {
    if (instruction == null) return null;
    var previous = instruction.getPrevious();
    while (previous != null && previous.getOpcode() < 0) previous = previous.getPrevious();
    return previous;
  }
}
