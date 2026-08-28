import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  buildPrompt, isValidId, listModels, modelDir, newId, parseFalImageUrl, readModel,
  saveGeneration, validateUserPrompt, imageExtFor, parseMeta, modelIdFromImageUrl, readModelImage,
} from '../src/lib/lamp-pipeline.ts';

test('id-validering stoppar traversal och tillåter våra id:n', () => {
  assert.equal(isValidId('lampa-20260828-140000'), true);
  assert.equal(isValidId('../x'), false);
  assert.equal(isValidId('..'), false);
  assert.equal(isValidId('A'), false);
  assert.equal(isValidId(''), false);
  assert.equal(isValidId(42), false);
  assert.equal(modelDir('../etc', '/base'), null);
  assert.equal(modelDir('lampa-1', '/base'), path.join('/base', 'lampa-1'));
});

test('newId är tidsstämplat och giltigt', () => {
  const id = newId(new Date(2026, 7, 28, 14, 5, 9));
  assert.equal(id, 'lampa-20260828-140509');
  assert.ok(isValidId(id));
});

test('prompt-validering', () => {
  assert.equal(validateUserPrompt('  spjälor  '), 'spjälor');
  assert.equal(validateUserPrompt('x'), null);
  assert.equal(validateUserPrompt('a'.repeat(401)), null);
  assert.equal(validateUserPrompt(null), null);
  assert.equal(validateUserPrompt({}), null);
});

test('promptmallen bär med användartexten och kraven', () => {
  const p = buildPrompt('rounded ribs like a beehive', 0);
  assert.match(p, /rounded ribs like a beehive/);
  assert.match(p, /E27/);
  assert.match(p, /40 cm/);
  assert.match(p, /oak side table/);
  // ramverkskravet är fast och ligger efter kundens brief
  assert.match(p, /OPEN SELF-SUPPORTING FRAMEWORK/);
  assert.match(p, /NO fabric, NO paper/);
  assert.ok(p.indexOf('rounded ribs like a beehive') < p.indexOf('OPEN SELF-SUPPORTING'));
});

test('fal-svar utan bild ger tydligt fel', () => {
  assert.throws(() => parseFalImageUrl({}), /images/);
  assert.throws(() => parseFalImageUrl({ images: [] }), /images/);
  assert.throws(() => parseFalImageUrl({ images: [{ url: 'http://x' }] }), /https/);
  assert.equal(parseFalImageUrl({ images: [{ url: 'https://fal.media/a.jpg' }] }), 'https://fal.media/a.jpg');
});

test('bildändelse från content-type', () => {
  assert.equal(imageExtFor('image/png'), 'png');
  assert.equal(imageExtFor('image/jpeg; charset=binary'), 'jpg');
  assert.equal(imageExtFor(null), 'jpg');
});

test('spara → läsa → lista, och glb-flaggan slår om när filen dyker upp', async () => {
  const base = await mkdtemp(path.join(tmpdir(), 'lampa-'));
  try {
    const id = 'lampa-20260828-120000';
    const meta = await saveGeneration({ id, userPrompt: 'test', fullPrompt: 'full', imageBytes: new Uint8Array([1, 2, 3]), contentType: 'image/jpeg' }, base);
    assert.equal(meta.id, id);
    let m = await readModel(id, base);
    assert.ok(m);
    assert.equal(m.files.image, true);
    assert.equal(m.files.glb, false);
    assert.equal(m.urls.image, `/models/${id}/bild.jpg`);
    assert.equal(m.spec, null);

    await writeFile(path.join(base, id, 'modell.glb'), 'glb');
    await writeFile(path.join(base, id, 'spec.md'), '# spec');
    m = await readModel(id, base);
    assert.equal(m?.files.glb, true);
    assert.equal(m?.spec, '# spec');

    // en mapp utan meta.json är inte en modell, och skräpnamn ignoreras
    await mkdir(path.join(base, 'lampa-20260828-130000'));
    await mkdir(path.join(base, '..hidden'));
    // trasig meta (saknar imageFile) och elak meta (imageFile med ..) får inte fälla listan
    await mkdir(path.join(base, 'lampa-20260828-140000'));
    await writeFile(path.join(base, 'lampa-20260828-140000', 'meta.json'), '{"id":"lampa-20260828-140000","userPrompt":"x","fullPrompt":"y"}');
    await mkdir(path.join(base, 'lampa-20260828-150000'));
    await writeFile(path.join(base, 'lampa-20260828-150000', 'meta.json'), JSON.stringify({ id: 'lampa-20260828-150000', userPrompt: 'x', fullPrompt: 'y', imageFile: '../../etc/passwd' }));
    await mkdir(path.join(base, 'lampa-20260828-160000'));
    await writeFile(path.join(base, 'lampa-20260828-160000', 'meta.json'), 'inte json');
    const list = await listModels(base);
    assert.deepEqual(list.map((x) => x.id), [id]);
    assert.equal(await readModel('finns-inte', base), null);

    // bilden läses från disk för prissättning
    const img = await readModelImage(id, base);
    assert.equal(img?.mimeType, 'image/jpeg');
    assert.equal(img?.base64, Buffer.from([1, 2, 3]).toString('base64'));
    assert.equal(await readModelImage('lampa-20260828-150000', base), null);

    // samma sekund två gånger -> unikt id, ingen överskrivning
    const meta2 = await saveGeneration({ id, userPrompt: 't2', fullPrompt: 'f2', imageBytes: new Uint8Array([9]), contentType: 'image/png' }, base);
    assert.equal(meta2.id, `${id}-2`);
    assert.equal((await readModel(id, base))?.meta.userPrompt, 'test');
    assert.equal((await readModel(`${id}-2`, base))?.meta.imageFile, 'bild.png');
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test('parseMeta släpper bara igenom giltig meta', () => {
  const ok = { id: 'lampa-1', userPrompt: 'a', fullPrompt: 'b', imageFile: 'bild.jpg' };
  assert.ok(parseMeta(ok, 'lampa-1'));
  assert.equal(parseMeta({ ...ok, id: 'annan' }, 'lampa-1'), null);
  assert.equal(parseMeta({ ...ok, imageFile: '../x.jpg' }, 'lampa-1'), null);
  assert.equal(parseMeta({ ...ok, imageFile: 'bild.exe' }, 'lampa-1'), null);
  assert.equal(parseMeta({ ...ok, userPrompt: 1 }, 'lampa-1'), null);
  assert.equal(parseMeta(null, 'lampa-1'), null);
  assert.equal(parseMeta('str', 'lampa-1'), null);
});

test('modelIdFromImageUrl accepterar bara sajtens egna bilder', () => {
  assert.equal(modelIdFromImageUrl('/models/lampa-20260828-142604/bild.jpg'), 'lampa-20260828-142604');
  assert.equal(modelIdFromImageUrl('/models/lampa-1/bild.webp'), 'lampa-1');
  assert.equal(modelIdFromImageUrl('http://localhost:9999/x'), null);
  assert.equal(modelIdFromImageUrl('http://169.254.169.254/latest/meta-data'), null);
  assert.equal(modelIdFromImageUrl('data:image/png;base64,AAAA'), null);
  assert.equal(modelIdFromImageUrl('/models/../secret/bild.jpg'), null);
  assert.equal(modelIdFromImageUrl('/models/lampa-1/del.py'), null);
  assert.equal(modelIdFromImageUrl(undefined), null);
});
