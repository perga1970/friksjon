# Friksjonsmåler vintervei – installasjon

Appen er en web-app (PWA). Den må ligge på en **https-adresse** for at telefonen skal gi tilgang til akselerometer, gyroskop og GPS.

## 1. Legg filene på nett (gratis, GitHub Pages)
1. Lag en gratis konto på https://github.com
2. Trykk **+ → New repository**, gi det navnet `friksjon`, velg **Public**, trykk **Create repository**.
3. Trykk **uploading an existing file** og dra inn ALLE filene fra denne mappen
   (index.html, app.js, core.js, sw.js, manifest.webmanifest, icon-192.png, icon-512.png). Trykk **Commit changes**.
4. Gå til **Settings → Pages**. Under «Branch» velger du **main** og **/(root)**, trykk **Save**.
5. Etter 1–2 minutter er appen på `https://DITTBRUKERNAVN.github.io/friksjon/`

## 2. Installer på telefonen
**iPhone (Safari):** Åpne adressen i Safari → Del-knappen (□↑) → **Legg til på Hjem-skjerm** → Legg til.
**Android (Chrome):** Åpne adressen i Chrome → meny ⋮ → **Installer app** / **Legg til på startskjermen**.

Åpne appen fra ikonet, trykk **Start sensorer** og tillat bevegelse og posisjon (velg «presis posisjon»).
Test gjerne først med **Innstillinger → Kjør simulert bremsetest**.

## Tips
- Appen må være åpen og skjermen på under kjøring (den holder skjermen våken selv).
- Målinger lagres på telefonen. Eksporter via Logg → CSV/GeoJSON.
- Oppdatere appen: last opp nye filer til GitHub, lukk og åpne appen to ganger.
