import { NextResponse } from 'next/server';
import {
  FAL_ENDPOINT, FAL_EDIT_ENDPOINT, ISOLATE_PROMPT, buildPrompt, parseFalImageUrl, saveGeneration, saveSkeleton, validateUserPrompt,
} from '@/lib/lamp-pipeline';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Publik route — sajten har aldrig haft auth och körs bara lokalt i demot.
 * Nyckeln lämnar aldrig servern.
 */
export async function POST(request: Request) {
  const key = process.env.FAL_API_KEY ?? process.env.FAL_KEY;
  if (!key) {
    return NextResponse.json({ error: 'Servern saknar FAL_API_KEY' }, { status: 500 });
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'Ogiltig JSON' }, { status: 400 });
  }
  const userPrompt = validateUserPrompt((body as { userPrompt?: unknown })?.userPrompt);
  if (!userPrompt) {
    return NextResponse.json({ error: 'Beskriv lampan med 2–400 tecken' }, { status: 400 });
  }

  const fullPrompt = buildPrompt(userPrompt);
  console.log(`[lampa] ny generering: "${userPrompt}"`);

  try {
    const falRes = await fetch(FAL_ENDPOINT, {
      method: 'POST',
      headers: { Authorization: `Key ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ prompt: fullPrompt, image_size: 'square_hd', num_images: 1 }),
    });
    if (!falRes.ok) {
      console.error(`[lampa] fal HTTP ${falRes.status}:`, (await falRes.text()).slice(0, 800));
      return NextResponse.json({ error: 'Bildtjänsten svarade med fel' }, { status: 502 });
    }
    const imageUrl = parseFalImageUrl(await falRes.json());

    const imgRes = await fetch(imageUrl);
    if (!imgRes.ok) {
      console.error(`[lampa] kunde inte hämta bilden: HTTP ${imgRes.status}`);
      return NextResponse.json({ error: 'Kunde inte hämta bilden' }, { status: 502 });
    }
    const imageBytes = new Uint8Array(await imgRes.arrayBuffer());
    const meta = await saveGeneration({
      userPrompt,
      fullPrompt,
      imageBytes,
      contentType: imgRes.headers.get('content-type'),
    });

    console.log(`[lampa] ${meta.id}: sparad i public/models/${meta.id}/${meta.imageFile}`);

    // Steg 2 — isolera den printbara delen. Best effort: misslyckas det finns originalbilden ändå.
    let skeleton = false;
    try {
      const imgB64 = Buffer.from(imageBytes).toString('base64');
      const editRes = await fetch(FAL_EDIT_ENDPOINT, {
        method: 'POST',
        headers: { Authorization: `Key ${key}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ prompt: ISOLATE_PROMPT, image_urls: [`data:${imgRes.headers.get('content-type') ?? 'image/jpeg'};base64,${imgB64}`], image_size: 'square_hd', num_images: 1 }),
        signal: AbortSignal.timeout(120_000),
      });
      if (!editRes.ok) throw new Error(`fal edit HTTP ${editRes.status}: ${(await editRes.text()).slice(0, 300)}`);
      const skelRes = await fetch(parseFalImageUrl(await editRes.json()));
      if (!skelRes.ok) throw new Error(`skelett HTTP ${skelRes.status}`);
      await saveSkeleton(meta.id, new Uint8Array(await skelRes.arrayBuffer()));
      skeleton = true;
      console.log(`[lampa] ${meta.id}: skelett.jpg sparad`);
    } catch (err) {
      console.warn(`[lampa] ${meta.id}: isolering hoppades över —`, err instanceof Error ? err.message : err);
    }
    return NextResponse.json({ id: meta.id, image: `/models/${meta.id}/${meta.imageFile}`, skeleton, prompt: userPrompt, fullPrompt });
  } catch (err) {
    console.error('[lampa] fel:', err);
    return NextResponse.json({ error: 'Kunde inte skapa bilden' }, { status: 500 });
  }
}
