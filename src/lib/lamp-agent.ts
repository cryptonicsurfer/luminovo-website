/**
 * Byggagenten: gör i appen det Claude Code gör i terminalen.
 *
 *   bild → spec.md + del.py → build.py --publish → (fel? preview + utskrift tillbaka) → max 3 varv
 *
 * Modellen får INGA verktyg. Den svarar med text (två fenced-block) och
 * servern kör bygget. Alla yttre beroenden (modellanrop, byggkörning,
 * statusfil) injiceras via `AgentDeps` så loopen testas utan nät och Python.
 *
 * Kör kod som en språkmodell skrivit, lokalt, med dina rättigheter — precis
 * som terminalen, men utan människa i loopen. Lokal demo, aldrig deploy.
 */
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import {
  MODEL_FILES, STALE_RUN_MS, LIVE_CONTENT_MAX, LIVE_TAIL_MAX,
  type AgentStatus, type AgentLogEntry, type AgentLive, isValidId, modelDir, readModel, readModelImage, readModelSkeleton,
} from './lamp-pipeline.ts';

export const MAX_ROUNDS = 3;
export const DEFAULT_TENSORX_MODEL = 'z-ai/glm-5.3-flash';
export const DEFAULT_TENSORX_BASE_URL = 'https://api.tensorx.ai/v1';
export const BUILD_TIMEOUT_MS = 180_000;
/**
 * Reasoning-modeller är verbosa by default och reasoning räknas som output.
 * Princip (Paul 2026-08-28): kör alltid det max modellen tillåter och bygg
 * appen runt det. TensorX klipper inte max_tokens (2M accepteras tyst), så
 * taket är kontextfönstret; vi lämnar 64k till prompten. Ett långt anrop kan
 * ta 20+ min → generös timeout + hjärtslag i statusfilen.
 */
export const MODEL_TIMEOUT_MS = 45 * 60_000;
export const PROMPT_HEADROOM_TOKENS = 64_000;
export const MODEL_CONTEXT: Record<string, number> = {
  'z-ai/glm-5.3-flash': 1_048_576,
  'qwen/qwen3.8-flash-next': 262_144,
};
export const DEFAULT_CONTEXT = 262_144;
export function maxOutputTokens(model: string, override?: string): number {
  const o = Number(override);
  if (override && Number.isFinite(o) && o > 0) return Math.floor(o);
  return (MODEL_CONTEXT[model] ?? DEFAULT_CONTEXT) - PROMPT_HEADROOM_TOKENS;
}
export const HEARTBEAT_MS = 30_000;
export { STALE_RUN_MS };

// ---------- meddelandetyper (OpenAI-format) ----------
export type ContentPart = { type: 'text'; text: string } | { type: 'image_url'; image_url: { url: string } };
export interface ChatMessage { role: 'system' | 'user' | 'assistant'; content: string | ContentPart[] }

export interface ModelReply { text: string; usage?: { input: number; output: number }; finishReason?: string; reasoningChars?: number }
export type OnProgress = (p: AgentLive) => void;
export interface BuildResult { ok: boolean; output: string; previewB64?: string }

export interface AgentDeps {
  callModel(messages: ChatMessage[], onProgress?: OnProgress): Promise<ModelReply>;
  /** Hjärtslagsintervall under modellanrop (test sätter lågt). */
  heartbeatMs?: number;
  /** Minsta tid mellan två live-skrivningar till agent.json (test sätter 0). */
  liveThrottleMs?: number;
  runBuild(id: string, code: string, spec: string): Promise<BuildResult>;
  writeStatus(id: string, status: AgentStatus): Promise<void>;
  /** Valfritt: spara modellens råa svar per varv (för felsökning och för att visa på scen). */
  saveReply?(id: string, round: number, text: string): Promise<void>;
  model: string;
  now?: () => Date;
}

export interface AgentInput {
  id: string;
  userPrompt: string;
  image: { base64: string; mimeType: string };
  /** Isolerad printbar del (skelett.jpg) om isoleringssteget lyckades. */
  skeleton?: { base64: string; mimeType: string } | null;
  examples: { name: string; code: string }[];
}

// ---------- rena hjälpare ----------

