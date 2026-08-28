import { NextResponse } from 'next/server';
import { estimateLampPrice } from '@/lib/gemini-pricing';
import { modelIdFromImageUrl, readModelImage } from '@/lib/lamp-pipeline';

export const runtime = 'nodejs';

/**
 * Publik (som förut). Tar bara emot sajt-relativa bilder (/models/<id>/bild.jpg)
 * och läser dem från disk — servern hämtar aldrig en URL som klienten pekar ut.
 */
export async function POST(request: Request) {
  try {
    const body = await request.json();
    const { imageUrl, description, style, environment } = body;

    const id = modelIdFromImageUrl(imageUrl);
    if (!id) {
      return NextResponse.json({ error: 'Bilden måste vara en av sajtens egna (/models/<id>/bild.jpg)' }, { status: 400 });
    }
    const image = await readModelImage(id);
    if (!image) {
      return NextResponse.json({ error: 'Bilden finns inte' }, { status: 404 });
    }

    // Bygg en beskrivning från tillgänglig info
    const str = (v: unknown) => (typeof v === 'string' ? v.slice(0, 400) : '');
    const fullDescription = [
      str(description),
      str(style) && `Stil: ${str(style)}`,
      str(environment) && `Miljö: ${str(environment)}`,
    ]
      .filter(Boolean)
      .join('. ');

    // Anropa Gemini för prissättning
    const pricing = await estimateLampPrice(image, fullDescription);

    return NextResponse.json({
      success: true,
      ...pricing,
    });

  } catch (error) {
    console.error('Price estimation error:', error);
    return NextResponse.json(
      { error: 'Kunde inte uppskatta pris. Försök igen.' },
      { status: 500 }
    );
  }
}
