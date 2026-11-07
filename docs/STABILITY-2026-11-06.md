# Kurze Website-Ausfälle, Reconnects und große Itemmengen

Nachfolgende Korrekturen, aktuelle Freigabezeiten und Prüfungen stehen in
[Stabilität vom 7. November](STABILITY-2026-11-07.md).

## Einordnung der gemeldeten Logs

Beim ersten Account folgen auf `Authenticated as` genau fünf Minuten ohne
bestätigten Weltbeitritt. Danach greift der Start-Watchdog. Die Authentifizierung
allein bestätigt keine Minecraft-Verbindung. Die früheren `deadline_exceeded`
zeigen Zeitüberschreitungen der Steueranfragen; aus diesem Ausschnitt geht
nicht hervor, warum der gemeinsame Dienst nicht rechtzeitig antwortete.

Beim zweiten Account meldet der Minecraft-Proxy den Verlust des Spielservers.
Der vorhandene Fallback-Handler startet gemäß Auto-Reconnect-Einstellung eine
neue Verbindung. `Spawned into the world` bestätigt deren Erfolg. Der Ausschnitt
belegt keinen dauerhaft fehlgeschlagenen Reconnect dieses Accounts.

### Ein Account bleibt nach „Authenticated as“ stehen

Diese Zeile wird vor Client-Konfiguration und Startauftrag ausgegeben. Sie
unterscheidet daher keinen blockierten Startplatz, eine hängende
Client-Initialisierung oder einen ausbleibenden Serverlogin. Zusätzliche
Accountmeldungen zeigen jetzt Vorbereitung, Startauftrag und die beobachteten
Phasen QUEUED/STARTING/RUNNING an. RUNNING allein ist ebenfalls kein Weltbeitritt:
SoulFire kann bereits den Client gestartet haben, ohne dass ein Spieler geladen ist.

Während der betroffene Account hängt, im Projektverzeichnis auf dem Zielhost
ausführen (Accountname oder Website-Account-ID als letztes Argument):

```bash
docker compose exec -T backend node --input-type=module - frustrieren < backend/scripts/diagnose-world-entry.mjs
```

Das Skript kann über stdin auch im bisherigen Backend-Image laufen. Es liest
nur den gewählten Account und fragt zwei getrennte Zustände mit je fünf
Sekunden RPC-Frist ab: einen Status-Snapshot unabhängig vom Spielthread sowie
den tatsächlichen Spielzustand. So bleiben QUEUED/STARTING/RUNNING sichtbar,
auch wenn die Spielzustandsabfrage hängen bleibt. `playerPresent: true`
bestätigt einen vorhandenen Spieler; `false` bestätigt keinen Weltbeitritt.
Die Ausgabe enthält Zieladresse, Edition, Version, Instanz-/Bot-ID und die
Abfrageergebnisse. Anmeldedaten, Inventarinhalte und vollständige Konfigurationen
werden nicht ausgegeben. Es werden keine Accounts gestartet, gestoppt,
aktualisiert oder neu angemeldet. Ohne diese Ausgabe bzw. die zugehörigen
SoulFire-Logs ist die Ursache eines konkreten Hängers nicht belegt.

Ein Browser-, Proxy-, Backend- oder Host-Ausfall lässt sich aus diesen
Accountlogs nicht unterscheiden. Dafür auf dem betroffenen Host die Uhrzeit,
den sichtbaren Website-Fehler und die Ausgabe von
`bash scripts/diagnose-disconnects.sh 2h` sichern. Die Diagnose zu bereits
beobachteten Host-/RPC-Ausfällen steht in [DISCONNECTS-2026-11-04.md](DISCONNECTS-2026-11-04.md).

## Änderungen

- Die unabhängige Statusabfrage bestätigt jetzt auch den ersten Weltbeitritt,
  wenn die initiale Snapshot-/Spawn-Meldung im Ereignisstream fehlt. Ein bereits
  wieder gestoppter Bot wird auch während des Verbindungsaufbaus erkannt.
  Ein verspäteter initialer STOPPED-Streamframe löst dabei keinen Fehlalarm aus.
- Die Fünf-Minuten-Timeouts schreiben ihren Grund jetzt ausdrücklich in die
  Accountkonsole, einschließlich des Falls „angemeldet, aber kein Weltbeitritt“.
