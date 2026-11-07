package de.afkservice;
import com.soulfiremc.server.api.SoulFireAPI;
import com.soulfiremc.server.api.event.bot.BotPreTickEvent;
import net.fabricmc.api.ModInitializer;
import net.minecraft.client.Minecraft;
import java.lang.reflect.Field;
import java.util.Queue;
import java.util.concurrent.*;
import java.util.concurrent.atomic.AtomicBoolean;
import java.nio.file.*;
import sun.misc.Unsafe;
/** Synthetic test only: never installed on the Pi. */
public final class EmoteLeakProbe implements ModInitializer {
 private static final AtomicBoolean once = new AtomicBoolean();
 public void onInitialize() {
  SoulFireAPI.registerListener(BotPreTickEvent.class,event->{
   if(event.connection().minecraft().player==null || !once.compareAndSet(false,true))return;
   try {
    var type=Class.forName("com.viaversion.viafabricplus.bedrock.appearance.BedrockEmotePlayback");
    Field account=type.getDeclaredField("account"), loading=type.getDeclaredField("loading");
    account.setAccessible(true);loading.setAccessible(true);
    Object previous=account.get(null);boolean before=loading.getBoolean(null);
    Field unsafe=Unsafe.class.getDeclaredField("theUnsafe");unsafe.setAccessible(true);
    Object fake=((Unsafe)unsafe.get(null)).allocateInstance(account.getType());
    var refresh=type.getMethod("refresh");int started=0;
    try {
     account.set(null,fake);
     for(int i=0;i<1000;i++){
      loading.setBoolean(null,false);refresh.invoke(null);
      if(loading.getBoolean(null))started++;
     }
    }finally{account.set(null,previous);loading.setBoolean(null,before);}
    final int requested=started;
    CompletableFuture.delayedExecutor(4,TimeUnit.SECONDS).execute(()->{
     try{
      var base=Minecraft.getInstance();Queue<?> queue=null;
      for(Class<?> c=base.getClass();c!=null;c=c.getSuperclass())
       for(var f:c.getDeclaredFields())if(f.getName().equals("pendingRunnables")){
        f.setAccessible(true);queue=(Queue<?>)f.get(base);
       }
      if(queue==null)throw new IllegalStateException("No base-client task queue");
      long retained=queue.stream().filter(x->x.getClass().getName().contains("BedrockEmotePlayback")).count();
      String json="{\"attempts\":1000,\"catalogueRequests\":"+requested+",\"retainedEmoteCallbacks\":"+retained+"}";
      Files.writeString(Path.of(System.getProperty("sf.baseDir"),"emote-probe.json"),json);
      System.out.println("[emote-probe] "+json);
     }catch(Throwable e){e.printStackTrace();}
    });
   }catch(Throwable e){e.printStackTrace();}
  });
 }
}
