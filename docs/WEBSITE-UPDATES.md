# Website-Ankündigungen

Die Glocke steht neben der Version, auf kleinen Bildschirmen im Kopfbereich. Sie zeigt eine ausdrücklich veröffentlichte Ankündigung gelb und mit einer kurzen, wiederkehrenden Bewegung an. Bei reduzierter Bewegung bleibt sie gelb, ohne zu schwingen.

Beim Öffnen wird die Ankündigung für den angemeldeten Website-Nutzer als gelesen gespeichert (`User.lastSeenWebsiteUpdate`). Das gilt auch für andere Geräte. Andere Nutzer behalten ihren eigenen Status. Das Menü bleibt nach dem Lesen erreichbar. Bilder werden erst beim Öffnen geladen.

## Eine Ankündigung veröffentlichen

**Nur auf ausdrücklichen Auftrag des Betreibers:** In `backend/src/profile/updates.ts` den Inhalt aktualisieren und eine neue, eindeutige `websiteUpdate.id` vergeben. Diese Kennung aktiviert die Glocke für alle Nutzer erneut. Bei normalen Deployments, Versionsänderungen, Fehlerkorrekturen oder Textkorrekturen die Kennung **beibehalten**. Datum und Website-Version lösen selbst keine Benachrichtigung aus. Die Datenbankmarker brauchen keinen Reset.

Der Server prüft die angezeigte Kennung beim Bestätigen. Veraltete Tabs können dadurch keine neuere Ankündigung ungelesen überspringen. Die Profilrouten benötigen eine Sitzung; Schreiben erfordert zusätzlich CSRF-Schutz und bindet verspätete Browser-Anfragen an ihren ursprünglichen Nutzer.

## Prüfen

Backend: `npm test --prefix backend`. Frontend: `npm run build --prefix frontend` und `npm run lint --prefix frontend`.

Für den Browsercheck beide Pakete bauen, Vite Preview auf Port 4173 starten und `node scripts/ui/website-updates-check.mjs` ausführen. `PLAYWRIGHT_MODULE` kann auf eine vorhandene Playwright-Installation zeigen. Der Check verwendet die echte Profil-API mit einer temporären SQLite-Datenbank und eigenen Testnutzern. Es werden keine Minecraft-Verbindungen aufgebaut und keine vorhandenen Konten verändert.

Geprüft am 30.10.2026: 470 Backend-Tests erfolgreich, beide TypeScript-Builds und Frontend-Lint erfolgreich. Der Chrome-Check deckt Desktop und 320/390/768 Pixel, Nutzer- und Gerätewechsel, Tastatur/Fokus, reduzierten Bewegungsmodus, Bilder erst beim Öffnen sowie Lade-, Speicher- und veraltete Ankündigungsfehler mit Wiederholung ab.
