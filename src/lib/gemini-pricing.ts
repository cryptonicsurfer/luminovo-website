import { GoogleGenAI } from '@google/genai';

const genai = new GoogleGenAI({
  apiKey: process.env.GEMINI_API_KEY!,
});

const PRICING_SYSTEM_PROMPT = `Du är en expert på att prissätta 3D-printade lampskärmar baserat på deras komplexitet och design.

REFERENSPRISER (utgångspunkter):
- Enkel lampskärm (minimal geometri, få detaljer): 2.495 kr
- Medium lampskärm (moderat komplexitet, organiska former): 3.495 kr
- Komplex lampskärm (intrikata detaljer, geometriska mönster, mesh): 4.495 kr
- Mycket komplex lampskärm (hög detaljrikedom, flera lager, avancerad geometri): 5.995 kr

BEDÖMNINGSKRITERIER:
1. **Geometrisk komplexitet** - Hur komplicerad är formen? Kurvor, vinklar, symmetri?
2. **Detaljnivå** - Hur många små detaljer och mönster finns det?
3. **Printtid** - Mer komplex design = längre printtid = högre kostnad
4. **Materialåtgång** - Mesh/öppna strukturer använder mindre material än solida former
5. **Svårighetsgrad** - Risk för misslyckad print ökar kostnaden

INSTRUKTIONER:
1. Analysera bilden noggrant
2. Bedöm lampans komplexitet baserat på kriterierna ovan
3. Välj ett pris från referenspriserna eller ett mellanting
4. Svara ENDAST med ett JSON-objekt i detta format:

{
  "price": 3495,
  "reasoning": "Kort motivering (1-2 meningar på svenska)",
  "complexity": "simple|medium|complex|very_complex"
}

Svara BARA med JSON, ingen annan text.`;

interface PricingResult {
  price: number;
  reasoning: string;
  complexity: 'simple' | 'medium' | 'complex' | 'very_complex';
}

export async function estimateLampPrice(
  image: { base64: string; mimeType: string },
  lampDescription?: string
): Promise<PricingResult> {
  try {
    // Bilden kommer alltid från disk (lamp-pipeline.readModelImage) — ingen URL-hämtning här.
    const imagePart = {
      inlineData: {
        data: image.base64,
        mimeType: image.mimeType,
      },
    };

    const userPrompt = lampDescription
      ? `Analysera denna lampskärm och bedöm dess komplexitet. Beskrivning: ${lampDescription}`
      : 'Analysera denna lampskärm och bedöm dess komplexitet.';

    const config = {
      thinkingConfig: {
        thinkingBudget: -1,
      },
    };

    const result = await genai.models.generateContent({
      model: 'gemini-2.5-flash',
      config,
      contents: [
        {
          role: 'user',
          parts: [
            { text: PRICING_SYSTEM_PROMPT },
            imagePart,
            { text: userPrompt },
          ],
        },
      ],
    });

    const text = result.text || result.candidates?.[0]?.content?.parts?.[0]?.text || '';

    // Parse JSON från svaret
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      throw new Error('Invalid response format from Gemini');
    }

    const pricing: PricingResult = JSON.parse(jsonMatch[0]);

    // Validera att priset är rimligt
    if (pricing.price < 2000 || pricing.price > 10000) {
      throw new Error('Price out of reasonable range');
    }

    return pricing;

  } catch (error) {
    console.error('Error estimating price:', error);

    // Fallback till baspreis om något går fel
    return {
      price: 3495,
      reasoning: 'Standardpris för medium komplexitet',
      complexity: 'medium',
    };
  }
}

// Hjälpfunktion för att formatera pris
export function formatPrice(price: number): string {
  return `${price.toLocaleString('sv-SE')} kr`;
}
