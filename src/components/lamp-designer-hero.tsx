'use client';

import { useEffect, useRef, useState } from 'react';
import OrderForm from './order-form';

/** Speglar ModelInfo i src/lib/lamp-pipeline.ts. */
interface ModelInfo {
  id: string;
  meta: { userPrompt: string; fullPrompt: string; imageFile: string; createdAt: string };
  files: { image: boolean; glb: boolean; usdz: boolean; preview: boolean; spec: boolean; source: boolean };
  urls: { image: string; glb: string; usdz: string; preview: string; source: string };
  spec: string | null;
  agent: AgentStatus | null;
}
interface AgentStatus {
  state: 'running' | 'done' | 'failed';
  step: string;
  round: number;
  model: string;
  log: { t: string; msg: string }[];
  startedAt: string;
  finishedAt?: string;
  usage?: { input: number; output: number };
}

const POLL_MS = 3000;

const MODEL_LABELS: Record<string, string> = {
  'z-ai/glm-5.3-flash': 'GLM 5.3 Flash · EU',
  'qwen/qwen3.8-flash-next': 'Qwen3.8 Flash · EU',
};
const modelLabel = (id: string) => MODEL_LABELS[id] ?? id;

/**
 * Minimal rendering av spec.md: rubriker, tabeller, punktlistor, stycken.
 * Ingen markdown-dependency — specen skrivs av oss och har ett känt format.
 */
