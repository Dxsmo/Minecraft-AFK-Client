import type { ClientStatus } from "@prisma/client";

/** Telemetry is broadcast live, but only lifecycle transitions need a DB write.
 * Serialize transitions so a slower ONLINE write cannot overwrite a later OFFLINE.
 */
export function createStatusPersistence(
  initial: ClientStatus,
  write: (status: ClientStatus) => Promise<unknown>,
  onError: (error: unknown) => void,
) {
  let lastRequested: ClientStatus | undefined = initial;
  let queue = Promise.resolve();
  return (status: ClientStatus): Promise<void> => {
    if (status === lastRequested) return queue;
    lastRequested = status;
    queue = queue.then(() => write(status)).then(() => {}, error => {
      if (lastRequested === status) lastRequested = undefined;
      onError(error);
    });
    return queue;
  };
}
