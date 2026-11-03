# Saltello

Gioco 3D per iPhone come web app: corri, scatta e salta fino al traguardo raccogliendo le gemme.

- **Joystick** a sinistra (compare dove appoggi il pollice), **tasto grande** = salto (anche doppio), **tasto piccolo** = scatto (con ricarica).
- Dal computer: WASD/frecce, spazio = salto, Shift o K = scatto.
- Tutto in `public/` (Three.js r128 in `public/vendor/`, nessun build). Provarlo in locale: `cd public && python3 -m http.server`.

## Pubblicazione e aggiornamento automatico

Ogni push su `main` pubblica `public/` su GitHub Pages (`.github/workflows/pages.yml`). Il workflow scrive l'hash del commit nel meta `app-version` di `index.html` e in `version.json`: quando l'app torna in primo piano (o all'avvio) confronta le due versioni e, se diverse, si ricarica da sola (mai a partita in corso). Il service worker chiede sempre i file al server (`no-cache`) e usa la copia salvata solo offline.

## iOS

Niente zoom (viewport + `gesturestart`/doppio tap bloccati), niente selezione o menu del tocco lungo, pagina fissa senza rimbalzo, aree sicure (notch) rispettate, multitouch con Pointer Events (joystick e tasti insieme). Per il tutto schermo: Safari → Condividi → "Aggiungi alla schermata Home".
