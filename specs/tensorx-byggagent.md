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
  om en körning redan pågår (`agent.lock`, skapat exklusivt; låsets mtime
  förnyas vid varje statusskrivning; ett lås utan livstecken på 10 min räknas
  som dött och tas över → annars 409). Svarar 202 direkt; loopen körs i
  `after()` (Next 15). `readModel` markerar en `running` utan livstecken på
  10 min som `failed` ("avbruten"), så sidan får en "försök igen"-knapp i
  stället för evig spinner om servern startat om mitt i.
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
     finishedAt, usage}` — skrivs efter varje steg (`step` är en etikett:
     "läser bilden", "skriver kod", "avvisar kod", "bygger", "rättar", "klar",
     "gav upp"; varvet visas separat). Läggs i `MODEL_FILES` och exponeras i
     `readModel()` som `agent`.
  6. **Kodkontroll före körning** (`checkCodeSafety`): bara `from build123d import …`
     och `import math` tillåts som importer; anrop som `open(`, `exec(`, `eval(`,
     `__import__(` och modulåtkomst som `os.`, `sys.`, `subprocess.`, `socket.`,
     `urllib.` avvisas. Avvisad kod räknas som ett misslyckat varv och skickas
     tillbaka till modellen med orsaken.
  7. Bygget körs som egen processgrupp med **minimal miljö** (PATH, HOME, TMPDIR,
     LANG/LC_*, UV_*) — inga API-nycklar ärvs. Timeout dödar hela gruppen
     (python + blender, inte bara uv). Lyckat = exit 0 **och** `modell.glb` har
     mtime efter körningens start — inte en textsträng modellens kod kan trycka.
- TensorX via `fetch` mot `${TENSORX_BASE_URL}/chat/completions` (OpenAI-format,
  `stream: false`, bild som `image_url`-data-URI, `max_tokens` 32000 — reasoning-tokens räknas som output, 16k kapade första svaret i test 1 — timeout 300 s).
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
  är kostnadsspärren. **Dev-servern binder bara 127.0.0.1** (`-H 127.0.0.1` i
  `npm run dev`) — Nexts default är 0.0.0.0, vilket hade gett alla på labbets
  wifi tillgång till båda endpoints.
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

Filsystem: `public/models/<id>/agent.json` + `agent.lock`; i `build123d-tests`:
`parts/agent_<id>.py`, `ref/agent_<id>_spec.md`, `out/agent_<id>_varv<n>.md` —
gitignorerade där (`parts/agent_*`, `ref/agent_*`; `out/` var det redan).

## Säkerhet

- Nyckeln bara server-side. `.env.local` gitignorerad; `.env.example` får `TENSORX_API_KEY=`.
- `id` validerat med `isValidId` innan det används i filnamn på båda sidor.
  `BUILD123D_DIR` löses med `path.resolve` en gång vid start.
- Modellens kod skrivs bara till `parts/agent_<id>.py` och körs bara via
  `build.py` (som importerar den). Att köra LLM-skriven kod är **avsikten**
  (det är vad en byggagent gör) — därför lokal demo, aldrig deploy. Men koden
  körs (a) efter import-allowlist/denylist, (b) utan API-nycklar i miljön,
  (c) i egen processgrupp med timeout, (d) bara nåbar från localhost.
- **Injektionskanaler**: `userPrompt` (publik, ≤ 400 tecken, interpoleras i
  prompten) och bilden. En instruktion i `userPrompt` kan få modellen att
  skriva vad som helst i `del.py` — det är därför kodkontrollen finns. Med
  (a)–(d) är utfallet av en lyckad injektion en konstig lampa, ett avvisat
  varv eller ett byggfel; inte nycklar på väg ut och inte kod som når nätet.
  Kvarstående risk: allt som build123d/OCCT själva kan göra med filsystemet
  under `BUILD123D_DIR` — accepterat för en demo-Mac.
- `agent.json` valideras vid inläsning (form + längdtak på loggen) så en
  trasig fil inte fäller `/api/models`.
- Kostnad: max 3 varv × 32k output-tokens, en körning per modell åt gången.

## Testplan

1. `node --test`: `parseAgentReply` (två block, bara `del.py` vid rättning,
   inget block → fel), `withForcedName` (NAMN-raden ersätts), loopen med
   injicerad fejkmodell + fejkbygg: (a) lyckas i varv 1 → `done`, `publish`
   anropad en gång; (b) fel i varv 1, ok i varv 2 → `done`, `round: 2`,
   feedbacken innehåller byggutskriften; (c) fel × 3 → `failed`, ingen publish;
   (d) kod med `import os`/`open(` → avvisas utan att `runBuild` anropas,
   feedbacken namnger raden; (e) `markStale`: running utan livstecken på 10 min →
   failed; (f) `childEnv` släpper inte igenom `TENSORX_API_KEY`;
   (g) `buildSucceeded` kräver GLB-mtime efter start.
2. `POST /api/models/finns-inte/build` → 404. `POST /api/models/A_B/build` → 400.
   Två `POST` i rad på samma id → 202 sedan 409.
3. Riktig körning mot TensorX på `lampa-20260828-142604` (den koniska): `agent.json`
   går `running → done`, `modell.glb` finns, sidan visar modellen. Loggen
   sparas som bevis i PR:en.
4. `npm run build` ✓ (kör inte medan dev-servern är igång).