/** Plockar ut `### spec.md` / `### del.py` + fenced-block. Fallback: första ```python resp. ```markdown. */
export function parseAgentReply(text: string): { spec?: string; code?: string } {
  const afterHeading = (heading: RegExp): string | undefined => {
    const m = heading.exec(text);
    if (!m) return undefined;
    const rest = text.slice(m.index + m[0].length);
    const fence = /```[a-zA-Z]*\r?\n([\s\S]*?)\r?\n```/.exec(rest);
    return fence ? fence[1] : undefined;
  };
  const byLang = (lang: RegExp): string | undefined => {
    const m = new RegExp('```(?:' + lang.source + ')\\r?\\n([\\s\\S]*?)\\r?\\n```').exec(text);
    return m ? m[1] : undefined;
  };
  const code = afterHeading(/#{1,4}\s*`?del\.py`?/i) ?? byLang(/python|py/);
  const spec = afterHeading(/#{1,4}\s*`?spec\.md`?/i) ?? byLang(/markdown|md/);
  return { spec: spec?.trim() ? spec.trimEnd() + '\n' : undefined, code: code?.trim() ? code.trimEnd() + '\n' : undefined };
}

/**
 * Modellens kod körs lokalt. userPrompt är en publik injektionskanal
 * (POST /api/generate-lampshade → meta.json → prompten), så koden får bara
 * använda build123d och math — allt annat avvisas innan den körs.
 */
const ALLOWED_IMPORT = /^\s*(from\s+build123d\s+import\s+[\w*,\s]+|import\s+math|from\s+math\s+import\s+[\w,\s]+)\s*(#.*)?$/;
const FORBIDDEN_CALLS = /\b(__import__|exec|eval|compile|open|getattr|setattr|globals|locals|vars|breakpoint|input|__builtins__)\s*\(/;
const FORBIDDEN_MODULES = /\b(os|sys|subprocess|socket|urllib|requests|shutil|pathlib|importlib|ctypes|http|ftplib|smtplib|pickle|marshal|builtins|signal|threading|multiprocessing)\s*\./;

export function checkCodeSafety(code: string): string[] {
  const problems: string[] = [];
  code.split('\n').forEach((line, i) => {
    const n = i + 1;
    if (/^\s*(import|from)\s/.test(line) && !ALLOWED_IMPORT.test(line)) problems.push(`rad ${n}: otillåten import — bara \`from build123d import *\` och \`import math\` är tillåtna`);
    const c = FORBIDDEN_CALLS.exec(line);
    if (c) problems.push(`rad ${n}: \`${c[1]}(\` är inte tillåtet`);
    const m = FORBIDDEN_MODULES.exec(line);
    if (m) problems.push(`rad ${n}: \`${m[1]}.\` är inte tillåtet`);
    if (/__builtins__|__class__|__subclasses__|__globals__/.test(line)) problems.push(`rad ${n}: dunder-åtkomst är inte tillåten`);
  });
  return problems;
}

/** Byter ut modellens NAMN-rad så outputfilerna heter som vi bestämt. */
export function withForcedName(code: string, name: string): string {
  const kept = code.split('\n').filter((l) => !/^\s*NAMN\s*=/.test(l));
  return kept.join('\n').trimEnd() + `\n\nNAMN = "${name}"\n`;
}

export function agentPartName(id: string): string {
  return `agent_${id}`;
}

const CHEAT_SHEET = `
KONVENTIONER (samma som build123d-tests/CLAUDE.md):
- Enhet millimeter. Origin i bottencentrum, +Z uppåt. Delen ska stå printbart som den är.
- ALLA mått som namngivna konstanter högst upp, varje med kommentar "# spec rad N".
- Filen definierar \`part\` (build123d-objektet). Sätt INTE NAMN — det gör servern.
- Fillets via fillet(), aldrig manuellt modellerad rundning.
- Printkonstanter: bädd 250 × 210 × 220 mm (Z ≤ 220!), minsta vägg 0.8 mm, inga stöd.
  Lampskärm: max 40 cm hög (i praktiken ≤ 210 pga bädden), E27-hål 40.5 mm centrerat i bottenplattan.
- Bara den printade delen: ingen glödlampa, ingen frostad innerskärm, ingen möbel.
- EN SAMMANHÄNGANDE KROPP: varje ring/stav/gitterelement måste överlappa något annat
  som i sin tur når bottenplattan. Svävande ringar = "N LOSA KROPPAR" = fel. Låt stavar
  gå genom ringarna (överlappa 1–2 mm), inte bara nudda dem.
- SKÄRMEN ÄR ETT ÖPPET RAMVERK: stavar, spjälor, ringar, gitter — med stora öppningar som
  ljuset går rakt igenom och med tomt utrymme i mitten för glödlampan (Ø ≥ 70 mm fritt
  kring axeln ovanför bottenplattan). Stavar 2–4 mm. Aldrig en massiv kropp, aldrig ett
  tätt skal, aldrig lameller från ett nav. Riktvärde: volymen under 15 % av den omslutande
  cylindern — en spjälbur landar runt 7 %. En massiv del avvisas och skickas tillbaka.

BUILD123D-LATHUND (0.11):
  from build123d import *
  with BuildPart() as b:
      Cylinder(radie, hojd, align=(Align.CENTER, Align.CENTER, Align.MIN))   # står på Z=0
      Box(x, y, z, align=(Align.CENTER, Align.CENTER, Align.MIN))
      Hole(radius=r)                                    # genomgående hål i Z genom senaste solid
      with BuildSketch(Plane.XY.offset(z)):             # skiss på höjd z
          Circle(r); Circle(r2, mode=Mode.SUBTRACT)     # ring
          with PolarLocations(radie, antal): Circle(r)  # cirkel av punkter
      extrude(amount=h)
      fillet(b.edges().group_by(Axis.Z)[-1], radius=r)  # översta kanterna
      with PolarLocations(0, antal): add(solid)         # roterade kopior av en färdig solid
  solid = Cylinder(r, L, align=(..., Align.MIN)).rotate(Axis.Y, grader).moved(Location((x, y, z)))
  part = b.part
  Undvik: loft med flera profiler per skiss, sweep längs komplexa banor, text, gängor. Håll geometrin
  rotationssymmetrisk och hårdytad — det är där bygget lyckas.
  p.is_valid är en property, inte metod.

SVARSFORMAT — exakt så här, inget annat:
### spec.md
\`\`\`markdown
# Kravspec — <namn>
| Rad | Mått | Värde | Kommentar |
|---|---|---|---|
| 1 | ... | ... | ... |
## Antaganden
- ...
\`\`\`
### del.py
\`\`\`python
"""<en rad om delen>"""
from build123d import *
# --- MATT (mm) ---
...
part = b.part
\`\`\`
`;

export function buildSystemPrompt(examples: { name: string; code: string }[]): string {
  const ex = examples.map((e) => `--- ${e.name} ---\n${e.code.trim()}`).join('\n\n');
  return (
    'Du är en CAD-ingenjör som skriver parametriska, 3D-printbara delar i build123d (Python). ' +
    'Du får en bild av en bordslampskärm och ska (1) läsa av dess form och uppskatta måtten, ' +
    '(2) skriva en kravspec med numrerade rader, (3) skriva en build123d-fil där varje konstant pekar på en spec-rad. ' +
    'Servern bygger, validerar och renderar delen och skickar tillbaka utskriften och en rendering. ' +
    'Får du ett fel eller en rendering som inte stämmer med bilden: rätta och svara igen i samma format. ' +
    'Var konkret och kort. Ingen prosa utanför blocken.\n' +
    CHEAT_SHEET +
    (ex ? `\nEXEMPEL PÅ FÄRDIGA DELAR I SAMMA STIL:\n\n${ex}\n` : '')
  );
}

export function buildFirstMessage(input: AgentInput): ChatMessage {
  const parts: ContentPart[] = [
    {
      type: 'text',
      text:
        (input.skeleton
          ? 'Bild 1: produktfoto av lampan i miljö. Bild 2: BARA den printade delen, isolerad — utgå från bild 2 för formen, bild 1 för sammanhanget. '
          : 'Referensbild på lampskärmen. ') +
        `Kundens önskan: "${input.userPrompt}". ` +
        'Skriv spec.md och del.py enligt formatet. Uppskatta proportionerna ur bilden; ' +
        'total höjd ≤ 210 mm, bredd ≤ 200 mm. Ange antalet spjälor/element genom att räkna i bilden.',
    },
    { type: 'image_url', image_url: { url: `data:${input.image.mimeType};base64,${input.image.base64}` } },
  ];
  if (input.skeleton) parts.push({ type: 'image_url', image_url: { url: `data:${input.skeleton.mimeType};base64,${input.skeleton.base64}` } });
  return { role: 'user', content: parts };
}

export function buildFeedbackMessage(result: BuildResult, round: number): ChatMessage {
  const parts: ContentPart[] = [
    {
      type: 'text',
      text:
        `Varv ${round}: bygget ${result.ok ? 'gick igenom' : 'MISSLYCKADES'}. Utskrift:\n\`\`\`\n${result.output.trim()}\n\`\`\`\n` +
        (result.previewB64
          ? 'Här är renderingen (FRAMIFRÅN, SIDA, PERSPEKTIV). Jämför med referensbilden. '
          : 'Ingen rendering kunde göras (koden kraschade innan bygget). ') +
        'Rätta felet och svara med ### del.py (och ### spec.md om måtten ändras).',
    },
  ];
  if (result.previewB64) parts.push({ type: 'image_url', image_url: { url: `data:image/png;base64,${result.previewB64}` } });
  return { role: 'user', content: parts };
}

/**
 * Lampspecifik rimlighetskontroll på build.py-utskriften: en skärm som fyller
 * mer än MAX_FILL av sin omslutande box är massiv — ser rätt ut utifrån men
 * släpper inte ut ljus och väger ett kilo. Returnerar ett felmeddelande eller null.
 */
export const MAX_FILL = 0.15;   // andel av omslutande cylinder; uppmätt: massiv trumma 0.31–0.38, ihåliga skärmar 0.07–0.10
export function solidityProblem(output: string): string | null {
  const m = /matt:\s*([\d.]+)\s*x\s*([\d.]+)\s*x\s*([\d.]+)\s*mm/.exec(output);
  const v = /volym:\s*([\d.]+)\s*cm3/.exec(output);
  if (!m || !v) return null;
  const cyl = (Math.PI / 4) * Number(m[1]) * Number(m[2]) * Number(m[3]) / 1000; // cm3, omslutande cylinder
  const vol = Number(v[1]);
  if (!(cyl > 0)) return null;
  const fill = vol / cyl;
  if (fill <= MAX_FILL) return null;
  return `FEL: delen är massiv — volymen ${vol.toFixed(0)} cm3 är ${(fill * 100).toFixed(0)} % av den omslutande cylindern (max ${MAX_FILL * 100} %; en spjälbur ger ~7 %). Skärmen ska vara ett öppet ramverk av stavar/ringar/gitter med tomt utrymme i mitten för glödlampan — inga fyllda kroppar, inga lameller från ett nav. Bottenplattan får vara massiv.`;
}

/** Radar ur build.py-utskriften som är värda att visa på sidan. */
export function summarizeBuildOutput(output: string): string[] {
  return output
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => /^(matt|volym|genus|trianglar|vattentat|VARNING|FEL|Traceback|\w*Error)/.test(l))
    .slice(0, 8);
}

// ---------- loopen ----------

export async function runBuildAgent(input: AgentInput, deps: AgentDeps): Promise<AgentStatus> {
  const now = deps.now ?? (() => new Date());
  const status: AgentStatus = {
    state: 'running', step: 'läser bilden', round: 0, model: deps.model, log: [], startedAt: now().toISOString(),
    usage: { input: 0, output: 0 },
  };
  const log = async (msg: string, step?: string) => {
    if (step) status.step = step;
    status.log.push({ t: now().toISOString(), msg } satisfies AgentLogEntry);
    status.updatedAt = now().toISOString();
    await deps.writeStatus(input.id, status);
  };
  const finish = async (state: 'done' | 'failed', msg: string) => {
    status.state = state;
    status.finishedAt = now().toISOString();
    await log(msg, state === 'done' ? 'klar' : 'gav upp');
    return status;
  };

  await log(`Läser bilden med ${deps.model}`, 'läser bilden');
  const messages: ChatMessage[] = [
    { role: 'system', content: buildSystemPrompt(input.examples) },
    buildFirstMessage(input),
  ];
  let spec: string | undefined;

  for (let round = 1; round <= MAX_ROUNDS; round++) {
    status.round = round;
    await log(round === 1 ? 'Skriver måttspec och build123d-kod' : `Rättar (varv ${round} av ${MAX_ROUNDS})`, round === 1 ? 'skriver kod' : 'rättar');

    let reply: ModelReply;
    const t0 = now().getTime();
    status.thinkingSeconds = 0;
    const beat = setInterval(() => {
      status.thinkingSeconds = Math.round((now().getTime() - t0) / 1000);
      status.updatedAt = now().toISOString();
      deps.writeStatus(input.id, status).catch(() => {});
    }, deps.heartbeatMs ?? HEARTBEAT_MS);
    // Live: det modellen skriver visas på sidan medan det skrivs (strypt till var 1,5 s).
    let lastLive = 0;
    const onProgress: OnProgress = (p) => {
      const t = now().getTime();
      if (t - lastLive < (deps.liveThrottleMs ?? 1500)) return;
      lastLive = t;
      status.live = { ...p, reasoningTail: p.reasoningTail.slice(-LIVE_TAIL_MAX), content: p.content.slice(-LIVE_CONTENT_MAX) };
      status.thinkingSeconds = Math.round((t - t0) / 1000);
      status.updatedAt = now().toISOString();
      deps.writeStatus(input.id, status).catch(() => {});
    };
    try {
      reply = await deps.callModel(messages, onProgress);
    } catch (err) {
      clearInterval(beat);
      delete status.live;
      return finish('failed', `Modellanropet misslyckades: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      clearInterval(beat);
    }
    delete status.live;   // resonemanget sparas aldrig; svaret finns i out/agent_<id>_varv<n>.md
    status.thinkingSeconds = Math.round((now().getTime() - t0) / 1000);
    status.updatedAt = now().toISOString();
    if (reply.reasoningChars) await log(`Tänkte ${Math.round(reply.reasoningChars / 1000)}k tecken på ${status.thinkingSeconds} s`);
    if (reply.usage && status.usage) {
      status.usage.input += reply.usage.input;
      status.usage.output += reply.usage.output;
    }
    await deps.saveReply?.(input.id, round, reply.text).catch(() => {});
    if (reply.finishReason === 'length') await log(`Svaret kapades av max_tokens (${reply.usage?.output ?? '?'} tokens)`);
    messages.push({ role: 'assistant', content: reply.text });

    const parsed = parseAgentReply(reply.text);
    if (parsed.spec) spec = parsed.spec;
    if (!parsed.code) {
      await log('Svaret saknade ett ```python-block');
      messages.push({ role: 'user', content: 'Jag hittade inget ```python-block. Svara med "### del.py" följt av ett fenced python-block (och "### spec.md" med markdown-block).' });
      continue;
    }
    if (!spec) spec = `# Kravspec — ${input.id}\n\n(modellen lämnade ingen spec)\n`;

    let result: BuildResult;
    const problems = checkCodeSafety(parsed.code);
    if (problems.length) {
      await log(`Koden avvisades innan körning (${problems.length} problem)`, 'avvisar kod');
      result = { ok: false, output: `Koden avvisades innan körning:\n${problems.map((p) => `- ${p}`).join('\n')}\nTillåtet: \`from build123d import *\` och \`import math\`. Inga filer, inget nätverk, ingen os/sys.` };
    } else {
      await log('Bygger, validerar och renderar', 'bygger');
      try {
        result = await deps.runBuild(input.id, withForcedName(parsed.code, agentPartName(input.id)), spec);
      } catch (err) {
        result = { ok: false, output: `Byggkörningen kraschade: ${err instanceof Error ? err.message : String(err)}` };
      }
    }
    const solid = result.ok ? solidityProblem(result.output) : null;
    if (solid) {
      result = { ...result, ok: false, output: `${result.output.trim()}\n  ${solid}` };
    }
    for (const line of summarizeBuildOutput(result.output)) await log(line);

    if (result.ok) {
      return finish('done', `Modellen publicerad efter ${round} ${round === 1 ? 'varv' : 'varv'}`);
    }
    if (round < MAX_ROUNDS) messages.push(buildFeedbackMessage(result, round));
  }
  return finish('failed', `Gav upp efter ${MAX_ROUNDS} varv — terminalen får ta över`);
}

// ---------- riktiga beroenden ----------

export interface AgentEnv {
  apiKey: string;
  baseUrl: string;
  model: string;
  build123dDir: string;
  maxOutputTokens: number;
  /** Valfri `reasoning_effort` (low/medium/high). Enda säkra ratten för att korta tänkandet — aldrig enable_thinking:false. */
  reasoningEffort?: string;
}

export function readAgentEnv(env: NodeJS.ProcessEnv = process.env): AgentEnv | null {
  const apiKey = env.TENSORX_API_KEY;
  if (!apiKey) return null;
  return {
    apiKey,
    baseUrl: (env.TENSORX_BASE_URL ?? DEFAULT_TENSORX_BASE_URL).replace(/\/$/, ''),
    model: env.TENSORX_MODEL ?? DEFAULT_TENSORX_MODEL,
    build123dDir: path.resolve(process.cwd(), env.BUILD123D_DIR ?? '../build123d-tests'),
    maxOutputTokens: maxOutputTokens(env.TENSORX_MODEL ?? DEFAULT_TENSORX_MODEL, env.TENSORX_MAX_OUTPUT_TOKENS),
    reasoningEffort: env.TENSORX_REASONING_EFFORT || undefined,
  };
}

/** Ett omförsök vid timeout eller 5xx — TensorX hänger ibland ett enstaka anrop. */
export async function withOneRetry<T>(fn: () => Promise<T>, onRetry?: (err: unknown) => void): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const retryable = /timeout|aborted|TensorX svarade 5\d\d|fetch failed|ECONNRESET/i.test(msg);
    if (!retryable) throw err;
    onRetry?.(err);
    return await fn();
  }
}

export function tensorxCaller(env: AgentEnv): AgentDeps['callModel'] {
  return (messages, onProgress) => withOneRetry(() => tensorxOnce(env, messages, onProgress), (err) => {
    console.warn(`[agent] TensorX: ${err instanceof Error ? err.message : err} — försöker en gång till`);
  });
}

function textOf(v: unknown): string {
  if (typeof v === 'string') return v;
  if (Array.isArray(v)) return v.map((p) => (p && typeof p === 'object' && typeof (p as { text?: unknown }).text === 'string' ? (p as { text: string }).text : '')).join('');
  return '';
}

/** Sista ~LIVE_TAIL_MAX tecknen av resonemanget som en rad — sista raden ensam blir ofta bara "L1". */
export function reasoningTail(s: string): string {
  return s.slice(-LIVE_TAIL_MAX).replace(/\s*\n+\s*/g, ' · ').replace(/\s+/g, ' ').trim();
}

/** Radvis läsning av en SSE-body. */
export async function* sseLines(body: ReadableStream<Uint8Array>): AsyncGenerator<string> {
  const reader = body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let i: number;
    while ((i = buf.indexOf('\n')) >= 0) {
      yield buf.slice(0, i).replace(/\r$/, '');
      buf = buf.slice(i + 1);
    }
  }
  if (buf) yield buf;
}

/**
 * OpenAI-kompatibel SSE-ström → svar. `reasoning_content` räknas och visas som
 * sista rad (live), men sparas aldrig; `content` är svaret. Usage kommer i
 * sista chunken (stream_options.include_usage).
 */
export async function parseSseStream(lines: AsyncIterable<string>, onProgress?: OnProgress): Promise<ModelReply> {
  let reasoning = '';
  let content = '';
  let finishReason: string | undefined;
  let usage: ModelReply['usage'];
  for await (const line of lines) {
    if (!line.startsWith('data:')) continue;
    const data = line.slice(5).trim();
    if (data === '[DONE]') break;
    let chunk: { error?: unknown; usage?: { prompt_tokens?: number; completion_tokens?: number }; choices?: { finish_reason?: string; delta?: { reasoning_content?: unknown; content?: unknown } }[] };
    try { chunk = JSON.parse(data); } catch { continue; }
    if (chunk.error) throw new Error(`TensorX: ${JSON.stringify(chunk.error).slice(0, 300)}`);
    if (chunk.usage) usage = { input: Number(chunk.usage.prompt_tokens ?? 0), output: Number(chunk.usage.completion_tokens ?? 0) };
    const ch = chunk.choices?.[0];
    if (!ch) continue;
    if (ch.finish_reason) finishReason = ch.finish_reason;
    const r = textOf(ch.delta?.reasoning_content);
    const c = textOf(ch.delta?.content);
    if (r) reasoning += r;
    if (c) content += c;
    if ((r || c) && onProgress) onProgress({ reasoningChars: reasoning.length, contentChars: content.length, reasoningTail: reasoningTail(reasoning), content });
  }
  return { text: content, usage, finishReason, reasoningChars: reasoning.length };
}

async function tensorxOnce(env: AgentEnv, messages: ChatMessage[], onProgress?: OnProgress): Promise<ModelReply> {
  const res = await fetch(`${env.baseUrl}/chat/completions`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${env.apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: env.model, messages, max_tokens: env.maxOutputTokens,
      stream: true, stream_options: { include_usage: true },
      ...(env.reasoningEffort ? { reasoning_effort: env.reasoningEffort } : {}),
    }),
    signal: AbortSignal.timeout(MODEL_TIMEOUT_MS),
  });
  if (!res.ok || !res.body) {
    const body = res.body ? (await res.text()).slice(0, 500) : '';
    console.error(`[agent] TensorX HTTP ${res.status}: ${body}`);
    throw new Error(`TensorX svarade ${res.status}`);
  }
  const reply = await parseSseStream(sseLines(res.body), onProgress);
  console.log(`[agent] ${env.model}: ${reply.text.length} tecken svar, ${reply.reasoningChars} tecken tänkande, finish=${reply.finishReason}, tokens in/ut ${reply.usage?.input}/${reply.usage?.output}`);
  return reply;
}

