# Account-Logprüfung und AutoSell-Korrektur vom 7. November

Controls-Version: 1.7.0; SoulFire weiterhin checksum-gepinnt auf 2.10.6.
Diese Änderung ergänzt [die vorherige Stabilitätskorrektur](STABILITY-2026-11-07.md).

## Ausgelesene Logs und Grenzen des Befunds

Alle 31 für den angemeldeten Website-Zugang sichtbaren Accounts wurden lesend
geprüft: insgesamt 531.190 gespeicherte Logzeilen. Die Aufbewahrung endet bei
20.000 Zeilen je Account; bei lange offline geschalteten Accounts stammen die
letzten Einträge teilweise von früheren Tagen. Es wurden keine produktiven
Account-Befehle, Starts oder Einstellungsänderungen ausgeführt. Die individuellen
Berichte und Rohlogs liegen privat außerhalb des Repositories.

Im aktuellen Zeitfenster fallen wiederholte Startwarteschlangen ohne
Weltbeitritt, gemeinsame RPC-Timeouts, Server-Timeout-Kicks, Login-Limits und
abgewiesene Home-Befehle auf. Zeitweise melden elf Accounts innerhalb desselben
Zehn-Sekunden-Fensters einen gemeinsamen Dienst-/RPC-Ausfall. Das belegt ein
übergreifendes Problem; aus Website-Logs allein ist dessen CPU-, Speicher-,
Netzwerk- oder Datenbankursache nicht feststellbar. Dafür sind zusätzlich die
SoulFire-Dienst-Logs und Pi-Ressourcenwerte erforderlich.

Ältere Bedrock-Protokoll-/NBT-Fehler aus den früheren Implementierungen werden
nicht als aktuelle Fehler des heutigen Clients ausgegeben. Ein fehlerhaftes
vom Spielserver gesendetes Paketbundle und die Erreichbarkeit externer
Authentifizierungsserver bleiben ebenfalls außerhalb einer pauschalen
„alle Disconnects behoben“-Aussage.

## AutoSell: unnötige Wartezeit beseitigt

Version 1.6 wartete nach **jedem einzelnen Stack** auf die Serverantwort. Bei
36 Stacks wurde damit die Netzwerklatenz 36-mal nacheinander bezahlt. Das war
eine Regression für schnelle eingestellte Intervalle.

Jetzt werden bis zu acht normale Shift-Klicks je Spieltick gesendet, mit maximal
16 noch unbestätigten Transfers gleichzeitig. Jeder Spielerinventar-Slot wird
höchstens einmal je Durchlauf besucht. Slot-Antworten und Auszahlungen werden
nicht als zwei unabhängige Bestätigungen desselben Transfers addiert. Ein voller
Inventar-Snapshot bestätigt nur tatsächlich veränderte Stacks; unverändert
nachgefüllte Stacks können durch echte Auszahlungen bestätigt werden.

Die Inventarsperre wird zusätzlich direkt beim Empfang der Systemnachricht auf
dem Spielthread erkannt. So muss der Client nicht warten, bis die asynchrone
Website-Chatverarbeitung nachkommt. Die begrenzten Fehlerpausen, Menüzuordnung,
Fünf-Sekunden-Bestätigungsfrist und 90-Sekunden-Steuerungsfreigabe bleiben aktiv.

Der gewünschte Abstand wird weiterhin vom Senden des Verkaufsbefehls gemessen.
Es wird keine zusätzliche feste Pause nach jedem erfolgreichen Verkauf addiert.
Ein laufender Verkauf wartet auf seine Bestätigungen; falls Serverantworten oder
der normale Spieltick den gewünschten Abstand physikalisch überschreiten,
werden keine überlappenden Menüs oder nachzuholenden Befehlsbursts erzeugt.

## Reconnect: abgeschlossene Fehlerbereinigung darf den nächsten Start nicht blockieren

Im gepinnten SoulFire-Code wird `isDisconnected` im erfolgreichen
`disconnectNow`-Pfad gesetzt. Wenn das Beenden vorher fehlschlägt, kann der
Minecraft-Client bereits gestoppt und jeder Netzwerkkanal geschlossen sein,
während die alte Verbindung in `botConnections` bleibt. Die Startwarteschlange
lehnt dann den nächsten Start desselben Profils ab, weil der Eintrag noch existiert.

Die Erweiterung beobachtet das Abschluss-Future und alle registrierten Kanäle.
Sie gibt den alten Eintrag ausschließlich frei, wenn **alle** Bedingungen gelten:

