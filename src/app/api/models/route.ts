import { NextResponse } from 'next/server';
import { listModels } from '@/lib/lamp-pipeline';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** Publik — läser bara det som redan ligger statiskt servat under /models. */
export async function GET() {
  return NextResponse.json({ models: await listModels() });
}
