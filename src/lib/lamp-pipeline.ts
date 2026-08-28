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
} as const;

const IMAGE_EXT: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
};

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

export async function readModel(id: string, baseDir: string = MODELS_DIR): Promise<ModelInfo | null> {
  const dir = modelDir(id, baseDir);
  if (!dir) return null;
  let meta: ModelMeta;
  try {
    meta = JSON.parse(await fs.readFile(path.join(dir, MODEL_FILES.meta), 'utf8'));
  } catch {
    return null;
  }
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
    const m = await readModel(n, baseDir);
    if (m) out.push(m);
  }
  return out;
}

export async function saveGeneration(
  args: { id: string; userPrompt: string; fullPrompt: string; imageBytes: Uint8Array; contentType: string | null },
  baseDir: string = MODELS_DIR,
): Promise<ModelMeta> {
  const dir = modelDir(args.id, baseDir);
  if (!dir) throw new Error('ogiltigt id');
  const imageFile = `bild.${imageExtFor(args.contentType)}`;
  const meta: ModelMeta = {
    id: args.id,
    userPrompt: args.userPrompt,
    fullPrompt: args.fullPrompt,
    imageFile,
    model: FAL_MODEL,
    createdAt: new Date().toISOString(),
  };
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, imageFile), args.imageBytes);
  await fs.writeFile(path.join(dir, MODEL_FILES.meta), JSON.stringify(meta, null, 2));
  return meta;
}
