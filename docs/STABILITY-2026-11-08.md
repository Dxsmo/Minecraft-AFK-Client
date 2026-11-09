# Erneute Account-Prüfung und Menü-/Reconnect-Korrektur

Controls-Version 1.8.4, SoulFire und SDK checksum-/versionsgepinnt auf 2.10.7.

## Aktueller produktiver Befund

Am 8. November wurden über die authentifizierte Website-API alle 31 sichtbaren
Accounts und 544.119 aufbewahrte Logzeilen ausgelesen. Die Rohdaten, Sitzungsdaten
und einzelnen Account-Berichte liegen privat außerhalb des Repositories.

Im Zeitfenster nach dem vorherigen Update enthalten die aufbewahrten Logs zehn
Bedrock-Decoderfehler für `clientbound/minecraft:set_entity_data`, 18 Meldungen
`End of stream`, drei `RakMagic does not match` und eine Meldung
`Invalid encrypted packet`. Hinzu kommen Servertransfers, Fallback-Meldungen
und Inventarsperren. Die Aufbewahrungsgrenze von 20.000 Zeilen je Account
verhindert eine vollständige historische Fehlerzählung.

Bei der Stichprobe waren 13 Accounts online. Mehrere aktivierte Verkäufer
bestätigten aktuelle Auszahlungen; in der Historie gibt es zugleich mehrstündige
Auszahlungslücken. Eine Lücke allein beweist ohne Inventar-/Menüzustand keinen
Automatisierungsfehler. Die Website meldete eine Last von 5,3 bei vier Kernen.
Ihr einfacher freier RAM-Wert ersetzt weder `MemAvailable` noch eine Heap-/GC-
Untersuchung.

Nach Bereitstellung der SSH-Masterverbindung wurden direkt auf dem Pi die
Docker-/Spiel-Logs, alle 13 aktiven Profile, Heap-Histogramm, GC-Protokoll und
eine 30-Sekunden-JFR untersucht. Alle 13 waren in der Anfangsprobe online;
fünf Verkäufer hatten aktuelle Auszahlungen, zwei weitere aktivierte Verkäufer
ein leeres Inventar. VNC lieferte keinen zusätzlich erreichbaren Sitzungsinhalt.
Die vollständigen privaten Rohdaten wurden außerhalb des Repositories gesichert.

Die JVM belegte etwa 5,5 GiB residenten RAM bei 4 GiB maximalem Heap und
weitgehend belegtem 2-GiB-Swap. Eine 30-Sekunden-Probe maß 294,5 % CPU und
nur etwa 0,7 GiB verfügbaren RAM. Das Histogramm zeigte keinen erneuten
Emote-Callback-Leak; große Bedrock-Modellbestände und hohe temporäre Allokation
waren dagegen sichtbar. Das Profil zeigte neben Bedrock-Lichtberechnungen
viele zufällige Blockabfragen für rein visuelle Umgebungsanimationen.

## Clientlast und Protokoll-Update

`ClientLevel.animateTick` führt pro Bot-Spiel-Tick 1.334 Blockprüfungen für
Partikel und Umgebungsgeräusche aus. `HeadlessAmbientMixin` überspringt nur
diese Darstellung im Bot-Kontext. Normale Spiel-Ticks, Netzwerkupdates,
Inventar- und Eingabeverarbeitung bleiben bestehen. Eine zusätzliche Mixin-Probe
im echten Linux-Client misst bei 20 Aufrufen vorher 26.680, nachher null
`doAnimateTick`-Aufrufe. Die Test-JARs werden nicht produktiv installiert.

SoulFire 2.10.7 aktualisiert unter anderem StackAnvil auf 0.4.4 und ViaFabricPlus.
Der Release-Hash wird vor dem Build geprüft. Da das Release einfache
Bedrock-Adressen neu als NetherNet interpretiert, erhält `BedrockTransportMixin`
die vorhandene RakNet-Semantik für `host:port`. Explizite `nethernet://`-Adressen
behalten die neue Engine-Verarbeitung. Die Laufzeitprobe prüft Hostname,
IPv4, IPv6, explizites NetherNet und unveränderte Java-Portauswahl; siehe
[Laufzeitmessung](performance/stability-2026-11-08/runtime-probe-2.10.7.json).

