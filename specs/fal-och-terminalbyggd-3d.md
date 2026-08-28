# fal.ai-bild + terminalbyggd 3D-modell

Fork av `frejandreassen/luminovo-website` för AI-labbet i Falkenberg. Sajten
visades på webinaret 2025; nu visar vi samma sajt igen men med nästa steg.

## Mål

Användaren skriver en lampidé → fal.ai gör en bild → Claude Code i terminalen
bygger en **måttsatt** build123d-modell → modellen dyker upp i sajten som en
roterbar 3D-vy (och AR på iPhone) utan att någon laddar upp något manuellt.

## Scope

- `POST /api/generate-lampshade`: byt Gemini-bild → fal.ai Seedream v5 lite
  via `fetch` mot `https://fal.run/<modell>` (ingen ny npm-dependency). Fast
  promptmall i stället för Gemini-promptoptimering.
- Varje generering sparas som `public/models/<id>/bild.jpg` + `meta.json`
  (id, användarens text, hela prompten, modell-id, tidsstämpel).
- `GET /api/models` (lista, nyaste först) och `GET /api/models/<id>`
  (vilka filer som finns + `spec.md`-text).
- Hero-komponenten: visar bilden, pollar `/api/models/<id>` var 3:e sekund
  tills `modell.glb` finns, visar då `<model-viewer>` (GLB, `ios-src` USDZ, AR).
  Vid sidladdning visas senaste modellen automatiskt.
- Ta bort Meshy-kedjan: `/api/isolate-lamp`, `/api/convert-to-3d`,
  `/api/proxy-glb`, `src/lib/meshy-client.ts`, `MESHY_INTEGRATION.md`,
  den oanvända `src/components/lamp-designer.tsx`.
- `.env.example` med `FAL_API_KEY=`; README-avsnitt om demo-arkitekturen.
- I `build123d-tests/tools/build.py`: flagga `--publish <mapp>` som lägger
  `modell.glb`, `modell.usdz`, `preview.png`, `del.py` (och `--spec` → `spec.md`)
  i modellmappen.

## Utanför scope

- Deploy. Detta är en **lokal demo-arkitektur**: servern skriver till
  `public/` i runtime, vilket inte fungerar på Vercel. Körs med `npm run dev`.
- Auth. Sajten var publik utan auth förut och körs bara lokalt nu.
- Gemini i `/api/estimate-price` (`gemini-pricing.ts`) rörs inte;
  `@google/genai` ligger kvar som dependency av den anledningen.
- Automatisk 3D-generering på servern (Agent SDK). Terminalen är poängen.
- Beställningsformulär, nyhetsbrev, galleri — orörda.

## Berörd yta — alla endpoints efter ändringen

| Endpoint | Metod | Auth | Ändring |
|---|---|---|---|
| `/api/generate-lampshade` | POST | public — lokal demo, ingen auth i appen sedan tidigare | omskriven (fal) |
| `/api/models` | GET | public — läser bara `public/models/`, samma data som redan är statiskt servad | ny |
| `/api/models/[id]` | GET | public — dito; `id` valideras mot `^[a-z0-9-]{3,64}$` (ingen path traversal) | ny |
| `/api/estimate-price` | POST | public — oförändrad | — |
| `/api/orders` | POST | public — oförändrad | — |
| `/api/newsletter` | POST | public — oförändrad | — |
| `/api/isolate-lamp` | — | — | **borttagen** |
| `/api/convert-to-3d` | — | — | **borttagen** |
| `/api/proxy-glb` | — | — | **borttagen** (var en öppen SSRF-proxy mot valfri URL) |

## Datändringar

Inga tabeller. Filsystem: `public/models/<id>/` (gitignorerad, `.gitkeep` kvar).

## Säkerhet

- `FAL_API_KEY` bara server-side (route handler), aldrig i klientkod. `.env*` är
  redan gitignorerat; `.env.example` med tomt värde committas.
- Input: `userPrompt` valideras server-side (sträng, 2–400 tecken) innan
  den läggs i promptmallen. `id` i `/api/models/[id]` valideras med regex
  och mappen slås upp med `path.join` + kontroll att den ligger under
  `public/models`.
- Filer i modellmappen serveras bara om namnet är i en allowlist
  (`bild.jpg`, `modell.glb`, `modell.usdz`, `preview.png`, `spec.md`, `del.py`,
  `meta.json`) — vi listar aldrig godtyckliga filer.
- Felsvar till klienten är generiska; fal:s felkropp loggas bara server-side.
- Borttagningen av `/api/proxy-glb` stänger en SSRF-yta.
- Ingen ny dependency; lockfilen rörs inte.

## Testplan

1. `node --test` på `src/lib/lamp-pipeline.ts`: id-validering (`../x` → false,
   `lampa-20260828-1400` → true), promptmall innehåller användartexten och
   E27-kravet, fal-svar utan `images` → tydligt fel.
2. Dev-server igång: `POST /api/generate-lampshade {"userPrompt":"spjälor"}`
   → 200 med `{id, image}`, och `public/models/<id>/bild.jpg` + `meta.json` finns.
3. `POST /api/generate-lampshade {}` → 400. `{"userPrompt":"x"}` → 400.
4. `GET /api/models/../../etc` → 400. `GET /api/models/finns-inte` → 404.
5. `GET /api/models/<id>` → `glb: false`; kör
   `uv run python tools/build.py parts/lampa_spjala.py --publish ../luminovo-website/public/models/<id> --spec ref/lampa_spec.md`
   → `GET` igen → `glb: true`, och sidan visar `<model-viewer>` utan reload.
6. `npm run build` går igenom (även om vi kör dev på scen).
7. Gamla routes: `GET /api/proxy-glb?url=…` → 404.
