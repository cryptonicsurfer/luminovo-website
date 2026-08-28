/**
 * Lampkedjan: prompt → fal.ai-bild → mapp i public/models/<id>/ som
 * Claude Code i terminalen fyller på med spec + 3D-modell.
 *
 * Inga Next-beroenden här, så filen går att testa med `node --test`.
 */
import { promises as fs } from 'node:fs';
import path from 'node:path';

export const FAL_MODEL = 'fal-ai/bytedance/seedream/v5/lite/text-to-image';
export const FAL_ENDPOINT = `https://fal.run/${FAL_MODEL}`;

export const MODELS_DIR = path.join(process.cwd(), 'public', 'models');

/** id = lampa-ÅÅÅÅMMDD-HHMMSS. Regexen är också skyddet mot path traversal. */
export const ID_RE = /^[a-z0-9-]{3,64}$/;

/** De enda filnamn vi någonsin läser eller exponerar ur en modellmapp. */
export const MODEL_FILES = {
  meta: 'meta.json',
  glb: 'modell.glb',
  usdz: 'modell.usdz',
  preview: 'preview.png',
  spec: 'spec.md',
  source: 'del.py',
  agent: 'agent.json',
} as const;

/** Byggagentens status (skrivs av src/lib/lamp-agent.ts). */
export interface AgentLogEntry { t: string; msg: string }
export interface AgentStatus {
  state: 'running' | 'done' | 'failed';
  step: string;
  round: number;
  model: string;
  log: AgentLogEntry[];
  startedAt: string;
  finishedAt?: string;
  usage?: { input: number; output: number };
}
const AGENT_STATES = new Set(['running', 'done', 'failed']);
const MAX_LOG_ENTRIES = 200;
/** En körning som inte hörts av på så länge räknas som död (låset tas över, UI:t visar "avbruten"). */
export const STALE_RUN_MS = 10 * 60_000;

/** Senaste livstecken: sista loggraden, annars starttiden. */
export function lastActivityMs(a: AgentStatus): number {
  const last = a.log.length ? a.log[a.log.length - 1].t : a.startedAt;
  const t = Date.parse(last);
  return Number.isFinite(t) ? t : Date.parse(a.startedAt) || 0;
}

/** running utan livstecken på STALE_RUN_MS → failed, så sidan får en "försök igen"-knapp i stället för evig spinner. */
export function markStale(a: AgentStatus, nowMs: number = Date.now()): AgentStatus {
  if (a.state !== 'running' || nowMs - lastActivityMs(a) < STALE_RUN_MS) return a;
  return {
    ...a,
    state: 'failed',
    step: 'avbruten',
    log: [...a.log, { t: new Date(nowMs).toISOString(), msg: 'Körningen dog utan att avslutas (startade servern om?) — försök igen' }],
  };
}

/** Fail-closed: en trasig agent.json ger null, aldrig ett kastat fel. */
export function parseAgentStatus(raw: unknown): AgentStatus | null {
  if (!raw || typeof raw !== 'object') return null;
  const a = raw as Record<string, unknown>;
  if (typeof a.state !== 'string' || !AGENT_STATES.has(a.state)) return null;
  if (typeof a.startedAt !== 'string') return null;
  const log = Array.isArray(a.log)
    ? a.log.filter((e): e is AgentLogEntry => !!e && typeof e === 'object' && typeof (e as AgentLogEntry).msg === 'string' && typeof (e as AgentLogEntry).t === 'string')
      .slice(-MAX_LOG_ENTRIES)
    : [];
  const usage = a.usage && typeof a.usage === 'object' && typeof (a.usage as { input?: unknown }).input === 'number' && typeof (a.usage as { output?: unknown }).output === 'number'
    ? (a.usage as { input: number; output: number })
    : undefined;
  return {
    state: a.state as AgentStatus['state'],
    step: typeof a.step === 'string' ? a.step : '',
    round: typeof a.round === 'number' ? a.round : 0,
    model: typeof a.model === 'string' ? a.model : '',
    log,
    startedAt: a.startedAt,
    finishedAt: typeof a.finishedAt === 'string' ? a.finishedAt : undefined,
    usage,
  };
}

const IMAGE_EXT: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
};
const MIME_FOR_EXT: Record<string, string> = { jpg: 'image/jpeg', png: 'image/png', webp: 'image/webp' };

/** Bildfilen i meta.json får bara heta så här — meta skrivs till disk och läses tillbaka okritiskt annars. */
export const IMAGE_FILE_RE = /^bild\.(jpg|png|webp)$/;

