# Kamera: Datenmenge und Spielreaktionszeiten

Die gemeldeten 600 ms im laufenden Betrieb wurden nicht auf dem Produktions-Pi oder am Internetanschluss des Nutzers gemessen. Für die Diagnose müssen Internet-Ping, Minecraft-Keepalive-Ping und Reaktionszeit des Client-Spielthreads unterschieden werden. Im lokalen Test wurden Netzwerk-Keepalives schnell beantwortet, während Spielaktionen bei knapper CPU bereits mehrere hundert Millisekunden warteten. Deshalb sind beide Messungen enthalten.

## Gefundene Belastungen und Änderung

SoulFire teilt einen fairen Vulkan-Geräte-Lock zwischen den Client-Spielschritten und dem Rendering. Die Sperre bleibt erhalten, weil gemeinsam verwendete Grafikressourcen sonst parallel verändert werden könnten. Teure Bilder können Spielaktionen anderer Accounts mit aufhalten. Außerdem nutzte der mitgelieferte Software-Renderer auf dem Testhost zwölf Worker. Das konkurriert auf einem kleinen oder ausgelasteten Server mit den Accounts.

- Standardmäßig zwei Software-Render-Worker durch `LP_NUM_THREADS=2` im SoulFire-Image. Das ist eine unterstützte [Mesa-Einstellung](https://docs.mesa3d.org/envvars.html#envvar-LP_NUM_THREADS) und kann per Container-Umgebung überschrieben werden. Installierte Hardware-Treiber werden dadurch nicht auf Software-Rendering umgestellt. Im laufenden Testprozess wurden tatsächlich nur `llvmpipe-0` und `llvmpipe-1` statt zwölf solcher Worker angelegt.
- Normale Live-Bilder der Website werden nativ als JPEG mit Qualität 0,72 übertragen. Das Encoding erfolgt auf dem RPC-Worker, nachdem das Rendering den Spielthread freigegeben hat. Größe und Sichtweite bleiben 480 × 270 und zwei Chunks. Es wird kein fertiges PNG zusätzlich umgewandelt. Inventar-Icons und Debug-Aufnahmen bleiben PNG. Die Website verarbeitet beide Formate mit einer festen MIME-Allowlist.
- Pro Zuschauer höchstens ein noch nicht angezeigtes Live-Bild. Erst nach dem Laden des Bildes im Browser wird dessen Sequenz bestätigt. Zwischendurch überholte Bilder werden für diesen Zuschauer übersprungen. Ein langsamer Zuschauer blockiert keine anderen Zuschauer. Zugriffsrechte werden auch während des Wartens weiter überprüft. Eine ausbleibende Bestätigung gibt die Kamera nach 15 Sekunden frei.
- Die Video-Ausgabepuffer werden früher begrenzt. Die Fernsteuerung übermittelt nun Bildsequenz, zusätzliche Lieferverzögerung, Decoder-Rückstau und Decoder-Erholungen an SoulFires vorhandene Qualitätsanpassung. Die Verzögerung wird relativ zur bisher schnellsten beobachteten Bildlieferung berechnet; synchronisierte Uhren sind dafür nicht nötig. Das ist kein absoluter Internet-Ping. Bei Rückstau kann der native Encoder Auflösung und Bitrate senken.
- Beide Kameramodi berücksichtigen die Kosten des letzten Bildes bei der nächsten Aufnahme: Die nächste Anfrage wartet mindestens die doppelte vergangene Bildbearbeitungszeit, gedeckelt auf eine zusätzliche Wartezeit von einer Sekunde. Bestehende längere Intervalle gelten weiterhin. Gewartet wird im Scheduler, niemals durch Schlafen im Client-Spielthread. Günstige Bilder behalten die bisherige Rate; unter hoher Last sinkt die Bildrate zugunsten der Account-Aktionen.

SoulFire bleibt **2.10.6**, die Controls-Erweiterung ist **1.4.0**. Die zusätzlichen Compile-Abhängigkeiten stammen weiterhin aus dem checksum-geprüften Release-Manifest. Es gibt keine Datenbankmigration und keine neue Glocken-Ankündigung.

## Vergleichsmessung

Linux ARM64 unter Docker Desktop auf einem M3 Pro, zwei temporäre Offline-Clients, je 1.500 echte Item-Entities und eine geladene, texturierte Bodenfläche. Der SoulFire-Container ist auf zwei CPU-Kerne und 3 GiB begrenzt. Pro Phase acht Sekunden Messzeit nach Warmlauf. Verglichen wurden Controls 1.3.0 und 1.4.0 mit derselben Java-1.8.8-Protokoll-Fixture. Der Test verbindet sich zu keinem vorhandenen Spielserver.

| Messung | Vorher | Nachher |
| --- | --- | --- |
| Normale Live Cam | 4,875 FPS | 5,25 FPS |
| Live-Bilddaten einschließlich Base64 | 3.378 kbit/s | 774 kbit/s |
| Höchste gemessene Spielantwort des betrachteten Accounts bei Live Cam | 52,82 ms | 28,45 ms |
| Remote-Bilder | 15 FPS | 11,625 FPS mit automatischer Begrenzung |
| Remote-Bilddaten einschließlich Base64 | 692 kbit/s | 554 kbit/s |
| Höchste gemessene Spielantwort des betrachteten Accounts bei Remote | 43,54 ms | 9,30 ms |

Die Live-Datenmenge sank in diesem Motiv um etwa **77 %**, ohne eine niedrigere Live-Bildrate. Die JPEG-Kompression ist verlustbehaftet. Andere Motive haben andere Kompressionsraten. Die Reaktionszeitmessungen enthalten jeweils nur 16 Spielantworten; sie belegen keine allgemeine Latenzgarantie. TCP-/TLS-Overhead und der übrige Account-Traffic sind in den Bilddaten nicht enthalten.

Zusätzlicher Überlasttest: vier Clients mit jeweils 1.500 Items und nur einer verfügbaren CPU. Bereits ohne Kamera waren die Spielreaktionen teilweise sehr langsam. Beim betrachteten Account betrug der Median mit Live Cam vorher rund 602 ms, nachher rund 122 ms; einzelne Antworten lagen weiterhin bei etwa 591 ms. Auch andere Accounts hatten weiterhin hohe Spitzen. Keepalive-Antworten und Spielreaktionen werden deshalb in den Rohdaten getrennt ausgewiesen. Ein vollständig ausgelasteter Server lässt sich durch Bildkompression allein nicht reaktionsschnell machen. Die Messungen sind keine Aussage über den konkreten Ping des Nutzers.

## Funktions- und Belastungsprüfung

- **491 Backend-Tests in 50 Dateien**, Backend-/Frontend-Builds, Frontend-Lint und alle drei Docker-Images erfolgreich.
- Echter Browser → Website-WebSocket → native Fernsteuerung bei 1.500 Boden-Items, vier Sekunden verzögerter Vorbereitung, drei Sekunden verzögerter Eingabe und schneller Mausbewegung: zwei erfolgreiche Starts, Bewegung, Inventar, Escape, erneuter Start, AutoSell-Pause und Wiederaufnahme.
- Bei 500 ms künstlich verzögerter Live-Bildbestätigung kamen in 2,5 Sekunden nur vier neue Bilder an. Der Server staut die übrigen Bilder nicht für diesen Zuschauer auf.
- Bei künstlich gemeldetem Decoder-/Liefer-Rückstau reduzierte die native Fernsteuerung die Auflösung von 480 × 270 auf 360 × 202. Die Steuerung blieb verwendbar.
- Der gemeinsame Browsertest erreichte 4,77 FPS im Live-Modus und etwa 12,49 / 13,49 FPS bei den beiden Remote-Sitzungen. Gleichzeitig blieb das eingestellte 2-s-AutoSell-Intervall bei 2.017 / 2.055 ms.
- Zusätzliche Prüfungen decken Zugriffsverlust trotz ausstehender Bildbestätigung, isolierte langsame Zuschauer, ungültige Bestätigungen, begrenztes Feedback, JPEG/PNG-Kompatibilität und Reihenfolge der Steuerungseingaben ab.

Rohdaten liegen unter [performance/camera-latency-2026-10-30/](performance/camera-latency-2026-10-30/). `backend/scripts/audit-camera-latency.mjs` misst echte Keepalive-Antworten und die Verarbeitung sehr kleiner Positionskorrekturen. Diese Korrekturen bleiben unter der Teleport-Erkennung der Automation. Ein echter Bedrock-Login, der Produktions-Pi und der Internetzugang des Nutzers wurden nicht getestet.

## Einspielen

Alle drei Dienste einschließlich SoulFire neu bauen, damit Bildformat und neue Erweiterung zusammenpassen:

```bash
cd /opt/afk-service && git pull --ff-only && bash scripts/update.sh --recreate
```

Danach die Website mit **Strg+F5** neu laden. Anmeldungen, Accounts und Einstellungen bleiben in den vorhandenen Volumes.

Für eine Wiederholung an einer ausdrücklich isolierten SoulFire-Instanz: `AFK_LATENCY_CLIENTS=2 AFK_LATENCY_ITEMS=1500 AFK_LATENCY_SECONDS=8` und `backend/scripts/audit-camera-latency.mjs`. Der Container muss separat auf die gewünschte CPU-Zahl begrenzt werden. Der Browsertest aktiviert mit `AFK_REMOTE_CONGESTION_CHECK=1` verzögerte Bildbestätigungen und die Qualitätsanpassung. Private Microsoft-Caches und SoulFire-Schlüssel dürfen nicht in Messberichte übernommen werden.
