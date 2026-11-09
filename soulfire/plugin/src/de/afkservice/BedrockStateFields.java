package de.afkservice;

import java.util.Map;
import java.util.Set;

/** Explicit mutable state in the checksum-pinned StackAnvil client. Protocol
 * constants, registered callbacks, thread-local replay scopes and GPU caches
 * remain process-wide. Each declared field must be found by the transformer. */
public final class BedrockStateFields {
  private static final String INPUT = "com/viaversion/viafabricplus/bedrock/input/";
  private static final String RENDER = "com/viaversion/viafabricplus/bedrock/render/";
  public static final Map<String, Set<String>> FIELDS = Map.ofEntries(
    Map.entry(INPUT + "BedrockInputPermissions", Set.of("permissions", "active", "RAW_INPUT")),
    Map.entry(INPUT + "BedrockItemUse", Set.of("PLACEMENT", "PATH", "held", "placedBlock", "successfulAttempt", "airAllowed", "INPUT", "cursor", "predictedResult")),
    Map.entry(INPUT + "BedrockMovementEffects", Set.of("TIMELINE", "clockOwner", "listenerOwner", "UNDERWATER_SPEEDS", "FLIGHT_CONTEXTS")),
    Map.entry(INPUT + "BedrockPhysicalReplay", Set.of("session")),
    Map.entry(INPUT + "BedrockPlayerCorrections", Set.of("TRACKER")),
    Map.entry(INPUT + "BedrockPlayerModes", Set.of("latest")),
    Map.entry(INPUT + "BedrockRemotePlayerMovement", Set.of("TRACKER", "connection", "level")),
    Map.entry(INPUT + "BedrockVehiclePredictions", Set.of("SESSION")),
    Map.entry(RENDER + "BedrockActorState", Set.of("ACTORS", "generation", "uniqueIdsAvailable")),
    Map.entry(RENDER + "BedrockProjectileOwners", Set.of("OWNERS", "generation"))
  );
  private BedrockStateFields() {}
}
