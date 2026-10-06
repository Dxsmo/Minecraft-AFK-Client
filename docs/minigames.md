# Minecraft SMP Minigames

Die neue Domain befindet sich unter `backend/src/minigames`, `backend/test/minigames` und `frontend/src/modules/minigames`. Sie verwendet bestehendes Fastify, Prisma/SQLite, Website-Sessions, ADMIN-Autorisierung und CSRF. Die Navigation steht direkt unter Name Sniper.

Migration: `backend/prisma/migrations/20261006190000_add_minigame_platform/migration.sql` (neun additive Tabellen). Keine neuen geheimen Environment-Variablen. Backend wie bisher: `npm ci`, `npm run prisma:generate`, `npm run prisma:migrate`, `npm run build`, `npm start` aus `backend/`. Website: `npm ci` und `npm run build`/`npm run dev` aus `frontend/`.

Die Fabric-Mod und vollständige Plattformdokumentation liegen im benachbarten Projekt [GHGames](../../GHGames/README.md). Dort sind Setup, Architektur, Protokoll, Game Registry, Admin/Content, Testberichte und die verbleibende reale Ingame-Abnahme dokumentiert. Installierbare JARs: `../../GHGames/dist/`. Ab Mod 1.0.1 ist die Dienstadresse fest in der Mod hinterlegt; Spieler geben weder Website-Adresse noch Netzwerknamen ein. Der Betreiber verwendet dafür den öffentlichen HTTPS-Origin mit dem Suffix `/ghgames`.

Automatisierte Tests: `npm test` im Backend. Vollständige Ingame-Abnahme, echte SMP-Regression und Behebung bestehender Dependency-Advisories sind vor einer Produktionsfreigabe noch erforderlich.


## Spieler-Gateway

`frontend/Caddyfile` enthält ab Mod 1.0.1 einen isolierten `/ghgames`-Gateway. Er leitet ausschließlich Health, Challenge/Session, Content, Photo-Uploads/Downloads und `/ws/minigames` an das bestehende Backend weiter. Website-Seiten, Website-Login und Minigame-Admin-Endpunkte liefern innerhalb dieses Gateways 404. Die bestehende Website und ihre ursprünglichen `/api`-/`/ws`-Routen funktionieren weiterhin unverändert. Backend-Authentifizierung und Admin-Autorisierung bleiben erforderlich.

Nach dem Pull: `docker compose build web` und `docker compose up -d`. Es gibt keine zusätzliche Migration, keine neuen Secrets und keine neuen Docker-Ports. Die tatsächliche Produktionsadresse wird nur vom Distributor in der Mod-Ressource gepflegt; die Adresse selbst ist öffentlich und kein Authentifizierungsnachweis.

Proxy-Verifikation mit lokalem echten Caddy: `CADDY_BIN=/pfad/zu/caddy node scripts/minigame-gateway-check.mjs`. Das Script startet isolierte Fixture-Server und prüft API-Präfixe, Header-Weitergabe, beide WebSocket-Upgrades, Website-Routen und das Sperren von Website/Admin im Spieler-Gateway. Es verändert keine Produktionsdaten.

Die verschachtelten, exklusiven Routing-Blöcke und das Entfernen des Pfadpräfixes folgen der [Caddy-handle-Dokumentation](https://caddyserver.com/docs/caddyfile/directives/handle) und der [uri-Dokumentation](https://caddyserver.com/docs/caddyfile/directives/uri).
