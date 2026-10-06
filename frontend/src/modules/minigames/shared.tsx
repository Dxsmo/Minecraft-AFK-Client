export function State({ error, loading }: { error: string; loading: boolean }) {
  return error ? (
    <p role="alert" className="alert-error mb-4">
      {error}
    </p>
  ) : loading ? (
    <p className="text-sm py-4" role="status">
      Daten werden geladen…
    </p>
  ) : null;
}
export function Table({
  headers,
  children,
}: {
  headers: string[];
  children: React.ReactNode;
}) {
  return (
    <div className="card overflow-x-auto">
      <table className="w-full text-sm text-left">
        <thead className="text-xs" style={{ color: "var(--text-muted)" }}>
          <tr>
            {headers.map((h) => (
              <th key={h} className="px-4 py-3 whitespace-nowrap border-b">
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>{children}</tbody>
      </table>
    </div>
  );
}
export function Cell({ children }: { children: React.ReactNode }) {
  return <td className="px-4 py-3 border-b whitespace-nowrap">{children}</td>;
}
export function Pagination({
  offset,
  total,
  onChange,
}: {
  offset: number;
  total: number;
  onChange: (v: number) => void;
}) {
  return (
    <div className="mt-4 flex items-center gap-3 text-sm">
      <button
        className="btn btn-secondary btn-sm"
        disabled={offset === 0}
        onClick={() => onChange(Math.max(0, offset - 50))}
      >
        Zurück
      </button>
      <span>
        {total === 0
          ? "Keine Einträge"
          : `${offset + 1}–${Math.min(total, offset + 50)} von ${total}`}
      </span>
      <button
        className="btn btn-secondary btn-sm"
        disabled={offset + 50 >= total}
        onClick={() => onChange(offset + 50)}
      >
        Weiter
      </button>
    </div>
  );
}
export function Status({ value }: { value: string }) {
  return <span className="stat-pill">{value}</span>;
}
export function Json({ value }: { value: unknown }) {
  return (
    <pre className="console-output text-xs whitespace-pre-wrap break-all">
      {JSON.stringify(value, null, 2)}
    </pre>
  );
}
