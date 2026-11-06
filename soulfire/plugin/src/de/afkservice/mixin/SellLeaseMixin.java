package de.afkservice.mixin;

import com.soulfiremc.grpc.generated.BotUpdateConfigEntryRequest;
import com.soulfiremc.grpc.generated.BotUpdateConfigEntryResponse;
import com.soulfiremc.grpc.generated.InstancePermission;
import com.soulfiremc.server.SoulFireServer;
import com.soulfiremc.server.grpc.ServerRPCConstants;
import com.soulfiremc.server.user.PermissionContext;
import de.afkservice.SellLease;
import io.grpc.Status;
import io.grpc.stub.StreamObserver;
import java.util.UUID;
import org.spongepowered.asm.mixin.Final;
import org.spongepowered.asm.mixin.Mixin;
import org.spongepowered.asm.mixin.Shadow;
import org.spongepowered.asm.mixin.injection.At;
import org.spongepowered.asm.mixin.injection.Inject;
import org.spongepowered.asm.mixin.injection.callback.CallbackInfo;

/** Keep the existing authenticated RPC contract while avoiding an instance
 * rewrite/cache invalidation for every account's five-second heartbeat. */
@Mixin(targets = "com.soulfiremc.server.grpc.BotServiceImpl", remap = false)
public abstract class SellLeaseMixin {
  @Shadow @Final private SoulFireServer soulFireServer;

  @Inject(method = "updateBotConfigEntry", at = @At("HEAD"), cancellable = true)
  private void renew(BotUpdateConfigEntryRequest request,
      StreamObserver<BotUpdateConfigEntryResponse> observer, CallbackInfo ci) {
    if (!request.getNamespace().equals("afk-service") || !request.getKey().equals("sell-lease-until")) return;
    ci.cancel();
    try {
      var instanceId = UUID.fromString(request.getInstanceId());
      var botId = UUID.fromString(request.getBotId());
      ServerRPCConstants.USER_CONTEXT_KEY.get().hasPermissionOrThrow(
          PermissionContext.instance(InstancePermission.UPDATE_BOT_CONFIG, instanceId));
      var instance = soulFireServer.getInstance(instanceId).orElseThrow(() ->
          Status.NOT_FOUND.withDescription("Lease instance not found").asRuntimeException());
      if (!instance.settingsSource().accounts().containsKey(botId))
        throw Status.NOT_FOUND.withDescription("Lease bot not found").asRuntimeException();
      if (!request.getValue().hasNumberValue() || !Double.isFinite(request.getValue().getNumberValue()))
        throw Status.INVALID_ARGUMENT.withDescription("Lease deadline must be a finite number").asRuntimeException();
      SellLease.renew(instanceId, botId, (long) request.getValue().getNumberValue(), System.currentTimeMillis());
      observer.onNext(BotUpdateConfigEntryResponse.newBuilder().build());
      observer.onCompleted();
    } catch (IllegalArgumentException error) {
      observer.onError(Status.INVALID_ARGUMENT.withDescription("Invalid lease identifier").asRuntimeException());
    } catch (Throwable error) {
      observer.onError(error);
    }
  }
}
