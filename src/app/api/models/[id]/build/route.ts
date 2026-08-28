import { NextResponse, after } from 'next/server';
import { isValidId, readModel } from '@/lib/lamp-pipeline';
import { acquireLock, readAgentEnv, releaseLock, runRealAgent, writeAgentStatus } from '@/lib/lamp-agent';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Publik — lokal demo. Kostnadsspärren är låset: en körning per modell åt gången.
 * Svarar 202 direkt; själva loopen körs i after() och sidan pollar agent.json.
 */
export async function POST(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!isValidId(id)) return NextResponse.json({ error: 'Ogiltigt id' }, { status: 400 });

  const env = readAgentEnv();
  if (!env) return NextResponse.json({ error: 'Servern saknar TENSORX_API_KEY' }, { status: 500 });

  const model = await readModel(id);
  if (!model || !model.files.image) return NextResponse.json({ error: 'Finns inte' }, { status: 404 });

  if (!(await acquireLock(id))) {
    return NextResponse.json({ error: 'En byggkörning pågår redan för den här modellen' }, { status: 409 });
  }
  // Statusfilen skrivs innan vi svarar, så nästa poll ser "running" direkt.
  try {
    await writeAgentStatus(id, {
      state: 'running', step: 'startar', round: 0, model: env.model,
      log: [{ t: new Date().toISOString(), msg: 'Startar byggagenten' }], startedAt: new Date().toISOString(),
    });
  } catch (err) {
    await releaseLock(id);
    console.error('[agent] kunde inte skriva status:', err);
    return NextResponse.json({ error: 'Kunde inte starta' }, { status: 500 });
  }

  console.log(`[agent] ${id}: startar med ${env.model}`);
  after(() => runRealAgent(id, env));
  return NextResponse.json({ id, model: env.model }, { status: 202 });
}