- Die alle fünf Sekunden erneuerte AutoSell-Freigabe bleibt flüchtig in der
  SoulFire-JVM. Der bisherige
  [UpdateBotConfigEntry-Pfad](https://github.com/soulfiremc-com/SoulFire/blob/2.10.6/mod/src/main/java/com/soulfiremc/server/grpc/BotServiceImpl.java)
  schreibt die Instanzkonfiguration in einer Datenbanktransaktion und lädt
  anschließend den Konfigurationscache neu. Der neue Sonderpfad für diese
  Freigabe prüft weiterhin die Instanzberechtigung und den Account, verwendet
  aber keine Datenbanktransaktion. Gewöhnliche Einstellungen bleiben persistent.
  Die Freigabe läuft nach spätestens 15 Sekunden aus; alte gespeicherte Werte
  gelten nicht als Freigabe nach einem JVM-Neustart.
- Native AutoSell verschiebt höchstens acht Stacks pro Spieltick. Der nächste
  Tick setzt am nächsten Slot fort. Sofort nachgefüllte Slots führen so nicht
  zu einer endlosen Schleife oder einem Paketburst über das ganze Inventar.
- Der Kollisionscache hält nur die Mitgliedschaft der Nicht-Item-Entities fest.
  Neue/entfernte Nicht-Items invalidieren ihn; reine Item-Pickups/-Drops und der
  nächste Tick erfordern keinen erneuten Scan aller herumliegenden Items.
  Positionen, Kollisionsbedingungen und entfernte Entities werden weiterhin bei
  jeder Abfrage geprüft. Serverseitige Pickups und Inventarpakete bleiben aktiv.

Die reduzierte Datenbank- und Spielthreadlast behebt konkrete unnötige Arbeit.
Sie beweist nicht, dass diese Last den gemeldeten Website-Ausfall verursacht hat.

## Prüfen und einspielen

Backend bauen und testen:

```bash
cd backend
npm run build
npm test
```

Die Erweiterung mit `soulfire/build-plugin.py` gegen das checksumgeprüfte
SoulFire-2.10.6-JAR bauen. Die Freigabe lässt sich ohne Spielserver mit Java 25+
und einem temporären Klassenverzeichnis prüfen:

```bash
javac --release 25 -d /tmp/afk-lease-tests \
  soulfire/plugin/src/de/afkservice/SellLease.java \
  soulfire/test/de/afkservice/SellLeaseTest.java
java -ea -cp /tmp/afk-lease-tests de.afkservice.SellLeaseTest
```

`backend/scripts/audit-sell-lease.mjs` prüft gegen einen ausdrücklich ausgewählten
isolierten SoulFire-Dienst, dass 20 Freigabeerneuerungen keine gespeicherten
Account-Einstellungen ändern und unbekannte Accounts/Instanzen sowie ungültige
Werte abgelehnt werden. Es nutzt einen temporären Offline-Account und entfernt
die Testinstanz anschließend.

Der native Belastungstest verwendet zwei temporäre Offline-Accounts, jeweils
10.000 Items und fortlaufende Pickups. Ein Account verkauft volle Inventare bei
eingestelltem 0,5-Sekunden-Intervall und hält Rechtsklick/Crouch; der andere hält
Mining. Ein Ereignisstream wird absichtlich unterbrochen. Im abschließenden
90-Sekunden-Testabschnitt blieben beide verbunden. Insgesamt erfasste die
Fixture 4.199 Pickups und 6.552 bestätigte Inventarklicks. Die ersten 20 gemessenen
Verkaufsabstände lagen bei 501–570 ms; diese Stichprobe liegt vor dem zusätzlichen
90-Sekunden-Abschnitt. Ergebnisse siehe
[performance/stability-2026-11-06](performance/stability-2026-11-06).
Das ist ein lokaler Kurztest, kein Nachweis für mehrstündige Stabilität auf dem
betroffenen Produktionshost oder für dessen Bedrock-/Proxy-Verbindung.
Der Backend-Testlauf der Stabilitätsänderungen bestand alle 494 Tests in 51
Testdateien; Backend-Build, Java-25-Erweiterungsbuild und Freigabeprüfungen
bestanden ebenfalls. Für die ergänzte Weltbeitritt-Diagnose und die
Startphasenmeldungen bestehen 99 gezielte Tests einschließlich vier
Diagnosefällen und der bestehenden Reconnect-/Supervisor-Tests.
Vor dem Push einschließlich der Pi-Update-Anpassungen besteht der gesamte
Backend-Testlauf alle 500 Tests in 52 Testdateien.

Auf dem Zielhost müssen **Backend und SoulFire-Erweiterung** aktualisiert werden:

```bash
bash scripts/update.sh
```

Das Skript baut vor dem Austausch der Container. Beim Einspielen werden die
geänderten Dienste neu gestartet; laufende Accounts werden dabei einmalig
unterbrochen. Die Datenvolumes bleiben erhalten. Nur ein Backend-Neustart reicht
für die Änderungen an AutoSell und am Kollisionscache nicht aus.
