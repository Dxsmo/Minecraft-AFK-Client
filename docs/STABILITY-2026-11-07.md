# Reconnects, Inventarsperren und Wiederaufnahme nach Hub-Rückfall

Die anschließende [Account-Prüfung und AutoSell-Korrektur](AUTOSELL-RECONNECT-2026-11-07.md)
ersetzt die serielle Klickbestätigung dieser Version durch begrenzte parallele
Transfers und ergänzt die Bereinigung fehlgeschlagener Verbindungsenden.

Stand: 7. November 2026. SoulFire bleibt auf 2.10.6 gepinnt; die native
Controls-Erweiterung ist 1.6.0. Diese Änderungen ergänzen
[die Stabilitätskorrekturen vom Vortag](STABILITY-2026-11-06.md).

## Verkaufsablauf

Die native Automatisierung reagiert jetzt selbst auf die HugoSMP-Meldung, dass
Inventardaten gespeichert oder geladen werden. Viele Meldungen innerhalb einer
Sekunde werden zusammengefasst. Die Pause beginnt bei zwei Sekunden und wächst
bei wiederholten Fehlern bis maximal 30 Sekunden. Eine bestätigte Auszahlung
setzt die Fehlerfolge zurück. Es gibt keine unbegrenzte Fehlerpause.

Ein Verkaufsmenü benötigt seine vollständigen serverseitigen Inventardaten.
Anschließend erfolgt höchstens ein Shift-Klick pro Spieltick; der nächste wartet
auf eine Serverbestätigung für das betreffende Menü/den betreffenden Slot oder
eine echte Auszahlung. Unmittelbar nachgefüllte Slots werden im selben Durchlauf
nicht erneut besucht. Bei fünf Sekunden ohne Bestätigung wird das eigene Menü
geschlossen und nach einer Pause erneut versucht. Ein Durchlauf dauert höchstens
15 Sekunden. Fremde Menüs werden nicht als native Verkaufsmenüs übernommen.

Eine verlorene Menüantwort führt nach drei Sekunden zu einer Pause statt zu
fortlaufenden `/sell`-Anfragen. Telemetrie-Ausfälle ändern den nativen Ablauf
nicht. Die alle fünf Sekunden erneuerte, ausschließlich im Speicher gehaltene
Verkaufsfreigabe überbrückt jetzt bis zu 90 Sekunden ohne Steuerungsdienst;
danach stoppt die Automatisierung weiterhin. Explizites Trennen stoppt den Bot.

Der gemeinsame Scheduler hält auch manuelle Befehle während einer Inventarsperre
zurück. Identische wartende Befehle werden zusammengefasst, die Warteschlange
ist auf 32 begrenzt. Mehrdeutig fehlgeschlagene manuelle Befehle werden nicht
ungefragt sofort wiederholt.

## Verbindung und Ziel nach dem Reconnect

Normale Verbindungsabbrüche behalten die Wartezeit von 15 Sekunden. Bei
`logging in too fast` wächst sie von 60 bis 300 Sekunden, bei wiederholt nicht
erreichbarem Steuerungsdienst bis 120 Sekunden. Ein kurzes Erscheinen im Hub
setzt diese Fehlerfolge nicht zurück; erst zwei Minuten stabile Verbindung.
Paket-/Bundle-Kicks erhalten ebenfalls mindestens 60 Sekunden Abstand.

Nach bestätigter Microsoft-/Offline-Authentifizierung wird fehlender Weltbeitritt
nach 90 Sekunden erkannt. Die unabhängige Statusabfrage unterscheidet einen
hängenden Spielthread von einem ausgefallenen Steuerungsdienst. Ein gesunder
Statusstream erzeugt keinen erfundenen Spiel-Heartbeat; der Watchdog bleibt bei
einem eingefrorenen Spielclient wirksam.

Die neue Account-Einstellung **Nach Reconnect zum zuletzt bestätigten Home** ist
standardmäßig aktiv. Gemerkt wird ausschließlich ein manuell gesendetes
`/home NAME`, dessen Erfolg der Server mit dem passenden Namen bestätigt hat.
Das Ziel liegt privat im Account-Cache und gilt nur für dieselbe Profil-ID,
Edition und Serveradresse. Ein ausdrücklicher Wechsel per `/spawn`, `/hub`,
`/warp`, `/server` oder TPA verwirft das bisherige Ziel.

