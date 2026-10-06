import { useResource } from "./resource";
import { useState } from "react";
import { Link, useParams } from "react-router-dom";
import { api } from "../../lib/api";
import { State, Table, Cell, Pagination, Status, Json } from "./shared";
import { gameNames, time, type Lobby, type Page, type Log } from "./types";
export function Lobbies() {
  const [offset, setOffset] = useState(0);
  const { data, error, loading } = useResource<Page<Lobby>>(
    `/minigames/admin/lobbies?offset=${offset}`,
    5000,
  );
  return (
    <>
      <State error={error} loading={loading} />
      <Table
        headers={[
          "Spiel / Lobby",
          "Host",
          "Spieler",
          "Status",
          "Erstellt",
          "Gestartet",
          "Versionen",
          "Streamer",
          "WebSocket",
        ]}
      >
        {data?.items.map((l) => (
          <tr key={l.id}>
            <Cell>
              <Link className="underline" to={l.id}>
                {gameNames[l.game]}
              </Link>
              <p className="text-xs opacity-50 mt-1">{l.id}</p>
            </Cell>
            <Cell>{l.members.find((m) => m.uuid === l.host)?.name}</Cell>
            <Cell>
              {l.members.length}/{l.config.maxPlayers}
            </Cell>
            <Cell>
              <Status value={l.state} />
            </Cell>
            <Cell>{time(l.createdAt)}</Cell>
            <Cell>{time(l.startedAt)}</Cell>
            <Cell>
              {[...new Set(l.members.map((m) => m.minecraftVersion))].join(
                ", ",
              )}
            </Cell>
            <Cell>{l.streamerModeCount}</Cell>
            <Cell>
              {l.members.filter((m) => m.connection === "CONNECTED").length}/
              {l.members.length} verbunden
            </Cell>
          </tr>
        ))}
      </Table>
      {data?.total === 0 && (
        <p className="text-sm py-6">Keine aktiven Lobbys.</p>
      )}
      <Pagination
        total={data?.total ?? 0}
        offset={offset}
        onChange={setOffset}
      />
    </>
  );
}
export function LobbyDetail() {
  const { id } = useParams();
  const [reveal, setReveal] = useState(false);
  const [confirm, setConfirm] = useState(false);
  const [actionError, setActionError] = useState("");
  const [closed, setClosed] = useState(false);
  const {
    data: l,
    error,
    loading,
    reload,
  } = useResource<Lobby>(
    `/minigames/admin/lobbies/${id}?reveal=${reveal}`,
    5000,
  );
  const close = async () => {
    try {
      await api.delete(`/minigames/admin/lobbies/${id}`);
      setClosed(true);
    } catch (e) {
      setActionError(e instanceof Error ? e.message : "Aktion fehlgeschlagen");
    }
  };
  if (closed)
    return (
      <p>
        Lobby geschlossen.{" "}
        <Link className="underline" to="/minigames/lobbies">
          Zur Lobbyliste
        </Link>
      </p>
    );
  return (
    <>
      <Link className="text-sm underline" to="/minigames/lobbies">
        ← Lobbys
      </Link>
      <State error={actionError || error} loading={loading} />
      {l && (
        <>
          <div className="flex flex-wrap justify-between gap-4 my-5">
            <div>
              <h2 className="text-xl font-semibold">{gameNames[l.game]}</h2>
              <p className="text-xs opacity-50 mt-1">{l.id}</p>
            </div>
            <button className="btn btn-danger" onClick={() => setConfirm(true)}>
              Lobby schließen
            </button>
          </div>
          {confirm && (
            <div
              role="alertdialog"
              aria-label="Lobby schließen"
              className="card p-5 mb-4"
            >
              <p>
                Diese Lobby und das laufende Spiel für alle Teilnehmer sofort
                schließen?
              </p>
              <div className="flex gap-2 mt-3">
                <button className="btn btn-danger" onClick={() => void close()}>
                  Jetzt schließen
                </button>
                <button
                  className="btn btn-secondary"
                  onClick={() => setConfirm(false)}
                >
                  Abbrechen
                </button>
              </div>
            </div>
          )}
          <div className="card p-4 mb-5 flex flex-wrap items-center gap-4">
            <Status value={l.state} />
            <span>Runde {l.round}</span>
            <span>Ende: {time(l.roundEndsAt)}</span>
            <span>
              Code: <strong className="font-mono select-all">{l.code}</strong>
            </span>
            <button
              className="btn btn-secondary btn-sm"
              onClick={() => setReveal(!reveal)}
            >
              {reveal ? "Code verdecken" : "Code bewusst anzeigen"}
            </button>
            <button
              className="btn btn-ghost btn-sm"
              onClick={() => void reload()}
            >
              Aktualisieren
            </button>
          </div>
          <Table
            headers={[
              "Spieler",
              "Rolle",
              "Bereit",
              "Verbindung",
              "Spielstatus",
              "Version / Mod",
              "Score",
            ]}
          >
            {l.members.map((m) => (
              <tr key={m.uuid}>
                <Cell>
                  {m.name}
                  <p className="text-xs opacity-50">{m.uuid}</p>
                </Cell>
                <Cell>{l.host === m.uuid ? "HOST" : "Teilnehmer"}</Cell>
                <Cell>{m.ready ? "READY" : "NOT READY"}</Cell>
                <Cell>{m.connection}</Cell>
                <Cell>{m.status}</Cell>
                <Cell>
                  {m.minecraftVersion} / {m.modVersion}
                </Cell>
                <Cell>{m.score}</Cell>
              </tr>
            ))}
          </Table>
          <div className="grid md:grid-cols-2 gap-4 mt-5">
            <div>
              <h3 className="font-semibold mb-2">
                Konfiguration bei Lobbyerstellung
              </h3>
              <Json value={l.config} />
            </div>
            <div>
              <h3 className="font-semibold mb-2">Lobby-Bans / Kick-Historie</h3>
              <Json value={{ bans: l.bans, kicks: l.kicks }} />
            </div>
          </div>
          <h3 className="font-semibold my-3">Spielzustand</h3>
          <Json value={l.data} />
          <h3 className="font-semibold my-3">Letzte Ereignisse</h3>
          <EventTable rows={l.events ?? []} />
        </>
      )}
    </>
  );
}
interface Player {
  uuid: string;
  name: string;
  minecraftVersion: string;
  modVersion: string;
  protocolVersion: number;
  currentLobby?: string;
  connectionState: string;
  lastSeen: string;
}
export function Players() {
  const [offset, setOffset] = useState(0);
  const { data, error, loading } = useResource<Page<Player>>(
    `/minigames/admin/players?offset=${offset}`,
    5000,
  );
  return (
    <>
      <State error={error} loading={loading} />
      <Table
        headers={[
          "Spieler / UUID",
          "Minecraft",
          "Mod",
          "Protokoll",
          "Lobby",
          "Verbindung",
          "Zuletzt gesehen",
        ]}
      >
        {data?.items.map((p) => (
          <tr key={p.uuid}>
            <Cell>
              {p.name}
              <p className="text-xs opacity-50">{p.uuid}</p>
            </Cell>
            <Cell>{p.minecraftVersion}</Cell>
            <Cell>{p.modVersion}</Cell>
            <Cell>{p.protocolVersion}</Cell>
            <Cell>
              {p.currentLobby ? (
                <Link
                  className="underline"
                  to={"/minigames/lobbies/" + p.currentLobby}
                >
                  Details
                </Link>
              ) : (
                "—"
              )}
            </Cell>
            <Cell>
              <Status value={p.connectionState} />
            </Cell>
            <Cell>{time(p.lastSeen)}</Cell>
          </tr>
        ))}
      </Table>
      <Pagination
        total={data?.total ?? 0}
        offset={offset}
        onChange={setOffset}
      />
    </>
  );
}
function EventTable({ rows }: { rows: Log[] }) {
  return (
    <Table
      headers={["Zeit", "Ereignis", "Spiel / Lobby", "Spieler", "Details"]}
    >
      {rows.map((e) => (
        <tr key={e.id}>
          <Cell>{time(e.createdAt)}</Cell>
          <Cell>{e.type}</Cell>
          <Cell>
            {e.game ? gameNames[e.game] : ""}
            {e.lobbyId && (
              <p>
                <Link
                  className="text-xs underline"
                  to={"/minigames/lobbies/" + e.lobbyId}
                >
                  {e.lobbyId}
                </Link>
              </p>
            )}
          </Cell>
          <Cell>{e.playerUuid ?? "—"}</Cell>
          <Cell>
            <details>
              <summary className="cursor-pointer">Anzeigen</summary>
              <Json value={JSON.parse(e.details)} />
            </details>
          </Cell>
        </tr>
      ))}
    </Table>
  );
}
export function Logs() {
  const [offset, setOffset] = useState(0);
  const [filters, setFilters] = useState<Record<string, string>>({});
  const [draft, setDraft] = useState<Record<string, string>>({});
  const q = new URLSearchParams({ offset: String(offset), ...filters });
  const { data, error, loading } = useResource<Page<Log>>(
    "/minigames/admin/logs?" + q,
  );
  return (
    <>
      <form
        className="card p-4 grid grid-cols-2 md:grid-cols-3 gap-3 mb-4"
        onSubmit={(e) => {
          e.preventDefault();
          setOffset(0);
          setFilters(
            Object.fromEntries(
              Object.entries(draft)
                .filter(([, v]) => v)
                .map(([k, v]) => [
                  k,
                  k === "from" || k === "to" ? new Date(v).toISOString() : v,
                ]),
            ),
          );
        }}
      >
        {[
          ["lobby", "Lobby-ID"],
          ["player", "Spieler-UUID"],
          ["type", "Ereignistyp"],
          ["from", "Von"],
          ["to", "Bis"],
        ].map(([key, label]) => (
          <label key={key} className="label">
            {label}
            <input
              className="input mt-1"
              type={key === "from" || key === "to" ? "datetime-local" : "text"}
              value={draft[key] ?? ""}
              onChange={(e) => setDraft({ ...draft, [key]: e.target.value })}
            />
          </label>
        ))}
        <label className="label">
          Spiel
          <select
            className="input mt-1"
            value={draft.game ?? ""}
            onChange={(e) => setDraft({ ...draft, game: e.target.value })}
          >
            <option value="">Alle</option>
            {Object.entries(gameNames).map(([id, name]) => (
              <option key={id} value={id}>
                {name}
              </option>
            ))}
          </select>
        </label>
        <button className="btn btn-secondary">Filtern</button>
      </form>
      <State error={error} loading={loading} />
      <EventTable rows={data?.items ?? []} />
      <Pagination
        total={data?.total ?? 0}
        offset={offset}
        onChange={setOffset}
      />
    </>
  );
}