/** Barnprocessen får INTE ärva serverns miljö (API-nycklar). Bara det uv/python/blender behöver. */
const CHILD_ENV_KEYS = /^(PATH|HOME|TMPDIR|LANG|LC_[A-Z_]+|UV_[A-Z_]+|VIRTUAL_ENV|SHELL|USER|LOGNAME|TERM)$/;
export function childEnv(env: NodeJS.ProcessEnv = process.env): Record<string, string> {
  return Object.fromEntries(Object.entries(env).filter((e): e is [string, string] => CHILD_ENV_KEYS.test(e[0]) && typeof e[1] === 'string'));
}

function run(cmd: string, args: string[], cwd: string, timeoutMs: number): Promise<{ code: number | null; out: string }> {
  return new Promise((resolve) => {
    // detached = egen processgrupp, så timeouten dödar python + blender, inte bara uv-wrappern
    const child = spawn(cmd, args, { cwd, env: childEnv() as NodeJS.ProcessEnv, detached: true });
    let out = '';
    const push = (chunk: Buffer) => { out += chunk.toString(); if (out.length > 200_000) out = out.slice(-200_000); };
    child.stdout.on('data', push);
    child.stderr.on('data', push);
    const killAll = () => { try { if (child.pid) process.kill(-child.pid, 'SIGKILL'); } catch { child.kill('SIGKILL'); } };
    const timer = setTimeout(() => { killAll(); out += `\n[timeout efter ${timeoutMs / 1000} s]`; }, timeoutMs);
    child.on('error', (err) => { clearTimeout(timer); resolve({ code: null, out: out + `\n${err.message}` }); });
    child.on('close', (code) => { clearTimeout(timer); resolve({ code, out }); });
  });
}