Die bisherigen Dienst-Logs enthielten selbst für `set_entity_data` keine
vollständige Decoder-Ursache. `ConnectionDiagnosticsMixin` protokolliert nun
den Throwable-Stack ohne Paketinhalt, höchstens einmal je Verbindung und
30 Sekunden. Ein Engine-Update allein beweist keine Korrektur aller historischen
Decoderfehler.

## Dauerhaft offenes Verkaufsmenü

Die native Menüzuordnung verfiel nach 15 Sekunden. Kam die Antwort erst während
einer längeren Lade-/Neustartpause, blieb das Menü anschließend ohne Zuordnung
offen. Die weitere Automatik behandelte es unbegrenzt als fremdes Menü.

`SellMenuRequests` verfolgt eigene offene Anfragen jetzt unabhängig von der
endlichen Transfer-/Wiederholungsfrist. Verspätete Antworten werden geschlossen,
wenn ihr Verkaufsdurchlauf bereits aufgegeben wurde. Die begrenzte Zählung
berücksichtigt auch mehrere durch Wiederholungen ausstehende Antworten.

Außerdem sind Verkaufsunterbrechung und manuelle Menüzuordnung getrennt:
`/home` oder `/tpahere` pausieren Verkäufe weiterhin, machen eine verspätete
native Antwort aber nicht zu einem manuellen Menü. Ein ausdrücklich manuell
gesendeter Verkaufsbefehl verwirft vorherige native Menüansprüche vor dem
Senden. Sein Menü bleibt geschützt, auch nach Ablauf der kurzen Befehlspause.
Die normalen Bestätigungsfenster, Lease und Verkaufsintervalle bleiben aktiv.

## Alte Sitzung darf die nächste Verbindung nicht stoppen

Der alte Controller kann seine asynchrone Bereinigung noch ausführen, nachdem
der Supervisor bereits einen Ersatzcontroller erzeugt hat. Sowohl dessen
`finally` als auch der zusätzliche Supervisor-Stopp setzen dieselbe entfernte
Profil-ID auf STOPPED. Ohne Reihenfolge können sie damit den Ersatz stoppen.

Die Sitzung und der explizite Stopp werden jetzt pro Account-Cacheverzeichnis
serialisiert. Die nächste Sitzung startet erst nach beiden Vorgängern.
Abgebrochene wartende Versuche werden entfernt; andere Accounts warten nicht
mit. Das schließt diesen reproduzierten Wettlauf. Eine Zuordnung dieses Wettlaufs zu bestimmten
produktiven Disconnects wird nicht behauptet.

## Prüfung

- 527 Backend-Tests in 58 Dateien bestanden; Backend und native Erweiterung
  gegen das gepinnte Release kompiliert.
- Java-Prüfungen für Menüzuordnung, manuelle Ansprüche, begrenzte Anfragen,
  Fehlerpausen und Transferbestätigungen bestanden.
- Zwei echte Clients in einer getrennten Linux-/Java-25-SoulFire-Instanz:
  erster Menü-Reply um 20 Sekunden verzögert und währenddessen Verkaufspause.
  Der bisherige Code bleibt ohne Transfers hängen, obwohl beide Clients
  verbunden sind. Mit Korrektur: 204 Transfers, anschließend Abstände von
  2003–2043 ms bei eingestellten zwei Sekunden. Ein manuelles Verkaufsmenü
  bleibt während einer sechs Sekunden langen Prüfung unangetastet; nach
  dessen Schließen verkauft der Client weiter. Siehe
  [Gegenversuch](performance/stability-2026-11-08/late-menu-negative-control.json)
  und [Korrektur](performance/stability-2026-11-08/late-menu-fixed.json).
