type Handler = (active: boolean) => Promise<void>;
const handlers = new Map<string, Handler>();
/** The native POV lease and our automation must never drive one account together. */
export function registerRemoteControl(accountId: string, handler: Handler): () => void {
  handlers.set(accountId, handler);
  return () => { if (handlers.get(accountId) === handler) handlers.delete(accountId); };
}
export async function setRemoteControl(accountId: string, active: boolean): Promise<void> {
  const handler = handlers.get(accountId);
  if (!handler) { if (active) throw new Error("Der Account ist nicht verbunden."); return; }
  await handler(active);
}
