package de.afkservice;

import java.lang.reflect.InvocationTargetException;
import java.lang.reflect.Modifier;
import java.util.Map;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicReference;
import java.util.function.IntPredicate;

/** Real upstream timeline, two concurrent callers, no mock collections. */
public final class TimelineRace {
  public static Map<String, Object> run() throws Exception {
    var type = Class.forName("net.raphimc.viabedrock.api.model.MovementEffectTimeline");
    Object timeline = type.getConstructor().newInstance();
    var begin = type.getMethod("beginFrame");
    var complete = type.getMethod("completeFrame");
    var pending = type.getMethod("pendingPhysicalFrame", IntPredicate.class);
    var reset = type.getMethod("resetHistory");
    var start = new CountDownLatch(1);
    var done = new CountDownLatch(2);
    var error = new AtomicReference<Throwable>();
    Thread writer = Thread.ofPlatform().daemon().start(() -> {
      try {
        start.await();
        for (int i = 0; i < 100_000 && error.get() == null; i++) {
          begin.invoke(timeline); complete.invoke(timeline);
          if (i % 1000 == 0) reset.invoke(timeline);
        }
      } catch (Throwable e) { error.compareAndSet(null, e); }
      finally { done.countDown(); }
    });
    Thread reader = Thread.ofPlatform().daemon().start(() -> {
      try {
        start.await();
        for (int i = 0; i < 2000 && error.get() == null; i++) pending.invoke(timeline, (IntPredicate) actor -> true);
      } catch (Throwable e) { error.compareAndSet(null, e); }
      finally { done.countDown(); }
    });
    start.countDown();
    if (!done.await(15, TimeUnit.SECONDS)) throw new IllegalStateException("Movement timeline race did not finish");
    Throwable failure = error.get();
    if (failure instanceof InvocationTargetException invocation) failure = invocation.getCause();
    return Map.of("error", failure == null ? "" : failure.toString(), "completed", failure == null,
        "readerSynchronized", Modifier.isSynchronized(pending.getModifiers()),
        "writerSynchronized", Modifier.isSynchronized(begin.getModifiers()),
        "resetSynchronized", Modifier.isSynchronized(reset.getModifiers()));
  }

  public static void main(String[] args) throws Exception { System.out.println(run()); }
}
