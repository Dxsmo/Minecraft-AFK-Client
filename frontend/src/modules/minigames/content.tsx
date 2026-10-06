import { useResource } from "./resource";
import { useState } from "react";
import { api } from "../../lib/api";
import { State, Table, Cell, Pagination } from "./shared";
import { gameNames, type Content, type Page } from "./types";
const difficulties = ["LEICHT", "MITTEL", "SCHWER"];
const versions = ["1.21.11", "26.1", "26.1.1", "26.1.2", "26.2", "26.3"];
const options: Record<string, (string | number)[]> = {
  difficulty: [...difficulties, "MIXED"],
  winCondition: ["FIRST_LINE", "TWO_LINES", "FULL_BOARD", "LOCKOUT"],
  boardDisplay: ["SCREEN", "HUD"],
  dimensionFilter: ["ALL", "NETHER", "END", "MOB", "STRUCTURE"],
  bestOf: [1, 3, 5, 7],
};
const labels: Record<string, string> = {
  maxPlayers: "Maximale Spieler",
  durationMinutes: "Rundendauer (Minuten)",
  boardSize: "Boardgröße",
  difficulty: "Schwierigkeit",
  winCondition: "Siegbedingung",
  boardDisplay: "Boarddarstellung",
  hideSeconds: "Versteckzeit (Sekunden)",
  radius: "Spielradius (Blöcke)",
  allowElytra: "Elytra erlauben",
  allowDimension: "Dimensionswechsel erlauben",
  hints: "Hinweise",
  dimensionFilter: "Itemfilter",
  bestOf: "Best of",
  displayNameDe: "Deutscher Itemname",
  survivalObtainable: "Im Survival erhältlich",
  bingoEligible: "Für Bingo",
  itemHuntEligible: "Für Item Hunt",
  collectorEligible: "Für Sammelwahn",
  word: "Deutsches Wort",
  textDe: "Deutsche Foto-Challenge",
  category: "Kategorie",
};
function Fields({
  value,
  onChange,
  game,
}: {
  value: Content["data"];
  onChange: (v: Content["data"]) => void;
  game?: string;
}) {
  return (
    <div className="grid md:grid-cols-2 gap-4">
      {Object.entries(value)
        .filter(([key]) => key !== "itemId")
        .map(([key, v]) => {
          if (Array.isArray(v))
            return (
              <fieldset key={key}>
                <legend className="label">Unterstützte Versionen</legend>
                <div className="flex flex-wrap gap-3">
                  {versions.map((version) => (
                    <label key={version} className="text-sm flex gap-1">
                      <input
                        type="checkbox"
                        checked={v.includes(version)}
                        onChange={(e) =>
                          onChange({
                            ...value,
                            [key]: e.target.checked
                              ? [...v, version]
                              : v.filter((x) => x !== version),
                          })
                        }
                      />
                      {version}
                    </label>
                  ))}
                </div>
              </fieldset>
            );
          const choices =
            key === "boardSize"
              ? game === "bingo"
                ? [3, 4, 5]
                : ["4x4", "6x4", "6x6"]
              : key === "category"
                ? ["OVERWORLD", "NETHER", "END", "MOB", "STRUCTURE"]
                : key === "difficulty" && !game
                  ? difficulties
                  : options[key];
          if (typeof v === "boolean")
            return (
              <label key={key} className="flex gap-2 items-center text-sm">
                <input
                  type="checkbox"
                  checked={v}
                  onChange={(e) =>
                    onChange({ ...value, [key]: e.target.checked })
                  }
                />
                {labels[key] ?? key}
              </label>
            );
          return (
            <label key={key} className="label">
              {labels[key] ?? key}
              {choices ? (
                <select
                  aria-label={labels[key] ?? key}
                  className="input mt-1"
                  value={String(v)}
                  onChange={(e) =>
                    onChange({
                      ...value,
                      [key]:
                        typeof v === "number"
                          ? Number(e.target.value)
                          : e.target.value,
                    })
                  }
                >
                  {choices.map((c) => (
                    <option key={c} value={c}>
                      {c}
                    </option>
                  ))}
                </select>
              ) : key === "textDe" ? (
                <textarea
                  className="input mt-1"
                  value={String(v)}
                  maxLength={200}
                  required
                  onChange={(e) =>
                    onChange({ ...value, [key]: e.target.value })
                  }
                />
              ) : (
                <input
                  className="input mt-1"
                  type={typeof v === "number" ? "number" : "text"}
                  value={String(v)}
                  min={1}
                  required
                  maxLength={100}
                  onChange={(e) =>
                    onChange({
                      ...value,
                      [key]:
                        typeof v === "number"
                          ? Number(e.target.value)
                          : e.target.value,
                    })
                  }
                />
              )}
            </label>
          );
        })}
    </div>
  );
}
export function ContentPage() {
  const [kind, setKind] = useState("item");
  const [search, setSearch] = useState("");
  const [offset, setOffset] = useState(0);
  const [edit, setEdit] = useState<Content>();
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  const {
    data,
    error: loadError,
    loading,
    reload,
  } = useResource<Page<Content>>(
    `/minigames/admin/content?kind=${kind}&offset=${offset}&search=${encodeURIComponent(search)}`,
  );
  const save = async () => {
    if (!edit) return;
    setSaving(true);
    try {
      await api.put("/minigames/admin/content/" + encodeURIComponent(edit.id), {
        kind: edit.kind,
        enabled: edit.enabled,
        data: edit.data,
      });
      setEdit(undefined);
      setError("");
      await reload();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Speichern fehlgeschlagen");
    } finally {
      setSaving(false);
    }
  };
  const create = () => {
    const id =
      kind === "item" ? "minecraft:" : `${kind}-${crypto.randomUUID()}`;
    const data: Content["data"] =
      kind === "item"
        ? {
            itemId: id,
            displayNameDe: "",
            survivalObtainable: true,
            difficulty: "MITTEL",
            bingoEligible: true,
            itemHuntEligible: true,
            collectorEligible: true,
            supportedVersions: versions,
            category: "OVERWORLD",
          }
        : kind === "word"
          ? { word: "", difficulty: "MITTEL" }
          : { textDe: "", difficulty: "MITTEL" };
    setEdit({ id, kind: kind as Content["kind"], enabled: true, data });
  };
  return (
    <>
      <div className="flex flex-wrap gap-3 mb-4">
        <select
          aria-label="Inhaltsart"
          className="input max-w-56"
          value={kind}
          onChange={(e) => {
            setKind(e.target.value);
            setOffset(0);
            setEdit(undefined);
          }}
        >
          <option value="item">Item-Katalog</option>
          <option value="word">MasterBuilders-Wörter</option>
          <option value="photo">Photo-Hunt-Challenges</option>
        </select>
        <input
          aria-label="Inhalte suchen"
          placeholder="Suchen…"
          className="input max-w-64"
          value={search}
          onChange={(e) => {
            setSearch(e.target.value);
            setOffset(0);
          }}
        />
        <button className="btn btn-primary" onClick={create}>
          Neu hinzufügen
        </button>
      </div>
      <State error={error || loadError} loading={loading} />
      {edit && (
        <form
          className="card p-5 mb-5"
          onSubmit={(e) => {
            e.preventDefault();
            void save();
          }}
        >
          <h2 className="font-semibold mb-4">Inhalt bearbeiten</h2>
          {edit.kind === "item" && (
            <label className="label mb-3">
              Item-ID
              <input
                className="input mt-1"
                required
                pattern="minecraft:[a-z0-9_]+"
                value={edit.id}
                onChange={(e) =>
                  setEdit({
                    ...edit,
                    id: e.target.value,
                    data: { ...edit.data, itemId: e.target.value },
                  })
                }
              />
            </label>
          )}
          <Fields
            value={edit.data}
            onChange={(data) => setEdit({ ...edit, data })}
          />
          <label className="flex gap-2 items-center text-sm my-4">
            <input
              type="checkbox"
              checked={edit.enabled}
              onChange={(e) => setEdit({ ...edit, enabled: e.target.checked })}
            />
            Aktiv
          </label>
          <div className="flex gap-2">
            <button className="btn btn-primary" disabled={saving}>
              {saving ? "Speichert…" : "Speichern"}
            </button>
            <button
              type="button"
              className="btn btn-secondary"
              onClick={() => setEdit(undefined)}
            >
              Abbrechen
            </button>
          </div>
        </form>
      )}
      <Table headers={["Inhalt", "Schwierigkeit", "Aktiv", "Eignung", ""]}>
        {data?.items.map((c) => (
          <tr key={c.id}>
            <Cell>
              {String(c.data.displayNameDe ?? c.data.word ?? c.data.textDe)}
              <p className="text-xs opacity-50">
                {c.kind === "item" ? c.id : ""}
              </p>
            </Cell>
            <Cell>{String(c.data.difficulty)}</Cell>
            <Cell>{c.enabled ? "Ja" : "Nein"}</Cell>
            <Cell>
              {c.kind === "item"
                ? ["bingoEligible", "itemHuntEligible", "collectorEligible"]
                    .filter((key) => c.data[key])
                    .map((key) => labels[key])
                    .join(", ")
                : "—"}
            </Cell>
            <Cell>
              <button
                className="btn btn-secondary btn-sm"
                onClick={() => {
                  setEdit(structuredClone(c));
                  setError("");
                }}
              >
                Bearbeiten
              </button>
            </Cell>
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
interface Game {
  id: string;
  icon: string;
  minPlayers: number;
  maxPlayers: number;
  usesTimer: boolean;
  usesGameScreen: boolean;
  defaults: Content["data"];
}
export function SettingsPage() {
  const {
    data: games,
    error,
    loading,
  } = useResource<Game[]>("/minigames/admin/games");
  const { data: settings, reload } = useResource<Page<Content>>(
    "/minigames/admin/content?kind=settings",
  );
  const [edit, setEdit] = useState<Game>();
  const [values, setValues] = useState<Content["data"]>({});
  const [actionError, setActionError] = useState("");
  const save = async () => {
    if (!edit) return;
    try {
      await api.put("/minigames/admin/content/" + edit.id, {
        kind: "settings",
        enabled: true,
        data: values,
      });
      setEdit(undefined);
      await reload();
    } catch (e) {
      setActionError(
        e instanceof Error ? e.message : "Speichern fehlgeschlagen",
      );
    }
  };
  return (
    <>
      <p className="text-sm mb-4" style={{ color: "var(--text-muted)" }}>
        Änderungen gelten für neu erstellte Lobbys. Laufende Spiele behalten
        ihre Konfiguration.
      </p>
      <State error={actionError || error} loading={loading} />
      {edit && (
        <form
          className="card p-5 mb-5"
          onSubmit={(e) => {
            e.preventDefault();
            void save();
          }}
        >
          <h2 className="font-semibold mb-4">{gameNames[edit.id]}</h2>
          <Fields game={edit.id} value={values} onChange={setValues} />
          <div className="flex gap-2 mt-4">
            <button className="btn btn-primary">Speichern</button>
            <button
              type="button"
              className="btn btn-secondary"
              onClick={() => setEdit(undefined)}
            >
              Abbrechen
            </button>
          </div>
        </form>
      )}
      <div className="grid md:grid-cols-2 xl:grid-cols-3 gap-4">
        {games?.map((g) => (
          <article key={g.id} className="card p-5">
            <div className="flex items-center gap-3 mb-3">
              <img
                width={32}
                height={32}
                style={{ imageRendering: "pixelated" }}
                src={"/api/assets/item/" + g.icon.replace("minecraft:", "")}
                alt=""
              />
              <h2 className="font-semibold">{gameNames[g.id]}</h2>
            </div>
            <p className="text-sm">
              {g.minPlayers}–{g.maxPlayers} Spieler ·{" "}
              {g.usesGameScreen ? "GUI-Spiel" : "Weltspiel"}
            </p>
            <button
              className="btn btn-secondary btn-sm mt-4"
              onClick={() => {
                setEdit(g);
                setValues({
                  ...g.defaults,
                  ...settings?.items.find((s) => s.id === g.id)?.data,
                });
                setActionError("");
              }}
            >
              Einstellungen bearbeiten
            </button>
          </article>
        ))}
      </div>
    </>
  );
}
