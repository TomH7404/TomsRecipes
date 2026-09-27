# Rezepte – MVP

Persönliches Rezeptbuch als PWA. Keine Abhängigkeiten, kein Build-Schritt.

## Enthalten (MVP laut Spezifikation)
- Rezept anlegen: Titel (Pflicht), 1 Foto (wird auf max. 1600 px / JPEG verkleinert), Portionen, Zutaten, Schritte
- Portionen-Skalierung mit sinnvoller Rundung (Stück auf ½, Löffel auf ¼, Prisen ganzzahlig, g/ml gestuft, g↔kg und ml↔l automatisch)
- Liste & Suche (Titel und Zutaten)
- Teilen über das iOS-Teilen-Menü – als Text oder mit Foto, immer in der zuletzt gewählten Portionenzahl
- Backup als eine JSON-Datei (inkl. Fotos) + Import mit Zusammenführen; Hinweis in der Übersicht, wenn seit 7 Tagen kein Backup trotz Änderungen

Das Datenmodell enthält die Phase-2-Felder (Quelle, Ort, Bewertung, Tags, Küche, Art, Notizen) bereits, und Fotos liegen als Liste – mehrere Fotos brauchen später keine Migration.

## Zutaten-Eingabe
Eine Zutat pro Zeile, Menge zuerst: `200 g Mehl`, `2 Eier`, `1/2 TL Salz`, `1,5 l Milch`, `2-3 Zehen Knoblauch`, `Salz, Pfeffer`.
Zeile mit Doppelpunkt am Ende = Zwischenüberschrift (`Für die Sauce:`).

## Auf GitHub Pages veröffentlichen
1. Neues Repository anlegen (z. B. `rezepte`), alle Dateien dieses Ordners hochladen (alle liegen auf einer Ebene, kein Unterordner – geht daher auch vom iPhone aus).
2. Settings → Pages → Branch `main`, Ordner `/ (root)` → Save.
3. Auf dem iPhone die Pages-URL in Safari öffnen → Teilen → „Zum Home-Bildschirm“.

Wichtig: Die App vom Home-Bildschirm aus nutzen. Nur so gilt der Speicher als App-Speicher und wird von iOS nicht nach Wochen ohne Nutzung geleert.

## Updates
Nach Änderungen an den Dateien in `sw.js` die `VERSION` hochzählen.

## Gerätewechsel
Altes Handy: Backup → „Backup erstellen“ → „In Dateien sichern“ → iCloud Drive.
Neues Handy: App installieren → Backup → „Backup-Datei auswählen“.
