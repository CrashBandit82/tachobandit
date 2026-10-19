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

Alle Zeiten werden in **UTC** angezeigt, so wie der Tachograf sie speichert.
Es gibt **keine** automatische Prüfung auf Lenk- und Ruhezeitverstöße.

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
- **Fahrerkarte**: Download im Fahrzeug über den Download-Key oder mit einem Chipkartenleser.

## Aufbau

| Pfad | Inhalt |
|---|---|
| `server/main.go` | HTTP-Server: Upload, Ablage, Dekodierung (JSON-API) |
| `server/static/` | Web-Oberfläche (HTML/CSS/JS, ohne externe Abhängigkeiten) |
| `certs/` | öffentliche Schlüsselzertifikate der EU (ERCA) und Mitgliedstaaten (MSCA), Quelle: <https://dtc.jrc.ec.europa.eu/> |
| `Dockerfile` | baut den Server im Quellbaum von tachoparser (fester Commit) |

API: `GET /api/files`, `POST /api/files` (multipart, Feld `files`), `GET /api/files/{id}` (dekodiertes JSON), `GET /api/files/{id}?raw` (Original), `DELETE /api/files/{id}`.

## Lizenz

GNU AGPL-3.0 – wie tachoparser, auf dem dieses Projekt aufbaut. Copyright CrashBandit82.