export function buildSucceeded(exit: number | null, glbMtimeMs: number, startedMs: number): boolean {
  return exit === 0 && glbMtimeMs >= startedMs - 1000;
}

export function localBuildRunner(env: AgentEnv): AgentDeps['runBuild'] {
  return async (id, code, spec) => {
    if (!isValidId(id)) throw new Error('ogiltigt id');
    const name = agentPartName(id);
    const partsRel = path.join('parts', `${name}.py`);
    const specRel = path.join('ref', `${name}_spec.md`);
    const outDir = modelDir(id);
    if (!outDir) throw new Error('ogiltigt id');
    await fs.mkdir(path.join(env.build123dDir, 'parts'), { recursive: true });
    await fs.mkdir(path.join(env.build123dDir, 'ref'), { recursive: true });
    await fs.writeFile(path.join(env.build123dDir, partsRel), code);
    await fs.writeFile(path.join(env.build123dDir, specRel), spec);

    const previewPath = path.join(env.build123dDir, 'out', `${name}_preview.png`);
    await fs.rm(previewPath, { force: true });
    const startedMs = Date.now();

    const { code: exit, out } = await run(
      'uv', ['run', 'python', 'tools/build.py', partsRel, '--publish', outDir, '--spec', specRel],
      env.build123dDir, BUILD_TIMEOUT_MS,
    );
    let previewB64: string | undefined;
    try { previewB64 = (await fs.readFile(previewPath)).toString('base64'); } catch { /* ingen rendering */ }
    // Modellens kod kan skriva vad som helst till stdout — sanningen är om build.py faktiskt publicerade GLB:n nu.
    let glbMtime = 0;
    try { glbMtime = (await fs.stat(path.join(outDir, MODEL_FILES.glb))).mtimeMs; } catch { /* ingen glb */ }
    const ok = buildSucceeded(exit, glbMtime, startedMs);
    return { ok, output: out.slice(-4000), previewB64 };
  };
}

