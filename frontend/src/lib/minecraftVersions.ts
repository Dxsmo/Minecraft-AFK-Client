/**
 * Empty string tells the backend to auto-detect the server's actual
 * protocol version (via a ping) instead of forcing a specific one. This is
 * the recommended default — pinning an incorrect version can make a
 * connection *look* successful (login, resource pack, even showing up in
 * the server's player list) while the actual game-state packets silently
 * fail to decode afterwards.
 */
export const AUTO_DETECT_VERSION = "";

/**
 * Minecraft Java Edition server versions selectable in account settings. The Java bot itself uses
 * Azalea 26.2 (protocol 776); other servers require compatible translation.
 */
export const MINECRAFT_VERSIONS = [
  "26.2",
  "26.1.2",
  "26.1.1",
  "26.1",
  "1.21.11",
  "1.21.10",
  "1.21.9",
  "1.21.8",
  "1.21.6",
  "1.21.5",
  "1.21.4",
  "1.21.3",
  "1.21.1",
  "1.21",
  "1.20.6",
  "1.20.5",
  "1.20.4",
  "1.20.3",
  "1.20.2",
  "1.20.1",
  "1.20",
  "1.19.4",
  "1.19.3",
  "1.19.2",
  "1.19",
  "1.18.2",
  "1.18.1",
  "1.18",
  "1.17.1",
  "1.17",
  "1.16.5",
  "1.16.4",
  "1.16.3",
  "1.16.2",
  "1.16.1",
  "1.16",
  "1.15.2",
  "1.15.1",
  "1.15",
  "1.14.4",
  "1.14.3",
  "1.14.1",
  "1.14",
  "1.13.2",
  "1.13.1",
  "1.13",
  "1.12.2",
  "1.12.1",
  "1.12",
  "1.11.2",
  "1.11",
  "1.10.2",
  "1.10.1",
  "1.10",
  "1.9.4",
  "1.9.2",
  "1.9",
  "1.8",
];