function SpecView({ text }: { text: string }) {
  const lines = text.split('\n');
  const blocks: React.ReactNode[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (line.startsWith('|')) {
      const rows: string[][] = [];
      while (i < lines.length && lines[i].startsWith('|')) {
        const cells = lines[i].slice(1, -1).split('|').map((c) => c.trim());
        if (!cells.every((c) => /^-+$/.test(c))) rows.push(cells);
        i++;
      }
      const [head, ...body] = rows;
      if (!head) continue;   // bara separatorrader — ingen tabell att rita
      blocks.push(
        <div key={i} className="overflow-x-auto my-3">
          <table className="w-full text-sm">
            <thead>
              <tr>{head.map((c, k) => <th key={k} className="text-left font-semibold text-gray-500 pb-2 pr-4">{c}</th>)}</tr>
            </thead>
            <tbody>
              {body.map((r, ri) => (
                <tr key={ri} className="border-t border-gray-100">
                  {r.map((c, k) => (
                    <td key={k} className={`py-1.5 pr-4 align-top ${k === 2 ? 'font-mono text-brand-black' : k === 3 ? 'text-gray-500' : 'text-gray-800'}`}>{c}</td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>,
      );
      continue;
    }
    if (line.startsWith('# ')) blocks.push(<h4 key={i} className="text-lg font-semibold text-brand-black mt-1">{line.slice(2)}</h4>);
    else if (line.startsWith('## ')) blocks.push(<h5 key={i} className="font-semibold text-brand-black mt-4 mb-1">{line.slice(3)}</h5>);
    else if (line.startsWith('- ')) {
      const items: string[] = [];
      while (i < lines.length && (lines[i].startsWith('- ') || lines[i].startsWith('  '))) {
        if (lines[i].startsWith('- ')) items.push(lines[i].slice(2)); else items[items.length - 1] += ' ' + lines[i].trim();
        i++;
      }
      blocks.push(<ul key={i} className="list-disc pl-5 text-sm text-gray-700 space-y-1">{items.map((t, k) => <li key={k}>{t}</li>)}</ul>);
      continue;
    } else if (line.trim() !== '') {
      const para: string[] = [line];
      while (i + 1 < lines.length && lines[i + 1].trim() !== '' && !/^([#|-]|\s)/.test(lines[i + 1])) { para.push(lines[i + 1]); i++; }
      blocks.push(<p key={i} className="text-sm text-gray-600">{para.join(' ')}</p>);
    }
    i++;
  }
  return <div className="space-y-2">{blocks}</div>;
}

/**
 * React 19 sätter `src` som egenskap på ett redan uppgraderat custom element.
 * model-viewer dokumenterar attributen, så vi sätter dem själva via ref —
 * då spelar det ingen roll om skriptet laddats före eller efter renderingen.
 */
function ModelViewer({ glb, usdz }: { glb: string; usdz?: string }) {
  const ref = useRef<HTMLElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.setAttribute('src', glb);
    if (usdz) el.setAttribute('ios-src', usdz); else el.removeAttribute('ios-src');
  }, [glb, usdz]);
  return (
    <model-viewer
      ref={ref}
      alt="3D-modell av lampskärmen"
      auto-rotate
      camera-controls
      ar
      ar-modes="quick-look webxr scene-viewer"
      shadow-intensity="1"
      environment-image="neutral"
      exposure="1"
      style={{ width: '100%', height: '100%' }}
    ></model-viewer>
  );
}

function sameState(a: ModelInfo, b: ModelInfo) {
  return a.id === b.id && a.spec === b.spec && JSON.stringify(a.files) === JSON.stringify(b.files)
    && JSON.stringify(a.agent) === JSON.stringify(b.agent);
}

export default function LampDesignerHero() {
  const [prompt, setPrompt] = useState('');
  const [isGenerating, setIsGenerating] = useState(false);
  const [current, setCurrent] = useState<ModelInfo | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isOrderFormOpen, setIsOrderFormOpen] = useState(false);
  const [isStartingAgent, setIsStartingAgent] = useState(false);

  // Vid sidladdning: visa senaste designen, så att den finns kvar när man går in igen.
  useEffect(() => {
    fetch('/api/models', { cache: 'no-store' })
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => { if (d?.models?.[0]) setCurrent(d.models[0]); })
      .catch(() => { /* tomt läge är ett giltigt läge */ });
  }, []);

  // Polla tills 3D-modellen (och specen) ligger i mappen. Terminalen skriver, sidan tittar.
  useEffect(() => {
    if (!current || (current.files.glb && current.agent?.state !== 'running')) return;
    const id = current.id;
    const timer = setInterval(async () => {
      try {
        const r = await fetch(`/api/models/${id}`, { cache: 'no-store' });
        if (!r.ok) return;
        const m: ModelInfo = await r.json();
        setCurrent((prev) => (prev && prev.id === id && !sameState(prev, m) ? m : prev));
      } catch { /* nästa tick */ }
    }, POLL_MS);
    return () => clearInterval(timer);
  }, [current]);

  const handleGenerate = async () => {
    if (!prompt.trim() || isGenerating) return;
    setIsGenerating(true);
    setError(null);
    try {
      const response = await fetch('/api/generate-lampshade', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ userPrompt: prompt }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || 'Kunde inte skapa bilden');
      const m = await fetch(`/api/models/${data.id}`, { cache: 'no-store' });
      if (!m.ok) throw new Error('Bilden sparades men kunde inte läsas tillbaka');
      setCurrent(await m.json());
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Något gick fel');
    } finally {
      setIsGenerating(false);
    }
  };

  const handleBuildWithAgent = async () => {
    if (!current || isStartingAgent) return;
    setIsStartingAgent(true);
    setError(null);
    try {
      const r = await fetch(`/api/models/${current.id}/build`, { method: 'POST' });
      const data = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(data.error || 'Kunde inte starta byggagenten');
      const m = await fetch(`/api/models/${current.id}`, { cache: 'no-store' });
      if (m.ok) setCurrent(await m.json());
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Något gick fel');
    } finally {
      setIsStartingAgent(false);
    }
  };

  const suggestedPrompts = [
    'Minimalistisk skandinavisk',
    'Art Deco elegans',
    'Vertikala spjälor',
    'Modern geometrisk',
  ];

  return (
    <section className="relative min-h-screen flex items-center justify-center overflow-hidden bg-brand-sand">
      {/* Hero-bakgrundsbild — visas bara innan en design finns */}
      {!current && (
        <div className="absolute right-0 top-0 bottom-0 w-1/2 z-0 hidden lg:block">
          <div className="relative w-full h-full flex items-center justify-center p-12">
            <img
              src="/lampshade-1.png"
              alt="Luminovo lampa"
              className="w-auto h-[80vh] max-h-[700px] object-contain drop-shadow-2xl"
            />
            <div className="absolute inset-y-0 left-0 w-32 bg-gradient-to-r from-brand-sand to-transparent"></div>
          </div>
        </div>
      )}

      <div className="container mx-auto px-4 relative z-10 pt-32 pb-20">
        <div className="max-w-6xl mx-auto">
          <div className="grid md:grid-cols-2 gap-12 items-start">
            {/* Vänster kolumn */}
            <div className="space-y-6 md:sticky md:top-32">
              <div>
                <h1 className="text-5xl md:text-6xl lg:text-7xl font-bold tracking-tight text-brand-black leading-tight mb-6">
                  Designa Din Egen Lampa
                </h1>
                <p className="text-lg md:text-xl text-gray-700 mb-4 leading-relaxed">
                  Beskriv den. Vi gör en bild, ritar den med riktiga mått och skriver ut den.
                </p>
              </div>

              <div className="space-y-4">
                <input
                  type="text"
                  value={prompt}
                  onChange={(e) => setPrompt(e.target.value)}
                  onKeyDown={(e) => e.key === 'Enter' && handleGenerate()}
                  placeholder="Beskriv din drömlampa..."
                  maxLength={400}
                  className="w-full px-5 py-3 rounded-full border border-gray-300 bg-white text-brand-black placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-brand-terracotta focus:border-transparent shadow-sm"
                />

                <div className="flex flex-wrap gap-2">
                  {suggestedPrompts.map((suggestion) => (
                    <button
                      key={suggestion}
                      onClick={() => setPrompt(suggestion)}
                      className="px-3 py-1.5 bg-white border border-gray-200 rounded-full text-xs text-gray-700 hover:bg-brand-terracotta hover:text-white hover:border-brand-terracotta transition-all"
                    >
                      {suggestion}
                    </button>
                  ))}
                </div>

                <div className="relative inline-block mt-4">
                  <div className="absolute -inset-3 rounded-full bg-gradient-to-r from-brand-ochre via-brand-terracotta to-brand-ochre opacity-30 blur-2xl animate-pulse"></div>
                  <button
                    onClick={handleGenerate}
                    disabled={!prompt.trim() || isGenerating}
                    className="relative inline-flex items-center justify-center gap-4 bg-gradient-to-br from-brand-terracotta via-brand-ochre to-brand-terracotta text-white font-bold py-6 px-12 rounded-full hover:shadow-[0_0_40px_rgba(230,160,93,0.6)] transition-all transform hover:scale-110 disabled:opacity-50 disabled:cursor-not-allowed disabled:transform-none shadow-[0_10px_40px_rgba(185,123,94,0.4)] border-2 border-white/20"
                  >
                    {!isGenerating && (
                      <svg className="w-7 h-7 drop-shadow-lg" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
                        <path d="M12 2L12 6M12 6C10.3431 6 9 7.34315 9 9C9 10.6569 10.3431 12 12 12C13.6569 12 15 10.6569 15 9C15 7.34315 13.6569 6 12 6ZM12 12L12 18M10 18H14M10.5 20H13.5" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" />
                        <path d="M12 9L12 15M7 9L17 9M8.5 6.5L15.5 11.5M15.5 6.5L8.5 11.5" stroke="white" strokeWidth="2.5" strokeLinecap="round" className="animate-pulse" />
                      </svg>
                    )}
                    <span className="text-xl tracking-wide">
                      {isGenerating ? (
                        <span className="flex items-center">
                          <svg className="animate-spin -ml-1 mr-3 h-6 w-6 text-white" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24">
                            <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"></circle>
                            <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
                          </svg>
                          Skapar din lampa...
                        </span>
                      ) : (
                        'Skapa Design'
                      )}
                    </span>
                  </button>
                </div>

                {error && (
                  <div className="p-3 bg-red-50 border border-red-200 rounded-lg">
                    <p className="text-red-600 text-sm">{error}</p>
                  </div>
                )}
              </div>

              <div className="pt-2">
                <a href="#collection" className="inline-flex items-center text-brand-terracotta font-semibold hover:text-opacity-80 transition-colors group">
                  Eller utforska vår kollektion
                  <svg className="w-5 h-5 ml-2 transform group-hover:translate-x-1 transition-transform" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M17 8l4 4m0 0l-4 4m4-4H3" />
                  </svg>
                </a>
              </div>
            </div>

            {/* Höger kolumn: bild → spec → 3D-modell */}
            {current && (
              <div className="w-full max-w-2xl space-y-6">
                <div className="bg-white rounded-2xl shadow-xl overflow-hidden">
                  <div className="relative aspect-square bg-gray-50">
                    <img src={current.urls.image} alt="Din lampdesign" className="w-full h-full object-cover" />
                  </div>
                  <div className="p-6">
                    <h3 className="text-2xl font-bold text-brand-black mb-2">Din Unika Design</h3>
                    <p className="text-sm text-gray-700">”{current.meta.userPrompt}”</p>
                    <p className="text-xs text-gray-400 mt-3 font-mono">{current.id}</p>
                  </div>
                </div>

                <div className="bg-white rounded-2xl shadow-xl overflow-hidden">
                  <div className="p-6 pb-0">
                    <h3 className="text-xl font-semibold text-brand-black mb-1">
                      {current.files.glb ? 'Din 3D-Modell' : 'Ritas med riktiga mått'}
                    </h3>
                    <p className="text-sm text-gray-600 mb-4">
                      {current.files.glb
                        ? 'Rotera och zooma. På iPhone: tryck AR-knappen och ställ den på bordet.'
                        : 'Modellen byggs från måtten nedan. Den dyker upp här när den är klar — ingen omladdning behövs.'}
                    </p>
                  </div>

                  {current.files.glb ? (
                    <div className="bg-gradient-to-b from-gray-50 to-gray-100" style={{ height: '500px' }}>
                      <ModelViewer glb={current.urls.glb} usdz={current.files.usdz ? current.urls.usdz : undefined} />
                    </div>
                  ) : current.agent?.state === 'running' ? (
                    <div className="mx-6 mb-2 rounded-xl bg-brand-sand/40 px-5 py-4">
                      <div className="flex items-center gap-3 mb-3">
                        <span className="relative flex h-3 w-3">
                          <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-brand-terracotta opacity-60"></span>
                          <span className="relative inline-flex rounded-full h-3 w-3 bg-brand-terracotta"></span>
                        </span>
                        <span className="text-sm font-semibold text-brand-black">{current.agent.step}</span>
                        <span className="text-xs text-gray-500 ml-auto">{modelLabel(current.agent.model)}{current.agent.round > 0 ? ` · varv ${current.agent.round}` : ''}</span>
                      </div>
                      <ol className="text-xs text-gray-600 space-y-1 font-mono">
                        {current.agent.log.slice(-7).map((e, i) => <li key={i}>{e.msg}</li>)}
                      </ol>
                    </div>
                  ) : current.agent?.state === 'failed' ? (
                    <div className="mx-6 mb-2 rounded-xl bg-red-50 border border-red-100 px-5 py-4">
                      <p className="text-sm font-semibold text-brand-black mb-1">Byggagenten gav upp{current.agent.round ? ` efter ${current.agent.round} varv` : ''}.</p>
                      <p className="text-xs text-gray-600 mb-3">Terminalen får ta över — eller försök igen.</p>
                      <ol className="text-xs text-gray-600 space-y-1 font-mono mb-3">
                        {current.agent.log.slice(-7).map((e, i) => <li key={i}>{e.msg}</li>)}
                      </ol>
                      <button onClick={handleBuildWithAgent} disabled={isStartingAgent} className="text-sm font-semibold text-brand-terracotta hover:underline disabled:opacity-50">
                        Försök igen
                      </button>
                    </div>
                  ) : (
                    <div className="mx-6 mb-2 rounded-xl bg-brand-sand/40 px-5 py-4">
                      <div className="flex items-center gap-3">
                        <span className="relative flex h-3 w-3">
                          <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-brand-terracotta opacity-60"></span>
                          <span className="relative inline-flex rounded-full h-3 w-3 bg-brand-terracotta"></span>
                        </span>
                        <span className="text-sm text-gray-700">
                          {current.files.spec ? 'Måtten är satta. Bygger modellen…' : 'Väntar på måttspecen…'}
                        </span>
                      </div>
                      <div className="mt-4 flex flex-wrap items-center gap-3">
                        <button
                          onClick={handleBuildWithAgent}
                          disabled={isStartingAgent}
                          className="text-white text-sm font-semibold py-2 px-5 rounded-full transition-all shadow hover:shadow-lg disabled:opacity-50"
                          style={{ backgroundColor: 'var(--brand-terracotta)' }}
                        >
                          {isStartingAgent ? 'Startar…' : 'Bygg modellen i appen'}
                        </button>
                        <span className="text-xs text-gray-500">EU-hostad modell läser bilden, skriver koden och rättar sig själv — eller så gör terminalen det.</span>
                      </div>
                    </div>
                  )}

                  {current.files.glb && current.agent?.state === 'done' && (
                    <p className="px-6 pt-4 text-xs text-gray-500">
                      Byggd i appen av {modelLabel(current.agent.model)} på {current.agent.round} {current.agent.round === 1 ? 'varv' : 'varv'}
                      {current.agent.usage ? ` · ${((current.agent.usage.input + current.agent.usage.output) / 1000).toFixed(1)}k tokens` : ''}.
                    </p>
                  )}

                  {current.spec && (
                    <div className="p-6 pt-4">
                      <SpecView text={current.spec} />
                    </div>
                  )}

                  {(current.files.source || current.files.usdz) && (
                    <div className="px-6 pb-6 flex flex-wrap gap-3 text-sm">
                      {current.files.source && (
                        <a href={current.urls.source} target="_blank" rel="noreferrer" className="text-brand-terracotta font-semibold hover:underline">
                          Visa koden (del.py)
                        </a>
                      )}
                      {current.files.usdz && (
                        <a href={current.urls.usdz} className="text-brand-terracotta font-semibold hover:underline">
                          Ladda ner för AR (USDZ)
                        </a>
                      )}
                    </div>
                  )}
                </div>

                <div className="flex gap-3">
                  <button
                    onClick={() => setIsOrderFormOpen(true)}
                    className="flex-1 text-white font-semibold py-2 px-4 rounded-full hover:opacity-90 transition-all text-sm"
                    style={{ backgroundColor: 'var(--brand-black)' }}
                  >
                    Beställ Nu
                  </button>
                </div>
              </div>
            )}
          </div>
        </div>
      </div>

      <OrderForm
        isOpen={isOrderFormOpen}
        onClose={() => setIsOrderFormOpen(false)}
        lampDetails={{
          imageUrl: current?.urls.image,
          description: current ? `Anpassad AI-design: ${current.meta.userPrompt}` : 'Anpassad AI-design',
          isCustom: true,
        }}
      />
    </section>
  );
}
