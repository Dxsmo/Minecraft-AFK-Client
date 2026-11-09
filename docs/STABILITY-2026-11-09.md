# Schleichzustand, Bedrock-Absturz und Entfernung der Home-Rückkehr

Controls 1.9.0; Engine/SDK unverändert auf dem geprüften SoulFire 2.10.7.
Der SSD-Umzug bleibt auf ausdrücklichen Wunsch zurückgestellt.

## Automatische Spielbefehle

Home-Rückkehr, Ziel-Erinnerung, Import alter Home-Logs, Laufzeit-Gate, API-Feld,
Datenbankspalte und Einstellung wurden entfernt. Alte Cache-Dateien werden nicht
mehr gelesen. Vor dem Update wurden die Konfigurationen aller 31 Konten
über die normale authentifizierte Website-API auf Home-Rückkehr aus und `/sell`
gesetzt; temporäre Prüfsitzung anschließend gelöscht.

AutoSell sendet in nativer Erweiterung und beiden Verhaltensimplementierungen
fest `/sell`. Die API lehnt andere automatische Befehle ab; die Oberfläche bietet
keinen frei wählbaren AutoSell-Befehl mehr an. Explizit angeforderte manuelle
Befehle bleiben verfügbar. `/desmo` fragt `/sellmulti` ausschließlich auf manuelle
Anforderung ab. Reconnects wiederholen keine manuellen Befehle.

## Schleichen

Der bisherige Check setzte Minecrafts Eingabe auf Shift und sendete erneut ein
`ServerboundPlayerInputPacket`. ViaFabricPlus überträgt für ältere Java-Server
Schleichen jedoch separat als `START_SNEAKING`, abhängig von einem eigenen Cache.
Der Pakettest mit Controls 1.8.4 bestätigt: Nach dem Server-Teleport fehlt die neue
Schleichbestätigung, obwohl die lokale Shift-Eingabe gesetzt bleibt.

1.9.0 armiert diesen Cache auf demselben Spielthread erneut. Tatsächliche Eingabe
und Netzwerk werden dabei nie auf nicht-schleichend gesetzt. Spieler-/Weltwechsel,
Positionssprünge, explizite Checks und ein begrenzter Fünfsekunden-Refresh lösen
die Bestätigung aus. Moderne Eingabepakete bleiben erhalten. Die Cache-Anpassung
prüft das Layout der checksum-gepinnten ViaFabricPlus-Version beim Start.
Backend-Checks werden außerdem nicht mehr durch eine Inventarspeichersperre
unterdrückt.

Der reale Offline-Testserver bestätigt frisches `START_SNEAKING` nach Teleport,
Respawn und stillem serverseitigem Zustandsverlust; kein `STOP_SNEAKING` während
aktivierter Einstellung. Das zweite Konto mit ausgeschaltetem Schleichen sendet
kein `START_SNEAKING`.

## Bedrock

Im direkten Pi-Log vom 9. November um 07:06:30 Uhr wurde ein weiterer konkreter
Absturz sichtbar: `ConcurrentModificationException` beim Iterieren der
`MovementEffectTimeline.history` in `pendingPhysicalFrame`. Der Spielthread liest
parallel zu Änderungen der Bedrock-Verarbeitung; der Fehler beendet den Tick-Loop.

Ein Test mit der unveränderten eingebetteten Bibliothek reproduziert denselben
Fehler. 1.9.0 synchronisiert alle öffentlichen Zugriffe auf dieselbe Timeline,
inklusive Reset, mit einem Monitor pro Instanz. Die JVM gibt ihn auch bei
Ausnahmen frei. Es werden nur vorhandene Bewegungsdaten verarbeitet; keine
Netzwerkwarteoperation wird unter dem Monitor eingeführt. Ein realer Fabric-Test
mit 100.000 Schreibdurchläufen und 2.000 parallelen Leseoperationen läuft ohne
Ausnahme durch.

Das behebt diesen nachgewiesenen lokalen Absturz. Wiederholte RakNet-
`CLOSED_BY_REMOTE_PEER`-Abbrüche sind damit noch nicht als gelöst belegt. Der
Transportgrund allein erklärt nicht, weshalb die Gegenstelle schließt.

## Prüfung