- Zweiter Gegenversuch: Antwort nach vier Sekunden während eines `/home`-
  Befehls. Der alte Code bleibt erneut ohne Transfers hängen. Mit der fertigen
  Erweiterung 1.7.2 laufen Menüerholung, echtes manuelles Verkaufsmenü,
  Inventarsperre und anschließende Verkaufsfortsetzung durch. Dabei: zwei
  Clients, je 10.000 Item-Entities, 36 nachgefüllte Stacks, 120 ms verzögerte
  Bestätigungen, 2.635 Pickups, 323 Stream-Resynchronisationen und ein
  absichtlicher Stream-Abbruch. Höchstens 16 Transfers sind unbestätigt; die
  während der Sperre bereits gesendeten 16 Klicks werden abgewiesen, weitere
  Verkaufsbefehle werden währenddessen nicht gesendet. Der separate Stopp
  eines Clients lässt den anderen verbunden. Siehe
  [Gegenversuch](performance/stability-2026-11-08/navigation-negative-control.json)
  und [Korrektur](performance/stability-2026-11-08/navigation-fixed.json).
  Der dort historisch `confirmedSales` genannte Fixture-Zähler erfasst
  gesendete Klickpakete einschließlich abgewiesener Klicks, keine separaten
  Auszahlungen. Die gemessenen Verkaufsabstände unter dieser Last liegen
  bei etwa 3,1–3,2 Sekunden trotz eingestellter zwei Sekunden; diese
  verbleibende Verlangsamung wird nicht als behoben ausgegeben.
- Ein Session-Test hält den alten STOPPED-Aufruf absichtlich offen: weder
  expliziter Supervisor-Stopp noch neue Sitzung überholen ihn. Nach Freigabe
  startet der Ersatz; abgebrochene Wartende blockieren ihn nicht.

Mit dem Produktionsimage 1.8.0 / 2.10.7 wurde der Navigationstest wiederholt:
752 gesendete Klickpakete, 2.413 Pickups, 346 Resynchronisationen, genau ein
absichtlicher Stream-Abbruch, maximal 16 ausstehende Klicks und kein
Verkaufsbefehl während der Sperre. Der getrennte Stopp funktioniert. Die
Verkaufsabstände dieser Probe liegen im Median bei 2.119 ms. Siehe
[Produktionsimage-Test](performance/stability-2026-11-08/release-1.8.0-stress.json).
Ein erster paralleler Lauf wurde durch einen OOM-Kill der lokalen Docker-Test-VM
während zweier Image-Builds unterbrochen. Der erfolgreiche Wiederholungslauf
nutzte das fertige Produktionsimage ohne parallele Builds.

## Im Wiederanlauf zusätzlich nachgewiesene Fehler

Der erste Pi-Wiederanlauf mit 1.8.0 zeigte 3-Sekunden-Timeouts bei redundanten
STOPPED-Transaktionen und 15-Sekunden-Timeouts beim gleichzeitigen Start aller
Accounts. Darauf folgende Wiederanmeldungen lösten `You are logging in too fast`
aus. Die Engine-Gesundheitsprüfung allein beweist keine Bereitschaft aller Bots.

`stopRemoteAccount` liest deshalb zuerst den vom Spiel-Thread unabhängigen
Status. Nur wenn gewünschter und tatsächlicher Zustand beide STOPPED sind,
entfällt die doppelte dauerhafte Transaktion. Ein gewünschter START oder eine
laufende Verbindung werden weiterhin gestoppt. Für nötige Stopp-Transaktionen
bleibt die Account-Sperre bis zur Antwort, nun mit 30 statt drei Sekunden Budget.

`startupGate` verteilt Vorbereitungen je Server auf zwei Plätze mit mindestens
zwei Sekunden Abstand innerhalb einer Startwelle. Weltbeitritt, Authentifizierungs-
prompt, Abbruch oder Fehler geben den Platz frei; nach 30 Sekunden wird die
Zulassung auch bei einem nicht antwortenden Ziel freigegeben. Verschiedene
Server warten nicht aufeinander; wartende abgebrochene Starts werden entfernt.

