import { NextResponse } from 'next/server';
import {
  FAL_ENDPOINT, buildPrompt, parseFalImageUrl, saveGeneration, validateUserPrompt,
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
    const meta = await saveGeneration({
      userPrompt,
      fullPrompt,
      imageBytes: new Uint8Array(await imgRes.arrayBuffer()),
      contentType: imgRes.headers.get('content-type'),
    });

    console.log(`[lampa] ${meta.id}: sparad i public/models/${meta.id}/${meta.imageFile}`);
    return NextResponse.json({ id: meta.id, image: `/models/${meta.id}/${meta.imageFile}`, prompt: userPrompt, fullPrompt });
  } catch (err) {
    console.error('[lampa] fel:', err);
    return NextResponse.json({ error: 'Kunde inte skapa bilden' }, { status: 500 });
  }
}