/** Modellens råa svar → build123d-tests/out/agent_<id>_varv<n>.md */
export function replySaver(env: AgentEnv): NonNullable<AgentDeps['saveReply']> {
  return async (id, round, text) => {
    if (!isValidId(id)) return;
    const outDir = path.join(env.build123dDir, 'out');
    await fs.mkdir(outDir, { recursive: true });
    await fs.writeFile(path.join(outDir, `${agentPartName(id)}_varv${round}.md`), text);
  };
}

export async function writeAgentStatus(id: string, status: AgentStatus): Promise<void> {
  const dir = modelDir(id);
  if (!dir) throw new Error('ogiltigt id');
  const tmp = path.join(dir, `${MODEL_FILES.agent}.tmp`);
  await fs.writeFile(tmp, JSON.stringify(status, null, 2));
  await fs.rename(tmp, path.join(dir, MODEL_FILES.agent));
  // livstecken: låsets mtime är det som avgör om en körning räknas som död
  const now = new Date();
  await fs.utimes(path.join(dir, 'agent.lock'), now, now).catch(() => {});
}

async function readExamples(build123dDir: string): Promise<{ name: string; code: string }[]> {
  const out: { name: string; code: string }[] = [];
  for (const name of ['demo_konsol.py', 'lampa_konisk.py']) {
    try { out.push({ name, code: await fs.readFile(path.join(build123dDir, 'parts', name), 'utf8') }); } catch { /* valfritt */ }
  }
  return out;
}