Beim nächsten Weltbeitritt wartet der Client fünf Sekunden und fordert das
bekannte Home an. Weitere Versuche halten 15, 30, 60 und maximal 120 Sekunden
Abstand. AutoSell wartet auf die passende Serverbestätigung. Manuelle
Navigation hat Vorrang; das automatische Zurückkehren lässt sich abschalten.
Ohne bekanntes Home wird kein Ziel geraten.

Beim ersten Update kann ein bestätigtes Home aus bis zu 200 relevanten
vorhandenen Logzeilen übernommen werden. Erforderlich sind ein Startmarker mit
passender Serveradresse, ein manueller Home-Befehl und die folgende echte
Serverbestätigung innerhalb von zwei Minuten. Bereits vorhandene Home-Dateien
werden dabei nicht überschrieben.

## Belastung der Website und Update

Verkaufserträge bleiben einzeln erhalten, werden aber in begrenzten gemeinsamen
Transaktionen gespeichert. Der letzte Verkaufszeitpunkt kann dabei nicht
rückwärts springen. Neue Verbindungen schreiben die anfänglichen
Account-Einstellungen ebenfalls in einer gemeinsamen Aktualisierung statt in
vielen einzelnen Datenbanktransaktionen. Nicht betroffene Einstellungen bleiben
erhalten. Das reduziert Schreibdruck bei vielen Verkäufen und Reconnects.

Das Update enthält eine automatische Datenbankmigration für `autoReturnHome`.
Im bestehenden Checkout auf dem Pi:

```bash
git pull --ff-only
bash scripts/update.sh
```

Das Skript verwendet vorhandene Docker-Caches und baut vor dem Austausch der
laufenden Container. Accountdaten und Anmelde-Caches bleiben in den vorhandenen
Volumes. Der notwendige Dienstwechsel unterbricht laufende Verbindungen kurz;
automatisch gestartete Accounts werden anschließend wieder aufgenommen.

## Prüfung und Grenzen

- 515 Backend-Tests einschließlich echter SQLite-Burstschreibvorgänge,
  Inventarsperren, Home-Bestätigungen, Watchdog-/Statusfällen und Reconnect-Regeln.
- Frontend-Build und Lint; Docker-Builds für Backend und Web.
- Native Kompilierung gegen das checksum-gepinnte SoulFire-Artefakt sowie
  eigenständige Java-Tests für Freigaben und begrenzte Fehlerpausen.
- Isolierter Protokollserver mit zwei tatsächlichen SoulFire-Clients,
  je 10.000 übertragenen Item-Entities, 36 ständig nachgefüllten Stacks,
  Item-Pickups, unterbrochenem Ereignisstream und 365 Sperrmeldungen am Stück.
  Der 90-Sekunden-Dauerabschnitt blieb verbunden; nach der Sperre wurde
  automatisch weiterverkauft. Ergebnisse: [Testprotokoll](performance/stability-2026-11-07/dense-items.json).
- Zweiter Durchlauf mit 120 ms verzögerten Bestätigungen, vollständig
  unterdrückten Inventar-Frames und einer verlorenen Menüantwort: maximal ein
  unbestätigter Klick gleichzeitig, anschließende Verkaufsfortsetzung und
  unabhängiges Stoppen eines Accounts bestanden. Ergebnisse:
  [Testprotokoll](performance/stability-2026-11-07/delayed-confirmations.json).
- Frischer Backend-Container: Migrationen erfolgreich, `/api/health` liefert OK.

Die Prüfungen verwenden temporäre Offline-Accounts, keine produktiven
Microsoft-Accounts oder HugoSMP-Verbindungen. Sie ersetzen keinen mehrstündigen
Betrieb auf dem Pi. Ein Spielserver-Kick, ein fehlerhaftes eingehendes Paketbundle,
ein abgelaufenes Microsoft-Login oder ein Ausfall von Pi/Netzwerk kann weiterhin
einen Disconnect verursachen. Die Änderungen verhindern die belegten lokalen
Spam-/Stillstandsursachen und verbessern die Wiederaufnahme; sie garantieren
keinen unterbrechungsfreien externen Serverbetrieb.
