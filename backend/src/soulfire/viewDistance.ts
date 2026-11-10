/** Client send/view radius only. Multiplayer simulation distance is owned by
 * the server; changing a local option cannot force farms to tick there. */
export function soulFireViewDistance(): number {
  const distance = Number(process.env.SOULFIRE_VIEW_DISTANCE ?? 4);
  if (!Number.isInteger(distance) || distance < 2 || distance > 32)
    throw new Error("SOULFIRE_VIEW_DISTANCE must be an integer from 2 to 32");
  return distance;
}