Zwei Bedrock-Weltbeitritte scheiterten ausdrücklich mit `World packets exceeded
the Java initialization buffer`. Die mitgelieferte ViaBedrock-Version begrenzt
auf 10.000 Pakete oder 64 MiB. Viele kleine Entity-/Metadatenpakete können die
Paketgrenze vor der Java-Initialisierungsbestätigung überschreiten.
`BedrockWorldBufferMixin` erhöht ausschließlich diese Grenze auf 65.536.
Die 64-MiB-Grenze bleibt unverändert. Ein echter Fabric-Laufzeittest belegt
10.000 vorher und 65.536 nachher, vollständiges Leeren und weiterhin die
Ablehnung eines einzelnen Pakets über 64 MiB. Siehe
[Puffer-Gegenversuch und Korrektur](performance/stability-2026-11-08/world-buffer-1.8.1.json).

533 Backend-Tests in 60 Dateien bestanden einschließlich Startabständen,
begrenzter Zulassung, Abbruch, unabhängigen Servern und idempotenter Stopps.
Der Belastungstest mit 1.8.1 wiederholt Inventarsperren, manuellen Menüs,
Stream-Abbruch, 36 nachgefüllten Stacks und je 10.000 Items für zwei Clients;
siehe [Ergebnis](performance/stability-2026-11-08/release-1.8.1-stress.json).

## Nachprüfung am 9. November: visuelle Bedrock-Dauerschleife

Die private Nachtprobe enthält 121.510 Warnungen `Could not load the native
End sky texture`, jeweils mit `No accepted native world resource context`.
Die prozessweite Texturverwaltung vergleicht bei jedem Tick den aktuellen
ResourceManager. Mehrere Bot-Clients wechseln diesen Kontext ständig;
dadurch werden neue asynchrone Bild-Ladeaufträge gestartet und ihre Fehler
fortlaufend protokolliert. Dies ist ein nachgewiesener Last-/Logverursacher,
kein Beweis für die Ursache jedes Netzwerkabbruchs.

`HeadlessSkyTextureMixin` überspringt diesen Anzeige-Tick ausschließlich im
BotConnection-Kontext. Die eigentliche Ressourcenverwaltung, Paketverarbeitung
und normalen Client-Ticks werden weiter ausgeführt. Eine spezielle native
End-Himmelstextur wird für Bots damit nicht mehr geladen.

Der Gegenversuch im echten Fabric-Client ruft den Tick 20-mal auf: ohne
Korrektur wird ein Ladeauftrag angelegt und der globale Ressourcenkontext
geändert; mit Korrektur bleiben beide unverändert. Zwei getrennte Offline-Clients
prüfen weiterhin Verkauf, gehaltene Maus-/Schleichtasten und unabhängigen Stopp.
Siehe [Gegenversuch und Korrektur](performance/stability-2026-11-08/sky-texture-1.8.2.json).
Die Test-Erweiterung wird nicht auf dem Pi installiert.

## UDP-Verluste im Container

Der Host-Netzwerkzähler meldete keine UDP-Empfangsfehler. Im eigenen
Netzwerk-Namensraum des SoulFire-Containers standen dagegen um 06:22 Uhr
14.979 `RcvbufErrors`; um 06:25 Uhr waren es 18.187. Auch einzelne aktive
UDP-Sockets hatten Tausende Drops. Die Fehler sind damit konkret auf volle
lokale Empfangspuffer eingegrenzt. Der Pi erlaubt bereits 4 MiB, seine
Standardpuffer und die von RakNet angelegten Sockets nutzen dies aber nicht.

`BedrockReceiveBufferMixin` fordert im Konstruktor des RakNet-Clients mindestens
4 MiB für den darunterliegenden UDP-Socket an und protokolliert den tatsächlich
vom Betriebssystem gewährten Wert. TCP, Sendepuffer und globale Kernel-Einstellungen
des Pi werden nicht geändert. Größere bereits konfigurierte Puffer bleiben erhalten.
Der RAM-Bedarf steigt begrenzt pro Bedrock-Verbindung; Linux kann intern den
konfigurierten Wert für Verwaltungsdaten verdoppeln.

