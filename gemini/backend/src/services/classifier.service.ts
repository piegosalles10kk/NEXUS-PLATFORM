/**
 * classifier.service.ts
 *
 * Uses Gemini to decide whether a given application should run as:
 *   - WASM  → stateless, HTTP handlers, no persistent state
 *   - MICROVM → stateful, databases, long-running processes, OS-level dependencies
 */
import { GoogleGenerativeAI } from '@google/generative-ai';

export interface ClassificationResult {
  mode: 'WASM' | 'MICROVM';
  reasoning: string;
  confidence: number; // 0.0 – 1.0
}

const CLASSIFICATION_PROMPT = `
You are a cloud infrastructure expert for the Nexus DePIN platform.
Given a description or code snippet of an application, decide the best execution runtime:

- WASM: Choose for stateless HTTP handlers, APIs, serverless functions, edge computing
  workloads that have NO persistent disk state, NO database writes, and can be run
  ephemerally in parallel across multiple nodes.

- MICROVM: Choose for stateful applications such as databases (PostgreSQL, MySQL, Redis,
  MongoDB), applications that write to disk, long-running background workers, monoliths,
  or any application that requires a consistent OS environment.

Respond ONLY in this JSON format:
{
  "mode": "WASM" | "MICROVM",
  "reasoning": "1-2 sentence explanation",
  "confidence": 0.0 to 1.0
}
`;

export async function classifyRuntime(codeHint: string): Promise<ClassificationResult> {
  const apiKey = process.env.GEMINI_API_KEY ?? '';
  if (!apiKey) {
    // Fallback: default to MICROVM when AI is not configured
    return { mode: 'MICROVM', reasoning: 'GEMINI_API_KEY not configured — defaulting to MicroVM.', confidence: 0.5 };
  }

  const genAI = new GoogleGenerativeAI(apiKey);
  const model = genAI.getGenerativeModel({ model: 'gemini-2.5-flash' });

  const prompt = `${CLASSIFICATION_PROMPT}\n\nApplication description / code hint:\n${codeHint.slice(0, 4000)}`;

  const result   = await model.generateContent(prompt);
  const text     = result.response.text().replace(/```json/g, '').replace(/```/g, '').trim();
  const parsed   = JSON.parse(text) as ClassificationResult;

  if (parsed.mode !== 'WASM' && parsed.mode !== 'MICROVM') {
    throw new Error(`Invalid mode from classifier: ${parsed.mode}`);
  }

  return parsed;
}
