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
