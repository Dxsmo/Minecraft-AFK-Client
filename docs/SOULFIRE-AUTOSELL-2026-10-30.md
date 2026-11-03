# AutoSell und Weltwechsel – 30.10.2026

Diese Ergänzung baut auf der [Funktions- und Performanceprüfung](PERFORMANCE-2026-10-30.md) auf. Accountdaten, Microsoft-Login-Caches und gespeicherte Einstellungen bleiben erhalten. Die Änderungen sind mit SoulFire 2.10.6 und der Controls-Erweiterung 1.1.0 umgesetzt.

## AutoSell

Die bisherige clientseitige 1,5-Sekunden-Grenze ist aus AutoSell und dem Java-Eingabefeld entfernt. Beide Editionen erlauben weiterhin den API-Wertebereich 0,25–3.600 Sekunden. Automatische Verkäufe verbrauchen das Budget der manuellen Befehlswarteschlange nicht mehr. Deren bestehende Begrenzung ist unabhängig davon erhalten.

Der nächste Verkauf wird ab dem Versandzeitpunkt geplant; die Laufzeit des Command-RPCs wird nicht zusätzlich auf das Intervall aufgeschlagen. Inventarbestätigungen und Verkaufsmeldungen können den Ablauf unmittelbar fortsetzen, ohne für jeden Stack einen weiteren 100-ms-Tick abzuwarten. Aktionen bleiben pro Account serialisiert und an die aktuelle Menüidentität gebunden. Noch nicht bestätigte Transfers werden weiterhin abgewartet.

Die optionale Statusabfrage läuft getrennt von dieser Warteschlange und verwendet ein 3-Sekunden-Zeitlimit. Eine langsame Statusabfrage kann den Verkaufsablauf nicht mehr für das bisherige 15-Sekunden-RPC-Zeitlimit blockieren. Idle-Clients werden weiterhin geprüft; reine Transport-Heartbeats verdecken keinen eingefrorenen Spielclient.

Im isolierten nativen Test mit 36 sofort nachgefüllten Stacks und 2-Sekunden-Einstellung wurden vor dem absichtlichen Weltwechsel Abstände von 2.005, 2.038 und 2.546 ms gemessen. Mit drei Stacks und 0,5-Sekunden-Einstellung lagen die ungestörten Abstände ungefähr bei 0,48–0,58 s. Der Weltwechsel erzeugt in beiden Tests bewusst eine zusätzliche Stabilisierungsphase. Die vollständigen Reihen stehen in den Rohdaten.

Diese Messung verwendet einen lokalen Protokollserver. Sie garantiert keine identischen Zeiten auf HugoSMP oder unter CPU-/Netzwerküberlastung. Eine noch laufende Menü-/Transferbestätigung und serverseitige Regeln können einen Verkauf weiterhin verzögern.

## Kamera bei Teleports und Weltwechseln

Ein vorübergehender Upstream-Fehler beendet die Browser-Verbindung nicht mehr sofort. Solange Zuschauer vorhanden sind, wird der betroffene Kamera-Stream nach kurzer Pause erneut geöffnet. Die Oberfläche zeigt den Ladezustand. Authentifizierungs-/Berechtigungsfehler werden weiterhin beendet und nicht endlos wiederholt. Der letzte Zuschauer beendet auch einen wartenden Wiederholungsversuch.

Im nativen Java-Test wurden zwei Zuschauer über einen Dimensionswechsel und zurück verbunden gehalten; beide erhielten danach weitere 640×360-PNG-Frames. Der gemeinsame Code gilt für Java und Bedrock. Ein echter Bedrock-Teleport mit gültigem Microsoft-Account wurde hier nicht nachgestellt.

## Gesperrtes `/afk` und `/desmo`

Die Website-Konsole fängt `/afk` einschließlich Großschreibung, Argumenten und Plugin-Namespace vor dem Versand ab. Sie gibt stattdessen aus:

> Mit den Accounts über den AFK-Client ist es nicht erlaubt, Stars zu farmen!!

Dies wird im MinecraftClient erzwungen, sodass HTTP und Konsolen-WebSocket denselben Weg verwenden. Ein zusätzlicher nativer Mixin blockiert den Befehl auch auf dem nativen Versandpfad. Automationsversuche durchlaufen ebenfalls eine Prüfung. Es wird kein `/afk` an den Server geschickt.

`/desmo` bleibt als exakter Alias in der Website-Konsole erhalten. Er liest über `/sellmulti` die neun Verkaufsmultiplikatoren aus. Der Alias gilt nicht für den direkt bedienten nativen Minecraft-Chat.

## Prüfungen

Die damalige Prüfung umfasste kurze Verkaufsintervalle, langsame Statusabfragen, Kamera-Wiederaufnahme, `/afk`-Varianten, Multiplikatoren und CleanSpawner sowie Backend-/Frontend-Builds und Linux-ARM64-Docker-Images. Die Messungen nutzten temporäre Offline-Accounts und keinen produktiven Spielserver.

Hinweise zum [isolierten Audit-Stack](PERFORMANCE-2026-10-30.md#wiederholen).

## Noch offen

Für den gemeldeten **Bedrock-Kick nach `/home` oder `/spawn`** fehlt der genaue Disconnect-/Packet-Exception-Text. Ohne ihn ist nicht feststellbar, welcher ViaBedrock-Decoder, Pakettyp oder Serverzustand betroffen ist. Es wurde kein beliebiger Paketfehler pauschal als behoben ausgegeben oder eine unbestätigte Protokolländerung vorgenommen.

Auch der genaue Wortlaut der ursprünglich „alle zwei Sekunden“ wiederholten AutoSell-Meldung wurde noch nicht mitgeschickt. Die clientseitigen Zeitbegrenzungen und Blockaden sind korrigiert und im isolierten Test gab es keine AutoSell-Warnungen. Die konkrete Meldung auf dem produktiven Server muss anhand ihres Wortlauts geprüft werden.
