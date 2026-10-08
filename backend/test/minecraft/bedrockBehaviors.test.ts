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
    const sender = { setSneak: vi.fn(), tickInput: vi.fn(), packet: vi.fn(() => true), command: vi.fn(), send: vi.fn() };
    const config: Config = {
      host: "localhost", port: 19132, auth_type: "offline", username: "Bot",
      cache_dir: "", crouch_enabled: crouch,
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
    expect(sender.setSneak).toHaveBeenCalledTimes(4);
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

  it("resumes auto-sell on the authoritative teleport without a second spawn event", () => {
    const { sender, behavior } = setup();
    behavior.updateConfig({ crouch_enabled: true, autosell_enabled: true, autosell_interval_seconds: 1 });
    behavior.markSpawned();
    vi.advanceTimersByTime(300);
    behavior.onTick();
    expect(sender.command).toHaveBeenCalledExactlyOnceWith("/sell");
    for (let i = 0; i < 2; i++) {
      behavior.markJoining();
      vi.advanceTimersByTime(3 * 60_000);
      behavior.onTick();
      expect(sender.command).toHaveBeenCalledTimes(i + 1);
      behavior.markTeleported();
      vi.advanceTimersByTime(150);
      behavior.onTick();
      expect(sender.command).toHaveBeenCalledTimes(i + 2);
    }
  });

  it("keeps selling every five seconds over time without local inventory data", () => {
    const { sender, behavior } = setup();
    behavior.updateConfig({ crouch_enabled: true, autosell_enabled: true, autosell_interval_seconds: 5 });
    behavior.markSpawned();
    vi.advanceTimersByTime(300);
    behavior.onTick();
    for (let i = 0; i < 120; i++) {
      vi.advanceTimersByTime(4999);
      behavior.onTick();
      expect(sender.command).toHaveBeenCalledTimes(i + 1);
      vi.advanceTimersByTime(1);
      behavior.onTick();
      expect(sender.command).toHaveBeenCalledTimes(i + 2);
    }
  });

  it("pauses ten seconds before restart and resumes five minutes afterwards across world and config changes", () => {
    const { sender, behavior } = setup();
    const cfg = { crouch_enabled: true, autosell_enabled: true, autosell_interval_seconds: 5 };
    behavior.updateConfig(cfg);
    behavior.markSpawned();
    vi.advanceTimersByTime(300);
    behavior.onTick();
    behavior.pauseAutosell(20_000, 330_000);
    vi.advanceTimersByTime(19_999);
    behavior.onTick();
    expect(sender.command).toHaveBeenCalledTimes(2);
    vi.advanceTimersByTime(1);
    behavior.onTick();
    behavior.markJoining();
    behavior.markSpawned();
    behavior.markTeleported();
    behavior.updateConfig({ ...cfg, autosell_interval_seconds: 1 });
    behavior.enqueueChat("/home");
    behavior.onTick();
    expect(sender.send).toHaveBeenCalledWith("/home");
    vi.advanceTimersByTime(309_999);
    behavior.onTick();
    expect(sender.command).toHaveBeenCalledTimes(2);
    vi.advanceTimersByTime(1);
    behavior.onTick();
    expect(sender.command).toHaveBeenCalledTimes(3);
  });

  it("honors a restart pause supplied when a subprocess is recreated", () => {
    const sender = { setSneak: vi.fn(), tickInput: vi.fn(), packet: vi.fn(() => true), command: vi.fn(), send: vi.fn() };
    const behavior = new BehaviorState({
      host: "localhost", port: 19132, auth_type: "offline", username: "Bot", cache_dir: "",
      autosell_enabled: true, autosell_pause_after_ms: 0, autosell_resume_after_ms: 60_000,
    }, sender as unknown as BotSender);
    behavior.markSpawned();
    vi.advanceTimersByTime(59_999);
    behavior.onTick();
    expect(sender.command).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    behavior.onTick();
    expect(sender.command).toHaveBeenCalledExactlyOnceWith("/sell");
  });

  it("gives manual commands priority and bypasses automation guards in FIFO order", () => {
    const { sender, behavior } = setup();
    behavior.updateConfig({ crouch_enabled: true, autosell_enabled: true, autosell_interval_seconds: 0.25 });
    behavior.enqueueBackgroundChat("/background");
    for (const text of ["/tpahere Steve", "/home", "/homes"]) behavior.enqueueChat(text);
    behavior.onTick();
    expect(sender.send).not.toHaveBeenCalled();
    behavior.markSpawned();
    for (let i = 0; i < 3; i++) behavior.onTick();
    expect(sender.send.mock.calls).toEqual([["/tpahere Steve"], ["/home"], ["/homes"]]);
    expect(sender.command).not.toHaveBeenCalled();
    vi.advanceTimersByTime(800);
    behavior.onTick();
    expect(sender.send).toHaveBeenLastCalledWith("/background");
    expect(sender.setSneak).toHaveBeenCalledWith(true);
  });

  it("never accepts teleport requests automatically, even with legacy settings", () => {
    const { sender, behavior } = setup();
    behavior.updateConfig({ crouch_enabled: true, tpauto_enabled: true } as any);
    behavior.markSpawned();
    behavior.onChat("Steve", "Steve wants to teleport to you. /tpaccept Steve tpa");
    vi.advanceTimersByTime(300);
    behavior.onTick();
    expect(sender.send).not.toHaveBeenCalled();
  });
});