- Backend: 531 Tests in 59 Dateien erfolgreich; TypeScript-Build erfolgreich.
- Frontend: TypeScript-/Vite-Produktionsbuild erfolgreich.
- Reale Minecraft-/Fabric-Tests: Schleichpakete nach Teleport/Respawn/stillem Reset,
  deaktiviertes Schleichen, kein künstliches Loslassen, AutoSell mit 36 Stacks,
  verzögerte Bestätigungen, 1.000 Item-Entities pro Client, laufende Pickups,
  365 Inventarsperrmeldungen, Lease-Auslauf, manueller Befehl und unabhängiger Stop.
- Die Lease-Prüfung unterbindet Erneuerungen am tatsächlichen RPC-Transport;
  voneinander unabhängig erzeugte Controller-Clients werden damit erfasst.

[Messdaten](performance/stability-2026-11-09/) enthalten ausschließlich isolierte
Fixture-Ergebnisse; keine Microsoft-Daten oder Produktionssitzungen.

## Pi-Update und Live-Prüfung

Am 9. November wurde 1.9.0 mit Backup der gesamten veränderlichen Backend-Daten
und des SoulFire-Kernzustands eingespielt. Sicherung:
`/home/desmo/afk-backups/20261109-072823-before-controls190`.
Die Datenbankmigration wurde erfolgreich angewendet. Backend, SoulFire und
Website wurden gesund gestartet; die öffentliche Health-API liefert HTTP 200.
Native JAR-SHA256:
`02642230abe8bb0781019c86d92c2ef895bd65cdbeec3a6d54a7203846fdd61b`.

Die warme RPC-/Weltprüfung um 07:39 Uhr bestätigt alle 13 gewünschten Konten
laufend, mit vorhandenem Spieler und `pose: crouching`, darunter alle drei
Bedrock-Konten. Das bestätigt den aktuellen lokalen Zustand; die Prüfung der
Schleichpakete nach Zustandsverlust erfolgt zusätzlich mit dem Offline-Server.
Die bestehende Start-/Stop-Auswahl der Konten wurde beibehalten.

Die authentifizierte Prüfung über `https://desmo.club` liefert alle 31 Konten,
keine Home-Einstellung und ausschließlich `/sell` als AutoSell-Befehl.
Ein Änderungsversuch auf `/home must-not-run` wird mit HTTP 400 verworfen.
Der tatsächlich ausgelieferte Einstellungs-Build enthält die neue `/sell`-Anzeige
und kein Home-Feld mehr. Alle temporären Prüfsitzungen wurden wieder entfernt.

Nach dem Update wurden bis 07:38 Uhr unter anderem 124, 89 und 70
Verkaufsbestätigungen der drei Konten mit laufendem Wareneingang protokolliert.
Für die übrigen aktivierten Verkäufer lässt das allein keine Aussage über
vorhandenen Wareneingang zu. Es wurde keine automatische Home-Anforderung
protokolliert.

**Die Bedrock-Disconnects sind weiterhin nicht vollständig behoben.** In der
anschließenden Messung wurden zusätzliche eingehende RakNet-`0x15`-
Schließnachrichten beobachtet. Zwei vollständig erfasste Beispiele bestätigen
noch 77 bzw. 188 ms vorher Server-ACKs; die gesendeten Datagramm-Sequenzen weisen
im Mitschnitt keine Lücken auf. Verbundene Pings wurden beantwortet.
Das belegt aktive Kommunikation unmittelbar vor der Schließung, erklärt aber
nicht den Auslöser. Ein Fehler der vom Client gesendeten Protokolldaten bleibt
möglich. Es ist daher keine belastbare Schuldzuweisung an den Server.

Der zuvor nachgewiesene Timeline-Absturz trat im anschließenden beobachteten
Logfenster nicht erneut auf; das ersetzt keinen Langzeittest. Für den übrigen
Kickgrund wurde nach vorhandenen Minecraft-/Geyser-Serverlogs gefragt. Während
der Diagnose wurden keine Spielbefehle außer regulärem AutoSell ausgeführt.
Die Netzwerkprüfung speicherte nur Zähler, Sequenznummern und Zeitabstände;
keine Anmelde- oder Minecraft-Paketinhalte wurden in die Messdaten übernommen.
