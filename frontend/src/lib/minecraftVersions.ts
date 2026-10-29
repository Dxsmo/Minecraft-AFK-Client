/**
 * Empty string tells the backend to auto-detect the server's actual
 * protocol version (via a ping) instead of forcing a specific one. This is
 * the recommended default — pinning an incorrect version can make a
 * connection *look* successful (login, resource pack, even showing up in
 * the server's player list) while the actual game-state packets silently
 * fail to decode afterwards.
 */
export const AUTO_DETECT_VERSION = "";
