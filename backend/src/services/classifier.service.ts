/**
 * classifier.service.ts
 *
 * Uses Gemini to decide:
 *   1. Best execution runtime (WASM vs MICROVM)
 *   2. Surge price multiplier based on regional demand ratio
 */
import { GoogleGenerativeAI } from '@google/generative-ai';
import { getDemandRatio } from './scheduler.service';

export interface ClassificationResult {
  mode: 'WASM' | 'MICROVM';
  reasoning: string;
  confidence: number;       // 0.0 – 1.0
  priceMultiplier: number;  // 1.0 – 3.0 (Surge Pricing)
  surgeExplanation?: string;
}

const CLASSIFICATION_PROMPT = (demandRatio: number, region?: string) => `
You are a cloud infrastructure expert for the Nexus DePIN platform.
Given a description or code snippet of an application, decide:

1. The best execution runtime:
   - WASM: stateless HTTP handlers, APIs, serverless, edge — no persistent disk state
   - MICROVM: stateful apps, databases, disk writes, long-running processes

2. The surge price multiplier for this deployment.
   Current demand ratio for region "${region ?? 'global'}": ${demandRatio.toFixed(2)}
   (1.0 = normal demand, 2.0 = double demand, 3.0 = max demand)

   Set priceMultiplier between 1.0 and 3.0 proportional to demand:
   - demandRatio < 1.2  → priceMultiplier 1.0
   - demandRatio 1.2–2.0 → priceMultiplier 1.0–1.5
   - demandRatio 2.0–3.0 → priceMultiplier 1.5–3.0

Respond ONLY in this JSON format (no markdown, no code block):
{
  "mode": "WASM" | "MICROVM",
  "reasoning": "1-2 sentence explanation",
  "confidence": 0.0 to 1.0,
  "priceMultiplier": 1.0 to 3.0,
  "surgeExplanation": "1 sentence explanation of the price"
}
`;

export async function classifyRuntime(codeHint: string, region?: string): Promise<ClassificationResult> {
  const apiKey = process.env.GEMINI_API_KEY ?? '';

  const demandRatio = await getDemandRatio(region);

  if (!apiKey) {
    const multiplier = Math.min(1 + (demandRatio - 1) * 0.5, 3.0);
    return {
      mode: 'MICROVM',
      reasoning: 'GEMINI_API_KEY not configured — defaulting to MicroVM.',
      confidence: 0.5,
      priceMultiplier: Math.round(multiplier * 100) / 100,
      surgeExplanation: `Calculated from demand ratio ${demandRatio.toFixed(2)}.`,
    };
  }

  const genAI = new GoogleGenerativeAI(apiKey);
  const model = genAI.getGenerativeModel({ model: 'gemini-2.5-flash' });

  const prompt = `${CLASSIFICATION_PROMPT(demandRatio, region)}\n\nApplication description:\n${codeHint.slice(0, 4000)}`;

  const result = await model.generateContent(prompt);
  const text   = result.response.text().replace(/```json/g, '').replace(/```/g, '').trim();

  let parsed: ClassificationResult;
  try {
    parsed = JSON.parse(text);
  } catch {
    return {
      mode: 'MICROVM',
      reasoning: 'Parse error from Gemini — defaulting to MicroVM.',
      confidence: 0.5,
      priceMultiplier: 1.0,
    };
  }

  if (parsed.mode !== 'WASM' && parsed.mode !== 'MICROVM') {
    throw new Error(`Invalid mode from classifier: ${parsed.mode}`);
  }

  // Clamp multiplier to safe range
  parsed.priceMultiplier = Math.min(Math.max(parsed.priceMultiplier ?? 1.0, 1.0), 3.0);

  return parsed;
}
