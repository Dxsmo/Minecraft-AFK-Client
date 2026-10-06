import { useResource } from "./resource";
import { State, Table, Cell } from "./shared";
import { time, type Log } from "./types";
interface Health {
  serviceStatus: string;
  databaseStatus: string;
  uptimeSeconds: number;
  connectedClients: number;
  activeLobbies: number;
  runningGames: number;
  gamesToday: number;
  websocketConnections: number;
  versionDistribution: Record<string, number>;
  protocolDistribution: Record<string, number>;
  recentErrors: Log[];
}
export function Dashboard({ backend = false }: { backend?: boolean }) {
  const { data, error, loading } = useResource<Health>(
    "/minigames/admin/dashboard",
    5000,
  );
  return (
    <>
      <State error={error} loading={loading} />
      {data && (
        <>
          <div className="grid grid-cols-2 lg:grid-cols-3 gap-4 mb-6">
            {[
              ["Verbundene Mod-Clients", data.connectedClients],
              ["Aktive Lobbys", data.activeLobbies],
              ["Laufende Spiele", data.runningGames],
              ["Spiele heute", data.gamesToday],
              ["WebSocket-Verbindungen", data.websocketConnections],
              ["Backend", data.serviceStatus],
            ].map(([label, value]) => (
              <div key={label} className="card p-5">
                <p
                  className="text-xs mb-2"
                  style={{ color: "var(--text-muted)" }}
                >
                  {label}
                </p>
                <p className="text-3xl font-semibold tabular-nums">{value}</p>
              </div>
            ))}
          </div>
          <div className="grid md:grid-cols-2 gap-4 mb-6">
            <div className="card p-5">
              <h2 className="font-semibold mb-3">Minecraft-Versionen</h2>
              {Object.entries(data.versionDistribution).map(
                ([version, count]) => (
                  <div
                    key={version}
                    className="flex justify-between py-2 border-b"
                  >
                    <span>{version}</span>
                    <span>{count}</span>
                  </div>
                ),
              )}
              {!Object.keys(data.versionDistribution).length && (
                <p className="text-sm">Keine Clients verbunden.</p>
              )}
            </div>
            <div className="card p-5">
              <h2 className="font-semibold mb-3">Dienststatus</h2>
              <p>Datenbank: {data.databaseStatus}</p>
              <p className="mt-2">
                Laufzeit: {Math.floor(data.uptimeSeconds / 60)} Minuten
              </p>
              {Object.entries(data.protocolDistribution).map(
                ([version, count]) => (
                  <p key={version} className="mt-2">
                    Protokoll {version}: {count} Clients
                  </p>
                ),
              )}
            </div>
          </div>
          {backend && (
            <>
              <h2 className="font-semibold mb-3">Letzte Fehler</h2>
              <Table headers={["Zeit", "Ereignis", "Lobby"]}>
                {data.recentErrors.map((e) => (
                  <tr key={e.id}>
                    <Cell>{time(e.createdAt)}</Cell>
                    <Cell>{e.type}</Cell>
                    <Cell>{e.lobbyId}</Cell>
                  </tr>
                ))}
              </Table>
              {!data.recentErrors.length && (
                <p className="text-sm mt-3">
                  Keine Vorbereitungsfehler protokolliert.
                </p>
              )}
            </>
          )}
        </>
      )}
    </>
  );
}
