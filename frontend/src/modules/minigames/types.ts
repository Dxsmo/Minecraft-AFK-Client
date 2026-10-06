export interface Member {
  uuid: string;
  name: string;
  ready: boolean;
  connection: string;
  status: string;
  minecraftVersion: string;
  modVersion: string;
  score: number;
  streamerMode: boolean;
}
export interface Lobby {
  id: string;
  code: string;
  host: string;
  game: string;
  state: string;
  createdAt: number;
  startedAt?: number;
  roundEndsAt?: number;
  revision: number;
  round: number;
  members: Member[];
  config: Record<string, string | number | boolean>;
  bans: string[];
  kicks: Record<string, number>;
  data: Record<string, unknown>;
  events?: Log[];
  streamerModeCount?: number;
}
export interface Log {
  id: string;
  type: string;
  lobbyId?: string;
  playerUuid?: string;
  game?: string;
  createdAt: string;
  details: string;
}
export interface Content {
  id: string;
  kind: "item" | "word" | "photo" | "settings";
  enabled: boolean;
  data: Record<string, string | number | boolean | string[]>;
}
export interface Page<T> {
  total: number;
  items: T[];
}
export const gameNames: Record<string, string> = {
  bingo: "Bingo",
  hot_potato: "Heiße Kartoffel",
  hide_seek: "Hide & Seek",
  item_hunt: "Item Hunt",
  masterbuilders: "MasterBuilders",
  tictactoe: "TicTacToe",
  connect_four: "4 Gewinnt",
  memory: "Memory",
  rps: "Schere Stein Papier",
  photo_hunt: "Photo Hunt",
  collector: "Sammelwahn",
};
export const time = (value?: number | string) =>
  value ? new Date(value).toLocaleString("de-DE") : "—";
