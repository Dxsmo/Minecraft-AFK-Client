import { useEffect, useState } from "react";
import { api } from "../lib/api";
import { AUTO_DETECT_VERSION, MINECRAFT_VERSIONS } from "../lib/minecraftVersions";

export function MinecraftVersionSelect({ edition, value, onChange, disabled = false, recommended = false }: {
  edition: "JAVA" | "BEDROCK";
  value: string;
  onChange: (value: string) => void;
  disabled?: boolean;
  recommended?: boolean;
}) {
  const [bedrockVersions, setBedrockVersions] = useState<string[] | null>(null);
  const [error, setError] = useState(false);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    if (edition !== "BEDROCK") return;
    const controller = new AbortController();
    let cancelled = false;
    setBedrockVersions(null);
    setError(false);
    void api.get<{ bedrock: { versions: string[] } }>("/minecraft/versions", { signal: controller.signal })
      .then(catalog => { if (!cancelled) setBedrockVersions(catalog.bedrock.versions); })
      .catch(() => { if (!cancelled) setError(true); });
    return () => { cancelled = true; controller.abort(); };
  }, [edition, attempt]);

  const versions = edition === "BEDROCK" ? bedrockVersions ?? [] : MINECRAFT_VERSIONS;
  const loading = edition === "BEDROCK" && bedrockVersions === null && !error;

  return <>
    <select
      aria-label="Minecraft version"
      value={value}
      disabled={disabled || loading}
      onChange={event => onChange(event.target.value)}
      className="input"
    >
      <option value={AUTO_DETECT_VERSION}>{loading ? "Bedrock-Versionen werden geladen…" : recommended ? "Auto-detect (recommended)" : "Auto-detect"}</option>
      {value && !versions.includes(value) && <option value={value} disabled>
        {value}{loading ? "" : " (nicht unterstützt)"}
      </option>}
      {versions.map(version => <option key={version} value={version}>{version}</option>)}
    </select>
    {edition === "BEDROCK" && error && <p role="alert" className="mt-1 text-xs">
      Bedrock-Versionsliste konnte nicht geladen werden.{" "}
      <button type="button" className="underline" onClick={() => setAttempt(value => value + 1)}>Erneut laden</button>
    </p>}
  </>;
}