export interface ModelMeta {
  id: string;
  userPrompt: string;
  fullPrompt: string;
  imageFile: string;
  model: string;
  createdAt: string;
}

export interface ModelInfo {
  id: string;
  meta: ModelMeta;
  files: { image: boolean; glb: boolean; usdz: boolean; preview: boolean; spec: boolean; source: boolean };
  urls: { image: string; glb: string; usdz: string; preview: string; source: string };
  spec: string | null;
  agent: AgentStatus | null;
}

export function isValidId(id: unknown): id is string {
  return typeof id === 'string' && ID_RE.test(id);
}

export function newId(now: Date = new Date()): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `lampa-${now.getFullYear()}${p(now.getMonth() + 1)}${p(now.getDate())}` +
         `-${p(now.getHours())}${p(now.getMinutes())}${p(now.getSeconds())}`;
}

/** Server-side validering. Returnerar trimmad text eller null. */
export function validateUserPrompt(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const t = value.trim();
  if (t.length < 2 || t.length > 400) return null;
  return t;
}

const ENVIRONMENTS = [
  'an oak side table',
  'a marble console',
  'a birch nightstand',
  'a walnut desk',
  'a white ceramic surface',
  'a concrete plinth',
];

/**
 * Fast mall i stället för LLM-optimerad prompt. Kraven är samma som i
 * Luminovos ursprungliga mall (40 cm, E27, vit PLA) — det är dessa som
 * sedan blir mått i spec.md.
 */
export function buildPrompt(userPrompt: string, pick: number = Math.floor(Math.random() * ENVIRONMENTS.length)): string {
  const env = ENVIRONMENTS[((pick % ENVIRONMENTS.length) + ENVIRONMENTS.length) % ENVIRONMENTS.length];
  return (
    `Product photograph of a 3D-printed table lampshade in matte white PLA. ` +
    `Design brief: ${userPrompt}. ` +
    `Clean geometric structure that can be 3D printed without supports, ` +
    `maximum 40 cm tall and 30 cm wide, solid base ring with a central hole for an E27 socket. ` +
    `Warm 2700K light glowing from inside, standing on ${env}, Scandinavian minimalist interior, ` +
    `soft natural daylight, no people, no other objects.`
  );
}

/** Plockar första bild-URL:en ur fal:s svar, eller kastar ett tydligt fel. */
export function parseFalImageUrl(json: unknown): string {
  const images = (json as { images?: unknown })?.images;
  if (!Array.isArray(images) || images.length === 0) {
    throw new Error('fal-svaret saknar images[]');
  }
  const url = (images[0] as { url?: unknown })?.url;
  if (typeof url !== 'string' || !url.startsWith('https://')) {
    throw new Error('fal-svaret saknar en https-URL i images[0]');
  }
  return url;
}

export function imageExtFor(contentType: string | null): string {
  const key = (contentType ?? '').split(';')[0].trim().toLowerCase();
  return IMAGE_EXT[key] ?? 'jpg';
}

/** Mappen för ett id — bara om id:t klarar regexen och hamnar under baseDir. */
export function modelDir(id: string, baseDir: string = MODELS_DIR): string | null {
  if (!isValidId(id)) return null;
  const dir = path.join(baseDir, id);
  if (!dir.startsWith(baseDir + path.sep)) return null;
  return dir;
}

async function exists(p: string): Promise<boolean> {
  try { await fs.access(p); return true; } catch { return false; }
}

/** Kontrollerar att det som lästes från disk verkligen är en ModelMeta. */
export function parseMeta(raw: unknown, id: string): ModelMeta | null {
  if (!raw || typeof raw !== 'object') return null;
  const m = raw as Record<string, unknown>;
  if (m.id !== id) return null;
  if (typeof m.imageFile !== 'string' || !IMAGE_FILE_RE.test(m.imageFile)) return null;
  if (typeof m.userPrompt !== 'string' || typeof m.fullPrompt !== 'string') return null;
  return {
    id,
    userPrompt: m.userPrompt,
    fullPrompt: m.fullPrompt,
    imageFile: m.imageFile,
    model: typeof m.model === 'string' ? m.model : '',
    createdAt: typeof m.createdAt === 'string' ? m.createdAt : '',
  };
}