Ein echter Linux-/Fabric-Gegenversuch erstellt den RakClientChannel mit seinem
NIO-Datagram-Socket: bei 600 Paketen zu je 1.200 Bytes vor dem Auslesen kommen
mit dem bisherigen Puffer 93, nach der Korrektur alle 600 an. Der tatsächlich
gemeldete Java-Socketpuffer wächst von 106.496 auf 4.194.304 Bytes. Dieselben
Clients prüfen weiterhin Verkäufe und unabhängigen Stopp. Siehe
[Gegenversuch und Korrektur](performance/stability-2026-11-08/udp-buffer-1.8.3.json).
Dies belegt die Abhilfe für lokale Burst-Verluste; entfernte Server-/Netzfehler
werden dadurch nicht pauschal als behoben ausgegeben.

Das fertige Produktions-JAR 1.8.2 bestand außerdem den bisherigen Belastungstest:
588 Klickpakete, 2.467 Pickups, 323 Resynchronisationen, Inventarsperre,
verzögerte Menüs, manuelles Verkaufsmenü und unabhängiger Stopp;
siehe [Messung](performance/stability-2026-11-08/release-1.8.2-stress.json).

## Verbliebene Abbrüche differenzieren

Mit 1.8.3 verschwanden die Himmelstextur-Warnungen und die UDP-Dropzähler
blieben in der produktiven Nachprüfung bei null. `End of stream` trat trotzdem
weiter auf. Beim kalten Wiederanlauf blieb zudem ein Weltpufferüberlauf sichtbar.
Diese Fehler werden ausdrücklich nicht als durch die Pufferänderung behoben
gewertet.

1.8.4 sichert den RakNet-Schließgrund im Channel-Attribut und protokolliert ihn
mit lokaler Socketzuordnung im privaten Dienst-Log. Der bisher generische
Weltpufferfehler nennt zusätzlich die tatsächliche Paket-/Bytebelegung.
Der Transportablauf und beide Speichergrenzen bleiben unverändert. Ein echter
Fabric-Test prüft ein `CLOSED_BY_REMOTE_PEER`-Event und den Fehler bei genau
65.536 Ein-Byte-Paketen; siehe
[Laufzeitprüfung](performance/stability-2026-11-08/diagnostics-1.8.4.json).

Das fertige Produktions-JAR 1.8.3 bestand zusätzlich den Aktions-/Kameratest:
480×270-JPEGs für zwei Zuschauer über einen gemeinsamen Stream, Weltwechsel,
Beenden nach dem letzten Zuschauer, Verkaufs-Multiplikatoren, Spawner-Drops und
-Verkäufe sowie unveränderte Schleich-/Befehlsreihenfolge;
siehe [Messung](performance/stability-2026-11-08/release-1.8.3-actions.json).

## Produktiver Rollout

Am 9. November wurden zunächst 1.8.1 (06:14–06:17 Uhr) und danach 1.8.3
(06:27–06:29 Uhr) mit konsistenter Sicherung von Backend-Daten und veränderlichem
SoulFire-Zustand installiert. Die vollständige Sicherung vom 8. November und die
bisherigen Images bleiben zusätzlich erhalten. 1.8.4 wurde um 06:41 Uhr als reine
Erweiterungs-/Diagnoseänderung mit vorherigem Image als Rückweg installiert;
die Website blieb bei diesem letzten Spiel-Dienst-Neustart erreichbar.
Backend-Logik: 1.8.1; native Erweiterung: 1.8.4; Engine/SDK: 2.10.7.

Um 06:54 Uhr waren alle 13 beabsichtigt aktiven Accounts sowohl über die Website
als auch per RPC mit vorhandenem Spieler online (zehn Java, drei Bedrock).
Alle 31 Website-Accounts und deren aktuelle Kontologs wurden authentifiziert
nachgeprüft. Drei der sieben aktivierten Verkäufer hatten zusammen 215
Auszahlungsnachrichten in den letzten fünf Minuten. Die vier anderen hatten in
der Stichprobe leere Inventare. Die temporären Diagnose-Websitzungen wurden
anschließend gezielt entfernt. Siehe [Abschlussprobe](performance/stability-2026-11-08/pi-final-2026-11-09.json).

