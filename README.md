# TachoBandit

Persönliche Verwaltung von Tachografen-Daten: `.ddd`-Dateien von **Fahrerkarte** und **Fahrzeug (Massenspeicher)** hochladen, dauerhaft speichern und übersichtlich anzeigen – lokal im Docker-Container, ohne Cloud.

Dekodierung und Signaturprüfung übernimmt [tachoparser](https://github.com/traconiq/tachoparser) (Gen1, Gen2 „Smart-Tacho“ und Gen2 V2).

## Funktionen

- Upload per Drag & Drop (mehrere Dateien), Ablage in `./data` (doppelte Dateien werden erkannt)
- **Tage**: 24-h-Balken je Tag (Lenken / Arbeit / Bereitschaft / Ruhe), Tagessummen, Kilometer, Wochen-Lenkzeit; Klick zeigt alle Abschnitte
- **Fahrerkarte**: Inhaber, Karte, Führerschein, benutzte Fahrzeuge, Orte (Beginn/Ende), Ereignisse und Fehler
- **Fahrzeug**: Kennzeichen, FIN, Download-Zeitraum, gesteckte Karten (Fahrer/Beifahrer), Orte, Ereignisse/Fehler, Kalibrierungen
- Prüfung der digitalen Signaturen mit den öffentlichen EU-Zertifikaten (ERCA/MSCA, im Image enthalten)
- Originaldatei jederzeit wieder herunterladbar

Zeiten wahlweise in **UTC** (so wie der Tachograf sie speichert) oder in **Ortszeit** (Zeitzone des Browsers, inkl. Sommerzeit; Tage werden dann an Mitternacht Ortszeit geschnitten). Umschalter oben rechts, die Wahl wird gemerkt.
Reiter **Kontrolle** (Fahrerkarte): automatische Prüfung auf Verstöße nach VO (EG) 561/2006 mit Schwere-Einstufung (Anhang III RL 2006/22/EG) und österreichischem Strafrahmen für den Lenker (KFG §134) sowie nach AZG (§13b Wochenarbeitszeit, §13c Ruhepausen, §14 Nachtarbeit). Vereinfacht, keine Rechtsberatung; Ausnahmen wie Fähre/Zug, Mehrfahrerbetrieb oder 12-Tage-Regel werden nicht geprüft.

## Start

```bash
git clone https://github.com/CrashBandit82/tachobandit.git
cd tachobandit
docker compose up -d --build
```

Danach im Browser: <http://127.0.0.1:8095>

Die Ansicht ist nur am eigenen Rechner erreichbar (`127.0.0.1`). Die Daten liegen in `./data` – diesen Ordner sichern.

## Daten auslesen

- **Fahrzeug**: Unternehmenskarte in den Tachografen stecken, Download-Key (z. B. VDO DLK) anstecken, Download starten. Die `.ddd`-Dateien vom Key in den TachoBandit ziehen.
- **Fahrerkarte**: Download im Fahrzeug über den Download-Key – oder direkt am PC: Karte in den Chipkartenleser stecken und **„Fahrerkarte aus Kartenleser auslesen“** klicken. Die Karte wird nur gelesen (inkl. Signaturen, Gen1 und Gen2), nichts darauf verändert.

### Kartenleser einrichten (Linux)

Jeder PC/SC-Leser (CCID) geht, z. B. HID OMNIKEY 3021. Auf dem Host:

```bash
sudo pacman -S ccid pcsc-tools          # Debian/Ubuntu: apt install pcscd libccid pcsc-tools
sudo systemctl enable --now pcscd.socket
```

Der Container nutzt den `pcscd` des Hosts über `/run/pcscd` und läuft als uid 1000. Verlangt pcscd eine polkit-Freigabe („Access denied“), diese Regel anlegen (Benutzername der uid 1000 eintragen):

```js
// /etc/polkit-1/rules.d/50-tachobandit-pcsc.rules
polkit.addRule(function(action, subject) {
    if ((action.id == "org.debian.pcsc-lite.access_pcsc" ||
         action.id == "org.debian.pcsc-lite.access_card") &&
        subject.user == "BENUTZER") {
        return polkit.Result.YES;
    }
});
```

## Aufbau

| Pfad | Inhalt |
|---|---|
| `server/main.go` | HTTP-Server: Upload, Ablage, Dekodierung (JSON-API) |
| `server/cardreader.go` | Fahrerkarte über PC/SC auslesen (EU 2016/799 Anhang 1C, Anlage 7) |
| `server/static/` | Web-Oberfläche (HTML/CSS/JS, ohne externe Abhängigkeiten); `rules.js` = Verstoß-Prüfung |
| `certs/` | öffentliche Schlüsselzertifikate der EU (ERCA) und Mitgliedstaaten (MSCA), Quelle: <https://dtc.jrc.ec.europa.eu/> |
| `Dockerfile` | baut den Server im Quellbaum von tachoparser (fester Commit) |

API: `GET /api/files`, `POST /api/files` (multipart, Feld `files`), `GET /api/files/{id}` (dekodiertes JSON), `GET /api/files/{id}?raw` (Original), `DELETE /api/files/{id}`, `POST /api/card/read` (Karte auslesen und speichern).

## Lizenz

GNU AGPL-3.0 – wie tachoparser, auf dem dieses Projekt aufbaut. Copyright CrashBandit82.