/**
 * Lås per modell: `agent.lock` skapas exklusivt. Ett lås äldre än STALE_RUN_MS
 * räknas som kvarlämnat (kraschad process) och tas över.
 */
export async function acquireLock(id: string): Promise<boolean> {
  const dir = modelDir(id);
  if (!dir) return false;
  const lock = path.join(dir, 'agent.lock');
  try {
    await fs.writeFile(lock, new Date().toISOString(), { flag: 'wx' });
    return true;
  } catch {
    try {
      const st = await fs.stat(lock);
      if (Date.now() - st.mtimeMs > STALE_RUN_MS) {
        // dött lås: ta bort och försök exklusivt igen — två övertagare kan inte båda lyckas med wx
        await fs.rm(lock, { force: true });
        await fs.writeFile(lock, new Date().toISOString(), { flag: 'wx' });
        return true;
      }
    } catch { /* fallthrough */ }
    return false;
  }
}

export async function releaseLock(id: string): Promise<void> {
  const dir = modelDir(id);
  if (dir) await fs.rm(path.join(dir, 'agent.lock'), { force: true });
}

/** Hela kedjan för ett id med riktiga beroenden. Anropas efter att låset tagits. */
export async function runRealAgent(id: string, env: AgentEnv): Promise<void> {
  try {
    const model = await readModel(id);
    const image = await readModelImage(id);
    if (!model || !image) throw new Error('modellen eller bilden saknas');
    await runBuildAgent(
      { id, userPrompt: model.meta.userPrompt, image, skeleton: await readModelSkeleton(id), examples: await readExamples(env.build123dDir) },
      { callModel: tensorxCaller(env), runBuild: localBuildRunner(env), writeStatus: writeAgentStatus, saveReply: replySaver(env), model: env.model },
    );
  } catch (err) {
    console.error('[agent] fel:', err);
    await writeAgentStatus(id, {
      state: 'failed', step: 'gav upp', round: 0, model: env.model,
      log: [{ t: new Date().toISOString(), msg: `Oväntat fel: ${err instanceof Error ? err.message : String(err)}` }],
      startedAt: new Date().toISOString(), finishedAt: new Date().toISOString(),
    }).catch(() => {});
  } finally {
    await releaseLock(id);
  }
}
