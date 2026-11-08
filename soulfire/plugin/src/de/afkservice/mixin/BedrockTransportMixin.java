package de.afkservice.mixin;

import org.spongepowered.asm.mixin.Mixin;
import org.spongepowered.asm.mixin.injection.At;
import org.spongepowered.asm.mixin.injection.Redirect;

/** 2.10.7 defaults bare Bedrock addresses to NetherNet. Existing AFK account
 * endpoints are explicitly configured RakNet host/port pairs. Preserve those;
 * explicitly supplied NetherNet addresses retain their upstream parsing.
 */
@Mixin(targets = "com.soulfiremc.server.bot.BotConnectionFactory", remap = false)
public abstract class BedrockTransportMixin {
  @Redirect(method = "parseAddress", at = @At(value = "INVOKE", target = "Ljava/lang/String;contains(Ljava/lang/CharSequence;)Z"))
  private static boolean preserveConfiguredTransport(String address, CharSequence schemeSeparator) {
    return true;
  }
}
