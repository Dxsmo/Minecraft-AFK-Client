import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BehaviorState } from "../../src/bedrock-bot/behaviors.js";
import type { Config } from "../../src/bedrock-bot/protocol.js";
import type { BotSender } from "../../src/bedrock-bot/send.js";

describe("Bedrock crouch after world transitions", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.spyOn(process.stdout, "write").mockImplementation(() => true);
  });
  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  function setup(crouch = true) {
    const sender = { setSneak: vi.fn() };
    const config: Config = {
      host: "localhost", port: 19132, auth_type: "offline", username: "Bot",
      cache_dir: "", crouch_enabled: crouch,
      auto_command_enabled: false, auto_command_text: "", auto_command_interval_minutes: 5,
    };
    return { sender, behavior: new BehaviorState(config, sender as unknown as BotSender) };
  }

  it("re-sends held sneak after joining the lobby and returning to the world", () => {
    const { sender, behavior } = setup();
    behavior.markSpawned();
    vi.advanceTimersByTime(300);
    behavior.onTick();
    expect(sender.setSneak).toHaveBeenCalledExactlyOnceWith(true);
    for (let i = 0; i < 2; i++) {
      behavior.markJoining();
      behavior.onTick();
      expect(sender.setSneak).toHaveBeenCalledTimes(i + 1);
      behavior.markSpawned();
      vi.advanceTimersByTime(300);
      behavior.onTick();
      expect(sender.setSneak).toHaveBeenCalledTimes(i + 2);
    }
    vi.advanceTimersByTime(60_000);
    behavior.onTick();
    expect(sender.setSneak).toHaveBeenCalledTimes(3);
    expect(sender.setSneak).not.toHaveBeenCalledWith(false);
  });

  it("restores sneak after a position teleport without another spawn", () => {
    const { sender, behavior } = setup();
    behavior.markSpawned();
    vi.advanceTimersByTime(300);
    behavior.onTick();
    behavior.markTeleported();
    vi.advanceTimersByTime(150);
    behavior.onTick();
    expect(sender.setSneak.mock.calls).toEqual([[true], [true]]);
  });

  it("leaves crouch disabled when it is switched off", () => {
    const { sender, behavior } = setup(false);
    behavior.markSpawned();
    vi.advanceTimersByTime(300);
    behavior.onTick();
    behavior.markTeleported();
    vi.advanceTimersByTime(150);
    behavior.onTick();
    expect(sender.setSneak).not.toHaveBeenCalled();
  });
});
