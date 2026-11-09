# Konsole, Neustart-Schleichen und Bedrock-Mehrkontenbetrieb

Controls 1.9.1 auf der unveränderten, checksum-gepinnten Engine SoulFire 2.10.7.
Keine Datenbankmigration. Keine automatischen Spielbefehle außer `/sell`.

## Nachgewiesene Fehler und Änderungen

Die native Bedrock-Erweiterung von ViaFabricPlus ist für einen einzelnen
Minecraft-Client gebaut. SoulFire betreibt mehrere Clients in einem Prozess.
Bewegungs-Timeline, Frame-/Verbindungsbesitzer, Entity-Bewegungszustände,
Eingabeberechtigungen, Korrekturen, Replay und weitere Eingabedaten lagen
bisher in statischen Feldern. Ein anderer Client konnte diese zurücksetzen
oder parallel verändern. Das direkte Pi-Log vom 9. November zeigt um 10:46:23
und 10:49:02 Uhr `ConcurrentModificationException` in
`NativeActorStates.forEachMovement`, zusätzlich zum zuvor reparierten
Timeline-Zugriffsfehler. Der eingehende RakNet-Schließgrund allein erklärt
den Auslöser der weiteren Disconnects weiterhin nicht.

1.9.1 ordnet die explizit geprüften 29 Zustandsfelder der jeweiligen
`BotConnection` zu. Transiente Metadaten gehören der Verbindung; es gibt keine
zusätzliche globale Liste, die gestoppte Clients festhält. Unveränderliche
Protokollkonstanten und globale Registrierungen bleiben unverändert. Die
Transformation prüft das Layout der eingebetteten Klassen beim Laden.
Die vorherige Synchronisierung pro Timeline bleibt bestehen.

Ein Vergleich mit zwei echten Offline-Verbindungen prüft die tatsächlich
transformierten Bibliotheksmethoden: Ohne Isolation liefert `frameId()` die
globale statt der zum Client gehörenden Timeline (erwartet 1, tatsächlich 0).
Mit Isolation bleiben beide Timelines und mutable Objekte unabhängig, und ein
Reset von Konto B setzt Konto A nicht zurück. Das belegt den Mehrkontenfehler
und dessen Korrektur; eine Behebung sämtlicher Server-Disconnects muss separat
im Livebetrieb beobachtet werden.

Manuelle Konsolenbefehle warteten bisher vor dem Senden auf zusätzliche
Konfigurations-/Inventaraktionen; identische kurz nacheinander eingegebene
Befehle wurden außerdem verworfen. Der native Sendepfad pausiert AutoSell und
schließt dessen aktuelles Menü jetzt direkt im Spielthread. Die eigentliche
Befehlszustellung braucht keine vorgeschalteten Inventar-RPCs oder persistenten
Pausen-Schreibvorgänge. Inventarspeichermeldungen halten die manuelle Queue nicht
mehr an. Wiederholte Eingaben bleiben erhalten; Queue und Senderate sind begrenzt.

HTTP bestätigt die konkrete angenommene Konsolenzeile mit derselben ID wie
WebSocket und gespeicherter Verlauf. Die Oberfläche zeigt sie sofort und folgt
nach eigener Eingabe wieder dem Konsolenende. Socket-Heartbeat, Erkennung einer
hängenden Verbindung sowie HTTP-Nachladen stellen den Verlauf wieder her.
Annahme und protokollierte Zustellung sind weiterhin von einer Serverantwort
zu unterscheiden; serverseitige Berechtigungen werden nicht umgangen.

Die Schleichbestätigung ruft die vorhandenen, nach Protokollversion begrenzten
ViaFabricPlus-Sender jetzt unmittelbar nach dem erneuten Armieren auf. Sie
wartet nicht mehr auf deren spätere Tick-Reihenfolge. Es wird kein künstliches
Loslassen erzeugt. Der echte Java-1.21.4-Testserver bestätigt Anmeldung,
Teleport, Respawn und zwei Neustarts desselben Kontos; das zweite Konto mit
ausgeschaltetem Schleichen bleibt dabei unbeeinflusst.

## Sichtweite und Wareneingang

