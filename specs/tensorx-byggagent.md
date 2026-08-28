# TensorX-byggagent — modellen byggs i appen

Bygger vidare på `fal-och-terminalbyggd-3d.md`. Steget som Claude Code gör i
terminalen (läs bilden → skriv måttspec + build123d-kod → bygg → titta →
rätta → publicera) görs av en billig EU-hostad modell via TensorX, startad
från sajten. Demot visar båda: terminalen (generell agent) och loopen i appen
(specialiserad, ~1–2 öre per lampa).

## Mål

Användaren klickar "Bygg modellen" under bilden. Sidan visar stegen live
("läser bilden", "skriver kod", "bygger", "rättar 2/3") och modellen dyker upp
i `<model-viewer>` som förut. Misslyckas loopen visas loggen och terminalen
får ta över — inget annat ändras.

## Scope

- `POST /api/models/[id]/build`: validerar id, kräver att bilden finns, nekar
  om en körning redan pågår (`agent.json` state `running` yngre än 10 min →
  409). Svarar 202 direkt; loopen körs i `after()` (Next 15).
- `src/lib/lamp-agent.ts`: loopen. Beroenden (modellanrop, byggkörning,
  filskrivning) injiceras så den går att testa utan nät och utan Python.
  1. Bilden (base64) + systemprompt: konventionerna ur `build123d-tests/CLAUDE.md`,
     printkonstanterna, en build123d-lathund, `parts/demo_konsol.py` och
     `parts/lampa_konisk.py` som exempel. Svar = `### spec.md` + `### del.py`
     med fenced-block. **Ingen tool-calling** — servern kör bygget.
  2. Skriver `BUILD123D_DIR/ref/agent_<id>_spec.md` och `BUILD123D_DIR/parts/agent_<id>.py`
     (modellens `NAMN`-rad ersätts med `agent_<id>` så outputfilerna är förutsägbara).
  3. `uv run python tools/build.py parts/agent_<id>.py --publish <modellmapp> --spec <spec>`
     med `cwd = BUILD123D_DIR`, timeout 180 s.
  4. Vid fel (exit ≠ 0) eller varning: valideringsutskrift + traceback-svans +
     `out/agent_<id>_preview.png` (om den finns) skickas tillbaka → modellen
     rättar → max 3 varv totalt. Lyckat bygge utan `FEL` = klart (varningar
     rapporteras men stoppar inte).
  5. `public/models/<id>/agent.json`: `{state, step, round, model, log[], startedAt,
     finishedAt, usage}` — skrivs efter varje steg. Läggs i `MODEL_FILES` och
     exponeras i `readModel()` som `agent`.
- TensorX via `fetch` mot `${TENSORX_BASE_URL}/chat/completions` (OpenAI-format,
  `stream: false`, bild som `image_url`-data-URI, `max_tokens` 16000, timeout 240 s).
  `reasoning_content` i svaret ignoreras. Ingen `enable_thinking: false`
  (knowledge-worker: det flyttar tankekedjan in i `content`).
- Env: `TENSORX_API_KEY`, `TENSORX_BASE_URL` (default `https://api.tensorx.ai/v1`),
  `TENSORX_MODEL` (default `z-ai/glm-5.3-flash`), `BUILD123D_DIR`
  (default `../build123d-tests`).
- Hero: knapp "Bygg modellen (GLM 5.3 Flash · EU)" när GLB saknas och ingen
  körning pågår; stegvisning medan den kör; logg + "terminalen tar över" vid
  misslyckande. Pollen jämför även `agent.json`.
- `.env.example` uppdaterad; README-avsnitt; tester.

## Utanför scope

- Auth / rate limit — lokal demo (som förut). En körning per modell åt gången
  är kostnadsspärren.
- Streaming av modellens text till sidan. Stegen räcker.
- Att göra loopen generell (andra objekt än lampskärmar). Prompten är lampspecifik.
- Deploy. **Loopen kör kod som en språkmodell skrivit, lokalt, med dina
  rättigheter** — exakt som Claude Code i terminalen gör, men utan människa i
  loopen. Det är acceptabelt på en demo-Mac och ingen annanstans.

## Berörd yta — alla endpoints efter ändringen

| Endpoint | Metod | Auth | Ändring |
|---|---|---|---|
| `/api/models/[id]/build` | POST | public — lokal demo; id-regex, 409 vid pågående körning, 404 utan bild | ny |
| `/api/models/[id]` | GET | public — nu även `agent` ur `agent.json` | ändrad |
| `/api/models` | GET | public | — |
| `/api/generate-lampshade` | POST | public | — |
| `/api/estimate-price` | POST | public | — |
| `/api/orders`, `/api/newsletter` | POST | public — ärvt, orört | — |

## Datändringar

Filsystem: `public/models/<id>/agent.json`; `build123d-tests/{ref,parts}/agent_<id>*`
(gitignoreras i det repot? — nej: `parts/` är källa, men agentfiler får prefixet
`agent_` så de går att städa; `build123d-tests` har ingen egen `.gitignore`-regel
för dem, det får Paul avgöra).

## Säkerhet

- Nyckeln bara server-side. `.env.local` gitignorerad; `.env.example` får `TENSORX_API_KEY=`.
- `id` validerat med `isValidId` innan det används i filnamn på båda sidor.
  `BUILD123D_DIR` löses med `path.resolve` en gång vid start.
- Modellens kod skrivs bara till `parts/agent_<id>.py` och körs bara via
  `build.py` (som importerar den). Godtycklig kodkörning är **avsikten**
  (det är vad en byggagent gör) — därför lokal demo, aldrig deploy.
- Promptinjektion via bilden: modellen ser bara en bild av en lampa; utfallet
  är på sin höjd en konstig lampa eller ett byggfel. Ingen data den kan läcka.
- `agent.json` valideras vid inläsning (form + längdtak på loggen) så en
  trasig fil inte fäller `/api/models`.
- Kostnad: max 3 varv × 16k output-tokens, en körning per modell åt gången.

## Testplan

1. `node --test`: `parseAgentReply` (två block, bara `del.py` vid rättning,
   inget block → fel), `withForcedName` (NAMN-raden ersätts), loopen med
   injicerad fejkmodell + fejkbygg: (a) lyckas i varv 1 → `done`, `publish`
   anropad en gång; (b) fel i varv 1, ok i varv 2 → `done`, `round: 2`,
   feedbacken innehåller byggutskriften; (c) fel × 3 → `failed`, ingen publish.
2. `POST /api/models/finns-inte/build` → 404. `POST /api/models/A_B/build` → 400.
   Två `POST` i rad på samma id → 202 sedan 409.
3. Riktig körning mot TensorX på `lampa-20260828-142604` (den koniska): `agent.json`
   går `running → done`, `modell.glb` finns, sidan visar modellen. Loggen
   sparas som bevis i PR:en.
4. `npm run build` ✓ (kör inte medan dev-servern är igång).