export async function readModel(id: string, baseDir: string = MODELS_DIR): Promise<ModelInfo | null> {
  const dir = modelDir(id, baseDir);
  if (!dir) return null;
  let meta: ModelMeta | null;
  try {
    meta = parseMeta(JSON.parse(await fs.readFile(path.join(dir, MODEL_FILES.meta), 'utf8')), id);
  } catch {
    return null;
  }
  if (!meta) return null;
  const has = async (name: string) => exists(path.join(dir, name));
  const files = {
    image: await has(meta.imageFile),
    glb: await has(MODEL_FILES.glb),
    usdz: await has(MODEL_FILES.usdz),
    preview: await has(MODEL_FILES.preview),
    spec: await has(MODEL_FILES.spec),
    source: await has(MODEL_FILES.source),
  };
  const spec = files.spec ? await fs.readFile(path.join(dir, MODEL_FILES.spec), 'utf8') : null;
  let agent: AgentStatus | null = null;
  try {
    agent = parseAgentStatus(JSON.parse(await fs.readFile(path.join(dir, MODEL_FILES.agent), 'utf8')));
    if (agent) agent = markStale(agent);
  } catch {
    agent = null;
  }
  const base = `/models/${id}`;
  return {
    id,
    meta,
    files,
    urls: {
      image: `${base}/${meta.imageFile}`,
      glb: `${base}/${MODEL_FILES.glb}`,
      usdz: `${base}/${MODEL_FILES.usdz}`,
      preview: `${base}/${MODEL_FILES.preview}`,
      source: `${base}/${MODEL_FILES.source}`,
    },
    spec,
    agent,
  };
}

/** Alla modeller, nyaste först (id:t är tidsstämplat, så sortering på namn räcker). */
export async function listModels(baseDir: string = MODELS_DIR): Promise<ModelInfo[]> {
  let names: string[];
  try {
    names = (await fs.readdir(baseDir, { withFileTypes: true }))
      .filter((d) => d.isDirectory() && isValidId(d.name))
      .map((d) => d.name);
  } catch {
    return [];
  }
  names.sort().reverse();
  const out: ModelInfo[] = [];
  for (const n of names) {
    try {
      const m = await readModel(n, baseDir);
      if (m) out.push(m);
    } catch {
      // en trasig mapp får inte fälla listan
    }
  }
  return out;
}

/** Läser modellens bild från disk (för prissättning) — aldrig via URL. */
export async function readModelImage(
  id: string, baseDir: string = MODELS_DIR,
): Promise<{ base64: string; mimeType: string } | null> {
  const m = await readModel(id, baseDir);
  if (!m || !m.files.image) return null;
  const dir = modelDir(id, baseDir)!;
  const bytes = await fs.readFile(path.join(dir, m.meta.imageFile));
  const ext = m.meta.imageFile.split('.').pop() ?? 'jpg';
  return { base64: bytes.toString('base64'), mimeType: MIME_FOR_EXT[ext] ?? 'image/jpeg' };
}

/** Plockar id ur en sajt-relativ bild-URL som /models/<id>/bild.jpg, annars null. */
export function modelIdFromImageUrl(url: unknown): string | null {
  if (typeof url !== 'string') return null;
  const m = /^\/models\/([a-z0-9-]{3,64})\/(bild\.(?:jpg|png|webp))$/.exec(url);
  return m && isValidId(m[1]) ? m[1] : null;
}

/**
 * Skapar modellmappen exklusivt. Två anrop samma sekund får samma tidsstämpel —
 * då blir den andra `<id>-2`, `<id>-3` … i stället för att skriva över.
 */
export async function createModelDir(baseId: string, baseDir: string = MODELS_DIR): Promise<string> {
  await fs.mkdir(baseDir, { recursive: true });
  for (let n = 1; n <= 50; n++) {
    const id = n === 1 ? baseId : `${baseId}-${n}`;
    const dir = modelDir(id, baseDir);
    if (!dir) throw new Error('ogiltigt id');
    try {
      await fs.mkdir(dir);
      return id;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
    }
  }
  throw new Error('kunde inte hitta ett ledigt id');
}

export async function saveGeneration(
  args: { userPrompt: string; fullPrompt: string; imageBytes: Uint8Array; contentType: string | null; id?: string },
  baseDir: string = MODELS_DIR,
): Promise<ModelMeta> {
  const id = await createModelDir(args.id ?? newId(), baseDir);
  const dir = modelDir(id, baseDir)!;
  const imageFile = `bild.${imageExtFor(args.contentType)}`;
  const meta: ModelMeta = {
    id,
    userPrompt: args.userPrompt,
    fullPrompt: args.fullPrompt,
    imageFile,
    model: FAL_MODEL,
    createdAt: new Date().toISOString(),
  };
  await fs.writeFile(path.join(dir, imageFile), args.imageBytes);
  await fs.writeFile(path.join(dir, MODEL_FILES.meta), JSON.stringify(meta, null, 2));
  return meta;
}
