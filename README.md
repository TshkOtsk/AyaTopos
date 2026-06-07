# AyaTopos MVP

AyaTopos is a research demo for mapping HypoWeave/KJ-method JSON into a continuous semantic/geographic space.

## Run

```powershell
cmd /c npm install
cmd /c npm run dev
```

Open the Vite URL shown by the web dev server. The API runs on `http://localhost:8787`.

PowerShell may block `npm.ps1`; use `cmd /c npm ...` on Windows.

## Environment

Copy `.env.example` to `.env` if you want to configure services.

- `VITE_MAP_STYLE_URL`: optional MapLibre style URL. If omitted, an OSM raster style is used.
- `GEMINI_API_KEY`: optional. If omitted, geographic placements use a deterministic fallback.
- `GEMINI_MODEL`: optional, defaults to `gemini-3.5-flash`.

## Demo Data

The sample HypoWeave JSON is expected at `apps/web/public/samples/minyo-nepal.json`.
