# Sparsamer Betrieb ohne Live-Kamera

Stand: lokal implementiert und geprüft; Einspielen auf dem Pi benötigt eine
wiederhergestellte SSH-Verbindung. Am 10. November wurde die bisherige Anmeldung
abgelehnt. Dieses Dokument behauptet keine bereits gemessene Einsparung auf dem Pi.

## Änderungen

- Live-Kamera entfernt: Website-Tab, Komponente, WebSocket-Endpunkt, Stream-Manager,
  JPEG-Kompression, Render-Pacing, Kamera-Mixins und überholter Kamera-Benchmark.
  Der frühere Website-Endpunkt liefert mit gültigem Origin HTTP 404.
  Der unveränderte SoulFire-Unterbau enthält weiterhin seine allgemeinen SDK-
  Renderfunktionen; die Anwendung ruft diese nicht auf.
- Ein gemeinsamer 100-ms-Wartungstimer ersetzt den Timer pro Account. Leerlauf
  erzeugt keine asynchronen Automatisierungsdurchläufe mehr. Manuelle Befehle
  wecken ihren Account sofort; Inventar-/Paketereignisse bleiben ereignisgesteuert.
- Ersatzweise Gesundheitsprüfungen benutzen `getBotList` ohne vollständiges
  Inventar. Gleichzeitige Leser derselben Instanz teilen eine laufende Abfrage;
  maximal zwei Instanzen werden gleichzeitig geprüft. Bei den derzeit getrennten
  Account-Instanzen entsteht dadurch nicht eine einzige Serverabfrage für alle
  Accounts. Gesunde Ereignisstreams benötigen weiterhin keine Ersatzabfrage.
- Statusdaten werden nach der Anfrage verworfen. Abbruch entfernt wartende Leser,
  beendet unbenötigte Anfragen und gibt belegte Plätze frei. Fehler-/Timeout-
  Erkennung und der unabhängige Watchdog für eingefrorene Clients bleiben bestehen.
- Standard-Client-Sichtweite von sechs auf vier Chunks reduziert; über
  `SOULFIRE_VIEW_DISTANCE` auf 2–32 konfigurierbar. Backend-Einstellungen und
  native Minecraft-Option stimmen überein. Keine Änderung von Spielticks,
  Paketquittierungen, Inventarbestätigungen oder Bewegungs-/Keepalive-Paketen.
- Nach endgültigem Entfernen einer Verbindung werden native Eingabe-/AutoSell-
  Zustände und die transienten Bedrock-Welt-/Physikdaten explizit freigegeben.
  Aktive andere Konten bleiben unberührt. Sitzungsende entfernt Scheduler,
  Befehlswarteschlangen und Inventardaten. Controller löschen auch ihren
  Eingabepuffer; Website-Sockets verwerfen ausstehende Ausgabebatches beim Schließen.
  Die langfristig benötigten Anmeldedaten, Account-Einstellungen und Logs bleiben erhalten.
- Startup-Konfiguration und Microsoft-Account-Antworten werden nach Registrierung
  aus dem langlebigen Sitzungsrahmen entfernt; keine Löschung der Login-Caches.

## Sichtweite und Simulation

Der Client kann auf einem fremden Mehrspieler-Server keine feste
Simulationsdistanz von vier erzwingen. Render-/Sendereichweite beeinflusst die
empfangenen Chunk-Daten. Die tatsächliche Simulation und Farmaktivierung hängen
von Server und Plugins ab. Vier Chunks sind deshalb zunächst die vorsichtige
Reduktion; zwei dürfen nicht ohne Farmprüfung als gleichwertig bezeichnet werden.

Der native Client protokolliert nach Weltbeitritt einmal die angeforderte
Sichtweite und seine bekannte Simulationsdistanz samt Protokoll. Dieser Wert
kann bei übersetzten älteren Protokollen synthetisch sein und ist kein Beweis
für die tatsächlichen Tickregeln des Servers.

Primärquellen: [Minecraft Java, Trennung von Simulationsdistanz](https://feedback.minecraft.net/hc/en-us/articles/4409891990285-Minecraft-Java-Edition-Snapshot-21w38a),
[Microsoft: Simulation, Renderdistanz und Ticking Areas](https://learn.microsoft.com/en-us/minecraft/creator/documents/simulationrenderdistanceguide?view=minecraft-bedrock-stable).

## Prüfung

- Vollständige Backend-Suite: 534 Tests in 61 Dateien bestanden. Anschließend
  zusätzliche Leerlauf-/Aufräumprüfung und gezielte Prüfung des finalen
  Sitzungsablaufs: 82 Tests in vier Dateien bestanden.
- Backend-TypeScript-Build, Frontend-TypeScript/Vite-Build und Frontend-Lint bestanden.
- Native Erweiterung 1.10.0 gegen den SHA-256-gepinnten SoulFire-2.10.7-Build kompiliert.
  Produktions-JAR enthält weder Kamera-Klassen noch Test-Probes.
- Native Transfer-/Recovery-/Menü-/Lease-Tests bestanden.
- Echte lokale Java-1.21.4-Verbindungen: Crouchen bei Start, Teleport, Respawn und
  zwei tatsächlichen Kontoneustarts, keine synthetische Shift-Freigabe, zweimalige
  Zustellung identischer manueller Befehle, tatsächlich gemeldete Sichtweite vier.
- Bedrock-Zustandsprobe mit zwei Offline-Verbindungen: 44 Felder, 19 unabhängige
  veränderliche Objekte; Freigeben eines Clients erzeugt danach frischen Zustand
  und erhält den Zustand des anderen Clients.
- Rohresultate ohne Produktions-Anmeldedaten: `performance/lightweight-2026-11-10/`.

Bei früheren langen Läufen blieb der Wiederanlauf nach künstlichem Lease-Ablauf
zweimal stehen; andere instrumentierte Läufe bestanden. Die genaue Ursache dieser
Hänger ist nicht isoliert bewiesen. Der abschließende Lauf mit dem unveränderten
Produktions-JAR bestand: 36 Stacks, 120-ms-Bestätigungen, Respawn, entfernte
Inventarereignisse, 365 Inventar-Sperrmeldungen, Konfigurationsänderungen,
Lease-Ablauf/-Erneuerung, Navigation während einer Menüöffnung, manuelles
Verkaufsmenü, weitere manuelle Befehle und unabhängiger Account-Stopp.
444 bestätigte Klicks; keine Inventar-Icon- oder POV-Render-RPCs. Das ist ein lokaler
Funktionsnachweis, keine Garantie für die Langzeitstabilität des Produktivservers.

## Betrieb

Keine neuen Client-Prozesse, keine JVM-Heap-Verkleinerung, kein SSD-Umzug und keine
OS-Aktualisierung. Automatische Minecraft-Befehle bleiben auf `/sell` beschränkt;
ausdrücklich vom Nutzer ausgelöste Werkzeuge/Befehle bleiben verfügbar.

Vor Einspielen: Account-Startauswahl erfassen, Daten-/Quell-/Image-Backups erstellen,
neue Images vorbauen und erst danach Backend/SoulFire für den Austausch stoppen.
Nachher: Dienste, Startauswahl, Konsole, Verkaufseingänge, Speicherdruck und
Bedrock-Verbindungen prüfen. Ohne diese Live-Prüfung ist eine Verbesserung von
Pi-RAM/CPU oder der Farmaktivierung nicht nachgewiesen.