Die bei einer früheren Leistungsänderung auf zwei Chunks reduzierte
Client-Sichtweite ist wieder sechs. Backend-Konfiguration und native Option
stimmen überein; beide Protokoll-Fixtures prüfen die tatsächlich empfangenen
Client-Einstellungen. Das nimmt eine unnötige Einschränkung des vom Client
angefragten Weltbereichs zurück. Es erzwingt keine serverseitigen Farm-Ticks.

Die direkte Inventar-/Logprüfung vor dem Update bestätigt bei drei aktiven
Java-Verkäufern regelmäßige Auszahlungen. Mehrere weitere Konten haben kein
Verkaufsinventar. Bei fehlendem Wareneingang wird kein erfolgreicher Verkauf
vorgegeben und kein Home-/Teleport-Befehl zur angeblichen Reparatur gesendet.
Der konkrete Fall „Farm läuft erst mit PC-Spieler in der Nähe“ ist damit noch
nicht als vollständig behoben bewiesen.

## Validierung vor dem Pi-Update

- Vollständiger Backend-Lauf: 532 Tests in 59 Dateien erfolgreich.
- Anschließend erweiterte Tests für HTTP-Beleg, wiederholte gleiche Zeilen,
  stabile gespeicherte IDs und Sitzungsabläufe erfolgreich.
- Backend-TypeScript, Frontend-TypeScript/Vite und Frontend-Lint erfolgreich.
- Produktive JAR ohne Test-Probes; SHA256:
  `b67a513154bc6b84eb653c902652a76828a2de081dc1bdd5b1d328c762ff4396`.
- Native AutoSell-Fixture: 36 Stacks, 1.000 Item-Entities pro Client,
  1.634 Pickups, 120 ms Bestätigungsverzögerung, maximal 16 gleichzeitige
  Transfers, Inventarsperre mit Wiederaufnahme, Lease-Auslauf und Respawn.
- Separater Test für manuelles Verkaufsmenü und Navigation während einer
  noch ausstehenden automatischen Menüantwort erfolgreich.
- Java 1.21.4: zwei Neustarts desselben Kontos, Teleport/Respawn, zwei gleiche
  manuelle Befehle, deaktiviertes Schleichen und tatsächlich angefragte
  Sichtweite sechs erfolgreich.

[Fixture-Ergebnisse](performance/stability-2026-11-09-191/) enthalten keine
Produktions-Anmeldedaten oder Microsoft-Sitzungen.

## Fortsetzung: Welt- und Inventarzustand (Controls 1.9.2)

1.9.1 wurde um 11:38–11:41 Uhr mit konsistenter Datensicherung installiert.
Backup: `/home/desmo/afk-backups/20261109-113854-before-controls191`.
Die öffentliche authentifizierte Konsole lieferte Verlauf und Heartbeat; alle
sieben beobachteten Livezeilen hatten dieselbe ID im gespeicherten Verlauf.
Die ausgelieferten JavaScript-/CSS-Dateien stimmen bytegenau mit dem geprüften
Build überein. Alle temporären Prüfsitzungen wurden entfernt.

Die Mehrkonten-Abstürze traten im anschließend untersuchten Logfenster nicht
erneut auf, aber zwei Bedrock-Konten wurden weiter getrennt. 1.9.1 ist deshalb
keine vollständige Lösung der Bedrock-Disconnects. Einmalige Anmelde-Drosselung
und „bereits auf dem Server“ werden von nachfolgenden EOF-Abbrüchen getrennt.

Weitere Prüfung zeigt: Auch `BedrockNativeBlocks.VIEW`/`UPDATES` und der
Weltbesitzer waren global. `synchronizeLevel` leert die Blockdaten beim Wechsel
auf den Client eines anderen Kontos. Das betrifft auch die Fluidzustände für
die Bewegung. Native Container-/Spielerinventarbesitzer und deren Zähler waren
ebenfalls nicht pro Verbindung getrennt.

