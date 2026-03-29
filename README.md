# PyTutor 🐍

Interaktiver Python-Tutor als Progressive Web App – läuft im Browser,
funktioniert offline und lässt sich auf dem Handy wie eine App installieren.

---

## Einmalige Einrichtung

### Schritt 1 – GitHub Account
Gehe auf **github.com** und erstelle einen kostenlosen Account, falls noch keiner vorhanden ist.

### Schritt 2 – Repository erstellen
1. Oben rechts auf **+** klicken → „New repository"
2. Name: `pytutor`
3. Sichtbarkeit: **Public** stellen
4. **Kein Häkchen** bei „Add a README file"
5. Klick auf „Create repository"

### Schritt 3 – Terminal in VS Code öffnen
`Strg + J` drücken (oder Menü → Terminal → New Terminal)

### Schritt 4 – Befehle nacheinander eingeben

```bash
git init
git add .
git commit -m "PyTutor erste Version"
git branch -M main
git remote add origin https://github.com/DEINNAME/pytutor.git
git push -u origin main
```

> **DEINNAME** durch deinen GitHub-Benutzernamen ersetzen.
> Die genaue URL findest du auf der Seite deines neu erstellten Repositories.

### Schritt 5 – GitHub Pages aktivieren
1. Auf github.com in dein Repository gehen
2. Klick auf **Settings** (Zahnrad-Tab, ganz rechts)
3. Im linken Menü: **Pages**
4. Unter „Build and deployment" → Source: **GitHub Actions** auswählen
5. **Save** klicken

### Schritt 6 – Warten bis der grüne Haken erscheint
1. Klick auf den Tab **Actions** in deinem Repository
2. Ein laufender Workflow zeigt einen gelben Kreis ⏳
3. Nach ca. 1 Minute erscheint ein grüner Haken ✅
4. Bei rotem ✗ → auf den Eintrag klicken für Fehlermeldung

### Schritt 7 – App aufrufen
```
https://DEINNAME.github.io/pytutor
```
*(Die genaue URL steht auch unter Settings → Pages)*

---

## App auf dem Handy installieren

### Android (Chrome)
1. Die URL oben in **Chrome** auf deinem Android-Handy öffnen
2. Auf die **drei Punkte** (⋮) oben rechts tippen
3. „**Zum Startbildschirm hinzufügen**" tippen
4. Namen bestätigen → **Hinzufügen**
5. ✅ Das PyTutor-Icon erscheint auf deinem Homescreen

### iPhone (Safari)
1. Die URL in **Safari** öffnen (nicht Chrome – nur Safari unterstützt die Installation auf iOS)
2. Auf den **Teilen-Button** tippen (Kasten mit Pfeil nach oben, unten in der Mitte)
3. Nach unten scrollen → „**Zum Home-Bildschirm**" tippen
4. Namen bestätigen → **Hinzufügen**
5. ✅ Das PyTutor-Icon erscheint auf deinem Homescreen

---

## Nach jedem Update – App aktualisieren

Wenn du Änderungen in VS Code gemacht hast, gibst du diese drei Befehle ins Terminal ein:

```bash
git add .
git commit -m "kurze Beschreibung was du geändert hast"
git push
```

GitHub Actions startet automatisch, deployt die neue Version, und nach ca. 1 Minute
ist die App auf dem Handy beim nächsten Öffnen aktuell.

> **Cache leeren nach Update:** Wenn das Handy noch die alte Version zeigt,
> in `sw.js` die Zahl hochzählen: `pytutor-v1` → `pytutor-v2`.
> Dann werden alle gecachten Dateien automatisch neu geladen.

---

## Icons erstellen (einmalig)

1. `pytutor/create-icons.html` im Browser öffnen
2. Beide Icons herunterladen
3. Ordner `pytutor/icons/` erstellen
4. Beide Dateien dort ablegen: `icons/icon-192.png` und `icons/icon-512.png`
5. Committen und pushen (siehe „Nach jedem Update")

---

## Projektstruktur

```
pytutor/
├── index.html            App-Shell (HTML-Gerüst)
├── app.js                Gesamte App-Logik
├── style.css             Dark-Theme Styles
├── manifest.json         PWA-Manifest (Name, Farben, Icons)
├── sw.js                 Service Worker (Offline-Cache)
├── progress.json         Fortschritts-Template
├── create-icons.html     Icon-Generator (einmalig nutzen)
└── exercises/
    └── lab01.json        Aufgaben Lab 01 – Functions & Control

.github/
└── workflows/
    └── deploy.yml        Automatisches Deployment auf GitHub Pages
```
