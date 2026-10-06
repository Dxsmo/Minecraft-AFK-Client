# Minecraft SMP Minigames

Die neue Domain befindet sich unter `backend/src/minigames`, `backend/test/minigames` und `frontend/src/modules/minigames`. Sie verwendet bestehendes Fastify, Prisma/SQLite, Website-Sessions, ADMIN-Autorisierung und CSRF. Die Navigation steht direkt unter Name Sniper.

Migration: `backend/prisma/migrations/20261006190000_add_minigame_platform/migration.sql` (neun additive Tabellen). Keine neuen geheimen Environment-Variablen. Backend wie bisher: `npm ci`, `npm run prisma:generate`, `npm run prisma:migrate`, `npm run build`, `npm start` aus `backend/`. Website: `npm ci` und `npm run build`/`npm run dev` aus `frontend/`.

Die Fabric-Mod und vollständige Plattformdokumentation liegen im benachbarten Projekt [GHGames](../../GHGames/README.md). Dort sind Setup, Architektur, Protokoll, Game Registry, Admin/Content, Testberichte und die verbleibende reale Ingame-Abnahme dokumentiert. Installierbare JARs: `../../GHGames/dist/`. Client-Endpunkt im Minecraft-Einstellungsscreen auf den eigenen HTTPS-Origin setzen.

Automatisierte Tests: `npm test` im Backend. Vollständige Ingame-Abnahme, echte SMP-Regression und Behebung bestehender Dependency-Advisories sind vor einer Produktionsfreigabe noch erforderlich.