- Das Beenden ist mit einem Fehler abgeschlossen.
- Der Minecraft-Client läuft nicht mehr.
- Kein registrierter Netzwerkkanal ist noch offen.

Ein verspätetes Schließen des letzten Kanals prüft diese Bedingungen erneut.
Die Entfernung verwendet den vorhandenen instanzgebundenen Vergleich des
konkreten Verbindungsobjekts; ein neuerer oder anderer Account wird nicht entfernt.

Damit ist dieser Fehlerpfad behoben. Ob er die konkreten produktiven
Startschleifen ausgelöst hat, muss mit den Dienst-Logs abgeglichen werden.
Ein dauerhaft blockierter Spiel-/Netzwerkthread oder ein nicht erreichbarer
SoulFire-Dienst wird durch diese Bedingung nicht als erfolgreich beendet ausgegeben.

Zusätzlich berücksichtigen die Wiederholungsabstände jetzt HTTP 429,
„bereits auf dem Server“, „connection already exists“ und wiederholt fehlenden
Weltbeitritt. Bei abgewiesenen Chat-/Home-Aktionen bleibt die konkrete
SoulFire-Fehlermeldung erhalten statt nur „Command wurde nicht ausgeführt“.

## Prüfung

- 520 Backend-Tests bestanden; native Java-Tests für Freigaben, Fehlerpausen,
  begrenzte Transferfenster, doppelte Bestätigungssignale und Timeouts bestanden.
- Zwei tatsächliche SoulFire-Clients, je 10.000 Item-Entities, 36 ständig
  nachgefüllte Stacks, Pickups und 120 ms verzögerte Serverbestätigungen:
  bei eingestellten 500 ms beträgt der gemessene Median 528 ms. Unterbrochener
  Ereignisstream, 365 Sperrmeldungen und Verkaufsfortsetzung bestanden;
  maximal 16 unbestätigte Transfers. [Messdaten](performance/autosell-reconnect-2026-11-07/sell-500ms.json).
- Bei eingestellten zwei Sekunden: Median 2026,5 ms mit denselben 36 Stacks,
  120 ms Antwortverzögerung und je 10.000 Item-Entities. Die erste Menüantwort
  wurde verworfen, Inventar-Frames wurden vollständig unterdrückt, und während
  eines laufenden Verkaufs wurde eine Sperre mit 365 Antworten ausgelöst.
  Acht bereits gesendete Klicks wurden abgewiesen; danach blieb der Client
  während der Sperre ruhig und verkaufte automatisch weiter.
  [Messdaten](performance/autosell-reconnect-2026-11-07/sell-2000ms.json).
- Testfehler absichtlich nach Schließen aller Kanäle und vor dem normalen
  `isDisconnected`-Flag ausgelöst: mit aktivierter Korrektur erfolgreicher
  Wiederbeitritt mit derselben Instanz und Profil-ID; der zweite Account blieb
  verbunden. [Ergebnis](performance/autosell-reconnect-2026-11-07/failed-disconnect-recovery.json).
- Kontrollversuch mit derselben Test-Erweiterung, aber ausgeschalteter
  `DisconnectCleanupMixin`: kein erneuter Weltbeitritt innerhalb von 25 Sekunden.
  [Erwarteter Fehler](performance/autosell-reconnect-2026-11-07/failed-disconnect-negative-control.json).

Die Fehler-Injektion liegt ausschließlich unter `soulfire/test/fixtures` und
wird nur durch `soulfire/test/build-fault-plugin.py` in eine temporäre Test-JAR
aufgenommen. Die Produktions-JAR enthält diesen Testfehler nicht.

Der Backend-Docker-Build ist geprüft. Die native Erweiterung wurde gegen das
checksum-gepinnte Artefakt kompiliert und in der bestehenden Linux-/Java-25-
SoulFire-Laufzeit geprüft. Ein zusätzlicher vollständiger Native-Docker-Build
wurde während des erneuten 398-MiB-Downloads des unveränderten SoulFire-Releases
abgebrochen; dafür wird kein erfolgreicher vollständiger Neubau behauptet.

## Update auf dem Pi

Im bestehenden Projektordner:

```bash
git pull --ff-only && bash scripts/update.sh
```

Für diese Codekorrekturen müssen Backend und native Erweiterung neu gebaut
werden; ein bloßes `docker compose up --no-build` installiert sie nicht.
Bestehende Docker-Caches, Datenvolumes und Microsoft-Anmeldungen bleiben erhalten.
Die Änderungen wurden isoliert getestet, nicht auf dem produktiven Pi ausgerollt.