**Die Disconnect-Aufgabe ist nicht vollständig gelöst.** 1.8.4 belegt bei
verbliebenen Bedrock-Abbrüchen `CLOSED_BY_REMOTE_PEER`, daneben einmal
`TIMED_OUT`. Das eingehende Schließen durch die Gegenstelle erklärt noch nicht,
weshalb sie schließt. Eine alleinige Schuldzuweisung an den Server ist daraus
nicht zulässig. Für eine vollständige Ursache werden ein passender Server-/
Geyser-Fehlerbericht oder ein reproduzierbarer Protokoll-Gegenversuch benötigt.
Es wurden keine Nachrichten an Serverbetreiber versandt.

Die native 4-MiB-Anforderung wurde direkt an den laufenden Linux-Sockets geprüft:
8 MiB tatsächlicher Kernelpuffer. Nach zunächst fehlerfreien Messfenstern waren
unter weiterer Last wieder 5.545 UDP-Empfangsfehler gezählt worden. Ein begrenzter
Live-Gegenversuch erhöhte bestehende und neu verbundene Bedrock-Sockets temporär
auf 32 MiB Kernelpuffer. Der UDP-Fehlerzähler stieg in diesem Versuch nicht weiter;
eine neue vergrößerte Verbindung wurde trotzdem nach 76 Sekunden von der
Gegenstelle geschlossen. Alle experimentellen Socket-/Kerneländerungen wurden
zurückgesetzt; keine dauerhaften Sysctl-Änderungen oder Hilfscontainer bleiben.
Siehe [Transportprüfung](performance/stability-2026-11-08/bedrock-transport-1.8.4.json).

Die 30-Sekunden-Messung nach 1.8.3 ergab 304 % CPU, etwa 4,05 GiB residenten
JVM-Speicher und etwa 2,64 GiB verfügbaren RAM. Die CPU bleibt hoch; eine
CPU-Verbesserung wird nicht behauptet. Die JFR zeigt viel Bedrock-Blockübersetzung
auf Netzwerk-Threads. Die Rohaufnahme bleibt privat, die aggregierte
[Messung](performance/stability-2026-11-08/pi-1.8.3-resources.json) enthält keine
Sitzungs-/Kontodaten.

## microSD und nicht erkannte NVMe

Auf dem Pi 5 mit 8 GiB RAM liegen Projekt, Docker-Images, Containerd-Daten,
Datenbanken und beide AFK-Datenvolumes weiterhin auf der 119,2-GiB-microSD.
Die Root-Partition war zu etwa 85 % belegt. Eine SSD kann insbesondere diese
Datenträgerzugriffe und die bisher sehr langsamen Sicherungen/Imports verbessern;
sie ersetzt keinen Arbeitsspeicher und behebt Protokollfehler nicht automatisch.
Nur das Git-Arbeitsverzeichnis zu verschieben würde die laufenden Datenbank-/
Volume-Zugriffe nicht verlagern.

`lsblk`, PCIe- und USB-Inventar zeigen aktuell kein NVMe-/USB-Laufwerk und keinen
NVMe-Controller. Der Alias `pciex1` verweist auf den bereits aktivierten
`/axi/pcie@1000110000`-Knoten; der deaktivierte `pcie0`-Knoten ist nicht dieser
externe Anschluss. Daher wurde keine vermeintlich fehlende PCIe-Aktivierung
blind gesetzt. [Offizielle PCIe-Dokumentation](https://www.raspberrypi.com/documentation/computers/raspberry-pi.html#enable-pcie).
Die Anschlussart (M.2-HAT/FPC oder USB-Adapter) wurde beim Benutzer erfragt und
ist noch offen. Es wurde kein Laufwerk formatiert, keine Firmware aktualisiert,
kein Pi-Neustart ausgelöst und keine Datenmigration vorgenommen.
