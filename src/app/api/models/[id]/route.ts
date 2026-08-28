import { NextResponse } from 'next/server';
import { isValidId, readModel } from '@/lib/lamp-pipeline';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** Publik — samma data som /models/<id>/ redan exponerar statiskt. */
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!isValidId(id)) {
    return NextResponse.json({ error: 'Ogiltigt id' }, { status: 400 });
  }
  const model = await readModel(id);
  if (!model) {
    return NextResponse.json({ error: 'Finns inte' }, { status: 404 });
  }
  return NextResponse.json(model, { headers: { 'Cache-Control': 'no-store' } });
}