1.9.2 erweitert die explizite Zuordnung auf 44 Felder. Der Block-Updater erhält
die eigene Blockansicht derselben Verbindung; seine Konstruktion erfolgt
außerhalb einer Map-Bin-Sperre. Ein realer Zwei-Client-Test initialisiert
unterschiedliche Blöcke an derselben Position. Ohne die neue Welt-Trennung
verliert der echte Bibliotheksaufruf `state()` den Zustand von Client A.
Mit Trennung bleiben beide Ergebnisse korrekt. Beide Tests verwenden die
vollständigen SoulFire-Kontexte einschließlich des jeweiligen Minecraft-Clients.

Produktive JAR-SHA256:
`2a160d9f3c2c27a851fcb8e973cf0eb23b106f4a13d61a3cc26baf8c69b769e6`.
Dies belegt die weiteren lokalen Fehler und deren Korrektur. Auch daraus folgt
noch kein Nachweis, dass sämtliche serverseitigen Schließungen verschwinden.

Ein zunächst fehlgeschlagener kombinierter Respawn-/Telemetrieverlust-Test
wurde separat instrumentiert: Der native Verkäufer war aktiviert, hatte kein
Fenster offen und tatsächlich keinen Bestand. Ursache war die Testserver-
Nachfüllung in bereits geschlossene Fenster nach verzögerten Bestätigungen.
Die Fixture sendet die zugesagten Nachfüllungen jetzt an das jeweils aktuelle
Fenster und synchronisiert beim Schließen sowie nach Respawn das Spielerinventar. Die Behauptung
eines Produktionsfehlers wird daraus nicht abgeleitet.

Die produktive 1.9.2-JAR besteht danach den kombinierten Test mit 36 Stacks,
120 ms Bestätigungsverzögerung, vollständig unterdrückten Inventar-Telemetrie-
Frames, Respawn, Aus-/Einschalten, Lease-Auslauf und Inventarsperre. Manueller
Verkauf/Navigation und Java-1.21.4-Neustarts bestehen ebenfalls. Es sind keine
Diagnose-Probes in der produktiven JAR enthalten.

## Konkreter Initialisierungsabbruch (Controls 1.9.3)

1.9.2 wurde um 12:05–12:07 Uhr bei weiter laufendem Backend installiert.
Backup: `/home/desmo/afk-backups/20261109-120523-before-controls192`.
Die Konten wurden wieder verbunden. Weitere EOF-Abbrüche blieben sichtbar;
1.9.2 löst deshalb ebenfalls nicht sämtliche Bedrock-Disconnects.

Um 12:07:22 Uhr erreicht `bedsirogane1124` beim Weltbeitritt die zuvor erhöhte
Paketanzahlgrenze: 65.536 Pakete bei nur 3.071.461 Nutzdatenbytes. Der
Decoder beendet daraufhin nachvollziehbar die Verbindung. Das ist ein
internes RAM-Warteschlangenlimit, kein Datenträgerfehler.

1.9.3 erhöht nur die Anzahl auf höchstens 262.144 Pakete. Die zusätzliche
Nutzdatenobergrenze von 64 MiB bleibt unverändert; auch die Zahl der
Warteschlangenobjekte bleibt somit begrenzt. Es werden weder Weltpakete
verworfen noch Initialisierungsbestätigungen vorgetäuscht. Eine Überlaufmeldung
enthält zusätzlich die tatsächliche Wartezeit in Millisekunden.

Die echte transformierte Klasse akzeptiert im Test genau 262.144 kleine
Pakete, verwirft den nächsten Versuch mit aussagekräftigem Fehler, lehnt
mehr als 64 MiB weiterhin ab und liefert beim Leeren alle 262.144 Nutzbytes
aus; anschließend ist die Warteschlange leer. Welt-/Bewegungs-Isolation und
der Minecraft-1.21.4-Neustarttest bestehen mit dem erweiterten Patch.
Produktive JAR-SHA256:
`4c899ff265a2b5aa38fd754607bf34b861d313f43c568334128963b1bc245969`.

Die Ursache einer eingehenden RakNet-Schließung ohne Minecraft-Kicknachricht
ist damit weiterhin nicht bewiesen. Zugriff auf die Minecraft-/Geyser-
Serverlogs wurde angefragt; in den zugänglichen Clientlogs ist hierfür nur
`CLOSED_BY_REMOTE_PEER` beziehungsweise EOF sichtbar.
