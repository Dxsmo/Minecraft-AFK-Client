/** Minimal lifecycle surface shared by OS processes and in-process controllers.
 * Keep event return types structural across installed Node type versions. */
export interface TerminableProcess {
  exitCode: number | null;
  signalCode: NodeJS.Signals | null;
  once(event: "exit" | "close", listener: () => void): unknown;
  removeListener(event: "exit" | "close", listener: () => void): unknown;
  kill(signal?: NodeJS.Signals): boolean;
}

/** Escalate until the process actually exits, even if it ignores SIGTERM. */
export function terminateSubprocess(child: TerminableProcess, graceMs = 500, forceMs = 1500): void {
  if (child.exitCode != null || child.signalCode != null) return;
  let exited = false;
  let termTimer: NodeJS.Timeout | undefined;
  let forceTimer: NodeJS.Timeout | undefined;
  const finish = () => {
    exited = true;
    clearTimeout(termTimer);
    clearTimeout(forceTimer);
    child.removeListener("exit", finish);
    child.removeListener("close", finish);
  };
  const running = () => !exited && child.exitCode == null && child.signalCode == null;
  child.once("exit", finish);
  child.once("close", finish);
  termTimer = setTimeout(() => {
    if (!running()) { finish(); return; }
    forceTimer = setTimeout(() => {
      if (running()) child.kill("SIGKILL");
      else finish();
    }, forceMs);
    // ChildProcess.killed only confirms a signal was sent. A native addon or
    // SIGTERM handler may keep running afterwards; never use it as an exit flag.
    child.kill("SIGTERM");
  }, graceMs);
}
