// Vision-LLM frame classifier. One JPEG in, one tiny structured verdict out.
// Speaks raw REST to Gemini (generateContent) and OpenAI (Responses API) so there is
// no SDK overhead, and remembers per-model which "no thinking" knob each API accepts.

import { RealtimeSession } from './realtime.ts';

export type LidState = 'open' | 'closed' | 'partial' | 'unknown';
export type Provider = 'gemini' | 'openai' | 'openai-realtime' | 'compat' | 'moondream';

export interface Verdict {
  press_visible: boolean;
  lid: LidState;
  confidence: number; // 0..1
  hand_on_press?: boolean; // a hand is touching / holding / moving the press
  bbox?: [number, number, number, number]; // press location in the image the model saw, normalized 0..1 (x0,y0,x1,y1)
}

export interface ClassifyOptions {
  prompt?: string;
  signal?: AbortSignal;
  timeoutMs?: number;
  /** Optional labelled reference images (few-shot) sent before the live frame. */
  refs?: { label: string; jpeg: Buffer }[];
  /** Gemini 3 media resolution knob (LOW = fewest image tokens = fastest). null disables. Default LOW. */
  geminiMediaResolution?: 'LOW' | 'MEDIUM' | 'HIGH' | null;
}

export interface ClassifyResult {
  model: string;
  provider: Provider;
  verdict: Verdict | null;
  latency_ms: number;
  error?: string;
  raw?: string;
  usage?: unknown;
}

export const DEFAULT_PROMPT = `You are the vision checker for a lab workflow, looking through the wearer's smart-glasses camera.
The PLATE PRESS in this demo is ONE specific object: a small rectangular silver / light-gray glass box with a hinged lid, about the size of a glasses case, usually lying on a dark table. Reference photos of this exact box are provided before the live frame: OPEN, CLOSED, and NOT-CLOSED-YET (lid still moving).
Rules:
- press_visible is true ONLY when this specific box is clearly in the live frame. Hands, phones, laptops, keyboards, papers, cups, bottles, other boxes, cases, containers, furniture, walls or an empty table are NOT the press: then press_visible is false and lid is "unknown".
- lid: "closed" ONLY when the lid lies completely flat on the base with no gap, no tilt and no hand holding it, so the box is one flat closed block; "open" when the lid is raised so the inside of the box is visible; "partial" whenever the lid is tilted, has a gap, is being moved, or a hand is pressing or holding it; "unknown" when the press is not visible. When in doubt between closed and partial, answer "partial".
- hand_on_press: true if a hand or fingers touch, hold or move the press.
- bbox: the press's bounding box in the LIVE frame as fractions of the image width/height, [x0, y0, x1, y1] with 0,0 at the top-left; use [0,0,0,0] when it is not visible.
- confidence (0 to 1) is how sure you are of BOTH press_visible and lid. Use 0.4 or less whenever you are guessing, and never above 0.6 when the press is small or far away in the frame.
Answer with the JSON object only.`;

const JSON_SCHEMA = {
  type: 'object',
  properties: {
    press_visible: { type: 'boolean' },
    lid: { type: 'string', enum: ['open', 'closed', 'partial', 'unknown'] },
    hand_on_press: { type: 'boolean' },
    bbox: { type: 'array', items: { type: 'number' } },
    confidence: { type: 'number' },
  },
  required: ['press_visible', 'lid', 'hand_on_press', 'bbox', 'confidence'],
  additionalProperties: false,
} as const;

const GEMINI_SCHEMA = {
  type: 'OBJECT',
  properties: {
    press_visible: { type: 'BOOLEAN' },
    lid: { type: 'STRING', enum: ['open', 'closed', 'partial', 'unknown'] },
    hand_on_press: { type: 'BOOLEAN' },
    bbox: { type: 'ARRAY', items: { type: 'NUMBER' } },
    confidence: { type: 'NUMBER' },
  },
  required: ['press_visible', 'lid', 'hand_on_press', 'bbox', 'confidence'],
  propertyOrdering: ['press_visible', 'lid', 'hand_on_press', 'bbox', 'confidence'],
};

/**
 * OpenAI-compatible chat/completions endpoints, selected by a "vendor/" prefix on the model name,
 * e.g. "groq/meta-llama/llama-4-scout-17b-16e-instruct". Set the matching *_API_KEY in .env.
 */
export const COMPAT_ENDPOINTS: Record<string, { base: string; key: string; altKey?: string }> = {
  groq: { base: 'https://api.groq.com/openai/v1', key: 'GROQ_API_KEY' },
  fireworks: { base: 'https://api.fireworks.ai/inference/v1', key: 'FIREWORKS_API_KEY' },
  together: { base: 'https://api.together.xyz/v1', key: 'TOGETHER_API_KEY' },
  xai: { base: 'https://api.x.ai/v1', key: 'XAI_API_KEY', altKey: 'GROK_API_KEY' },
  cerebras: { base: 'https://api.cerebras.ai/v1', key: 'CEREBRAS_API_KEY' },
  openrouter: { base: 'https://openrouter.ai/api/v1', key: 'OPENROUTER_API_KEY' },
  ollama: { base: 'http://localhost:11434/v1', key: '' },
};

export function providerFor(model: string): Provider {
  if (/^moondream/i.test(model)) return 'moondream';
  if (/^gpt-realtime/i.test(model)) return 'openai-realtime';
  if (model.includes('/') && COMPAT_ENDPOINTS[model.split('/')[0]]) return 'compat';
  return /^(gemini|gemma|nano-banana)/i.test(model) ? 'gemini' : 'openai';
}

/** Curated candidates, fastest-first guesses; the benchmark re-ranks them empirically. */
export const CANDIDATE_MODELS = [
  'gpt-5.4-mini',
  'moondream',
  'xai/grok-4.20-0309-non-reasoning',
  'groq/qwen/qwen3.8-27b',
  'cerebras/qwen-3.8-27b',
  'gpt-realtime-mini',
  'gemini-3.1-flash-lite',
  'gemini-3.5-flash-lite',
  'gemini-2.5-flash-lite',
  'gemini-3.5-flash',
  'gemini-3.8-flash',
  'gemini-3-flash-preview',
  'gemini-robotics-er-2-preview',
  'gpt-5.4-nano',
  'gpt-4.1-nano',
  'gpt-4.1-mini',
  'gpt-4o-mini',
  'gpt-5.4-mini',
  'gpt-5-nano',
  'gpt-5.5',
];

// ---------- thinking / reasoning knob discovery (cached per model) ----------
type GeminiThinking = Record<string, unknown> | null;
const geminiThinkingCache = new Map<string, GeminiThinking>();
function geminiThinkingVariants(model: string): GeminiThinking[] {
  const cached = geminiThinkingCache.get(model);
  if (cached !== undefined) return [cached];
  if (/gemini-2\.5/.test(model)) return [{ thinkingBudget: 0 }, null];
  if (/gemini-3/.test(model)) return [{ thinkingLevel: 'MINIMAL' }, { thinkingLevel: 'LOW' }, { thinkingBudget: 0 }, null];
  return [null];
}

type OpenAIReasoning = string | null;
const openaiReasoningCache = new Map<string, OpenAIReasoning>();
function openaiReasoningVariants(model: string): OpenAIReasoning[] {
  const cached = openaiReasoningCache.get(model);
  if (cached !== undefined) return [cached];
  if (/^(gpt-4|chatgpt)/.test(model)) return [null];
  return ['none', 'minimal', 'low', null];
}

function withTimeout(signal: AbortSignal | undefined, timeoutMs: number): AbortSignal {
  const signals: AbortSignal[] = [AbortSignal.timeout(timeoutMs)];
  if (signal) signals.push(signal);
  return AbortSignal.any(signals);
}

function parseVerdict(text: string): Verdict {
  // Tolerate code fences or stray prose around the JSON.
  const m = text.match(/\{[\s\S]*\}/);
  if (!m && /(can'?t|cannot|don'?t|do not|unable to) (see|find|locate|identify)|not (visible|in view|present|shown)|no (plate )?press/i.test(text)) {
    return { press_visible: false, lid: 'unknown', confidence: 0.6 }; // the model answered in prose: "I can't see the press"
  }
  const obj = JSON.parse(m ? m[0] : text);
  const lid = String(obj.lid ?? 'unknown').toLowerCase();
  return {
    press_visible: Boolean(obj.press_visible),
    lid: (['open', 'closed', 'partial', 'unknown'] as LidState[]).includes(lid as LidState) ? (lid as LidState) : 'unknown',
    confidence: Math.max(0, Math.min(1, Number(obj.confidence ?? 0.5))),
    hand_on_press: obj.hand_on_press === undefined ? undefined : Boolean(obj.hand_on_press),
    bbox: Array.isArray(obj.bbox) && obj.bbox.length === 4 && obj.bbox.every((n: unknown) => typeof n === 'number') ? (obj.bbox.map((n: number) => Math.max(0, Math.min(1, n))) as [number, number, number, number]) : undefined,
  };
}

// ------------------------------- Gemini -------------------------------------
async function classifyGemini(model: string, jpeg: Buffer, opts: ClassifyOptions): Promise<ClassifyResult> {
  const key = process.env.GEMINI_API_KEY;
  if (!key) throw new Error('GEMINI_API_KEY missing');
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`;
  const parts: unknown[] = [{ text: opts.prompt ?? DEFAULT_PROMPT }];
  for (const r of opts.refs ?? []) {
    parts.push({ text: `Reference image, ${r.label}:` });
    parts.push({ inline_data: { mime_type: 'image/jpeg', data: r.jpeg.toString('base64') } });
  }
  if (opts.refs?.length) parts.push({ text: 'Now the live frame:' });
  parts.push({ inline_data: { mime_type: 'image/jpeg', data: jpeg.toString('base64') } });

  const mediaRes = opts.geminiMediaResolution === undefined ? 'LOW' : opts.geminiMediaResolution;
  const t0 = performance.now();
  let lastErr = '';
  for (const thinking of geminiThinkingVariants(model)) {
    const body = {
      contents: [{ role: 'user', parts }],
      generationConfig: {
        temperature: 0,
        maxOutputTokens: 256,
        responseMimeType: 'application/json',
        responseSchema: GEMINI_SCHEMA,
        ...(thinking ? { thinkingConfig: thinking } : {}),
        ...(mediaRes && /gemini-3/.test(model) ? { mediaResolution: `MEDIA_RESOLUTION_${mediaRes}` } : {}),
      },
    };
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-goog-api-key': key },
      body: JSON.stringify(body),
      signal: withTimeout(opts.signal, opts.timeoutMs ?? 20_000),
    });
    const text = await res.text();
    if (res.status === 400 && thinking) {
      lastErr = text.slice(0, 300);
      continue; // this model rejects that thinking knob; try the next variant
    }
    if (!res.ok) return { model, provider: 'gemini', verdict: null, latency_ms: performance.now() - t0, error: `HTTP ${res.status}: ${text.slice(0, 300)}` };
    geminiThinkingCache.set(model, thinking);
    const data = JSON.parse(text);
    const out = data?.candidates?.[0]?.content?.parts?.map((p: { text?: string }) => p.text ?? '').join('') ?? '';
    try {
      return { model, provider: 'gemini', verdict: parseVerdict(out), latency_ms: performance.now() - t0, raw: out, usage: data?.usageMetadata };
    } catch (e) {
      return { model, provider: 'gemini', verdict: null, latency_ms: performance.now() - t0, error: `bad JSON: ${out.slice(0, 200)} (${(e as Error).message})`, raw: out };
    }
  }
  return { model, provider: 'gemini', verdict: null, latency_ms: performance.now() - t0, error: `all thinking variants rejected: ${lastErr}` };
}

// ------------------------------- OpenAI -------------------------------------
async function classifyOpenAI(model: string, jpeg: Buffer, opts: ClassifyOptions): Promise<ClassifyResult> {
  const key = process.env.OPENAI_API_KEY;
  if (!key) throw new Error('OPENAI_API_KEY missing');
  const content: unknown[] = [{ type: 'input_text', text: opts.prompt ?? DEFAULT_PROMPT }];
  for (const r of opts.refs ?? []) {
    content.push({ type: 'input_text', text: `Reference image, ${r.label}:` });
    content.push({ type: 'input_image', image_url: `data:image/jpeg;base64,${r.jpeg.toString('base64')}`, detail: 'low' });
  }
  if (opts.refs?.length) content.push({ type: 'input_text', text: 'Now the live frame:' });
  content.push({ type: 'input_image', image_url: `data:image/jpeg;base64,${jpeg.toString('base64')}`, detail: 'low' });

  const t0 = performance.now();
  let lastErr = '';
  for (const effort of openaiReasoningVariants(model)) {
    const body = {
      model,
      input: [{ role: 'user', content }],
      text: { format: { type: 'json_schema', name: 'press_state', schema: JSON_SCHEMA, strict: true } },
      max_output_tokens: 400,
      store: false,
      ...(effort ? { reasoning: { effort } } : {}),
    };
    const res = await fetch('https://api.openai.com/v1/responses', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
      body: JSON.stringify(body),
      signal: withTimeout(opts.signal, opts.timeoutMs ?? 20_000),
    });
    const text = await res.text();
    if (res.status === 400 && effort && /reasoning|effort/i.test(text)) {
      lastErr = text.slice(0, 300);
      continue;
    }
    if (!res.ok) return { model, provider: 'openai', verdict: null, latency_ms: performance.now() - t0, error: `HTTP ${res.status}: ${text.slice(0, 300)}` };
    openaiReasoningCache.set(model, effort);
    const data = JSON.parse(text);
    let out = '';
    for (const item of data?.output ?? []) {
      if (item.type !== 'message') continue;
      for (const c of item.content ?? []) if (c.type === 'output_text') out += c.text ?? '';
    }
    try {
      return { model, provider: 'openai', verdict: parseVerdict(out), latency_ms: performance.now() - t0, raw: out, usage: data?.usage };
    } catch (e) {
      return { model, provider: 'openai', verdict: null, latency_ms: performance.now() - t0, error: `bad JSON (status=${data?.status}): ${out.slice(0, 200)} (${(e as Error).message})`, raw: out };
    }
  }
  return { model, provider: 'openai', verdict: null, latency_ms: performance.now() - t0, error: `all reasoning variants rejected: ${lastErr}` };
}

// --------------------------- OpenAI Realtime (persistent) ---------------------
const realtimeSessions = new Map<string, RealtimeSession>();
async function classifyRealtime(model: string, jpeg: Buffer, opts: ClassifyOptions): Promise<ClassifyResult> {
  const key = process.env.OPENAI_API_KEY;
  if (!key) throw new Error('OPENAI_API_KEY missing');
  let session = realtimeSessions.get(model);
  if (!session) { session = new RealtimeSession(model, key); realtimeSessions.set(model, session); }
  const t0 = performance.now();
  try {
    const a = await session.ask(jpeg, opts.prompt ?? DEFAULT_PROMPT, 'This is the LIVE frame. Reply with ONLY the JSON object {"press_visible":..., "lid":..., "confidence":...}; if the press is not in view answer {"press_visible":false,"lid":"unknown","confidence":...}. No prose.', { timeoutMs: opts.timeoutMs ?? 8000, signal: opts.signal, refs: opts.refs });
    try {
      return { model, provider: 'openai-realtime', verdict: parseVerdict(a.text), latency_ms: a.latency_ms, raw: a.text, usage: a.usage };
    } catch (e) {
      return { model, provider: 'openai-realtime', verdict: null, latency_ms: a.latency_ms, error: `bad JSON: ${a.text.slice(0, 200)} (${(e as Error).message})`, raw: a.text };
    }
  } catch (e) {
    return { model, provider: 'openai-realtime', verdict: null, latency_ms: performance.now() - t0, error: (e as Error).message };
  }
}

// --------------------------- OpenAI-compatible endpoints ---------------------
async function classifyCompat(model: string, jpeg: Buffer, opts: ClassifyOptions): Promise<ClassifyResult> {
  const vendor = model.split('/')[0];
  const name = model.slice(vendor.length + 1);
  const ep = COMPAT_ENDPOINTS[vendor];
  const key = ep.key ? (process.env[ep.key] || (ep.altKey ? process.env[ep.altKey] : '')) : '';
  if (ep.key && !key) throw new Error(`${ep.key} missing`);
  const content: unknown[] = [{ type: 'text', text: (opts.prompt ?? DEFAULT_PROMPT) + '\nRespond with a JSON object with keys press_visible, lid, confidence.' }];
  for (const r of opts.refs ?? []) {
    content.push({ type: 'text', text: `Reference image, ${r.label}:` });
    content.push({ type: 'image_url', image_url: { url: `data:image/jpeg;base64,${r.jpeg.toString('base64')}` } });
  }
  content.push({ type: 'image_url', image_url: { url: `data:image/jpeg;base64,${jpeg.toString('base64')}` } });
  const t0 = performance.now();
  const res = await fetch(`${ep.base}/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(key ? { authorization: `Bearer ${key}` } : {}) },
    body: JSON.stringify({ model: name, messages: [{ role: 'user', content }], temperature: 0, max_tokens: 120, response_format: { type: 'json_object' } }),
    signal: withTimeout(opts.signal, opts.timeoutMs ?? 20_000),
  });
  const text = await res.text();
  if (!res.ok) return { model, provider: 'compat', verdict: null, latency_ms: performance.now() - t0, error: `HTTP ${res.status}: ${text.slice(0, 300)}` };
  const data = JSON.parse(text);
  const out: string = data?.choices?.[0]?.message?.content ?? '';
  try {
    return { model, provider: 'compat', verdict: parseVerdict(out), latency_ms: performance.now() - t0, raw: out, usage: data?.usage };
  } catch (e) {
    return { model, provider: 'compat', verdict: null, latency_ms: performance.now() - t0, error: `bad JSON: ${out.slice(0, 200)} (${(e as Error).message})`, raw: out };
  }
}

// --------------------------- Moondream (single-image VQA) --------------------
export const MOONDREAM_QUESTION = `Is there a white rectangular object on the dark table: either an open white case with its lid raised (inside visible), or a closed flat white box (a solid white block)? Answer with one word: none, open, or closed.`;
async function classifyMoondream(model: string, jpeg: Buffer, opts: ClassifyOptions): Promise<ClassifyResult> {
  const key = process.env.MOONDREAM_API_KEY;
  if (!key) throw new Error('MOONDREAM_API_KEY missing');
  const t0 = performance.now();
  const res = await fetch('https://api.moondream.ai/v1/query', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'X-Moondream-Auth': key },
    body: JSON.stringify({ image_url: `data:image/jpeg;base64,${jpeg.toString('base64')}`, question: MOONDREAM_QUESTION, stream: false, reasoning: false }),
    signal: withTimeout(opts.signal, opts.timeoutMs ?? 20_000),
  });
  const text = await res.text();
  if (!res.ok) return { model, provider: 'moondream', verdict: null, latency_ms: performance.now() - t0, error: `HTTP ${res.status}: ${text.slice(0, 300)}` };
  const answer = String(JSON.parse(text).answer ?? '').toLowerCase();
  const word = (answer.match(/\b(none|open|closed|partial|partially)\b/) ?? [])[1] ?? '';
  const lid: LidState = word === 'open' ? 'open' : word === 'closed' ? 'closed' : word.startsWith('partial') ? 'partial' : 'unknown';
  return { model, provider: 'moondream', verdict: { press_visible: lid !== 'unknown', lid, confidence: word ? 0.8 : 0.3 }, latency_ms: performance.now() - t0, raw: answer };
}

/** Close persistent sessions so short-lived tools (benchmarks) can exit. */
export function closeSessions(): void {
  for (const s of realtimeSessions.values()) s.close();
  realtimeSessions.clear();
}

export async function classifyFrame(model: string, jpeg: Buffer, opts: ClassifyOptions = {}): Promise<ClassifyResult> {
  const provider = providerFor(model);
  try {
    switch (provider) {
      case 'gemini': return await classifyGemini(model, jpeg, opts);
      case 'openai-realtime': return await classifyRealtime(model, jpeg, opts);
      case 'compat': return await classifyCompat(model, jpeg, opts);
      case 'moondream': return await classifyMoondream(model, jpeg, opts);
      default: return await classifyOpenAI(model, jpeg, opts);
    }
  } catch (e) {
    const err = e as Error;
    const error = err.name === 'TimeoutError' ? 'timeout' : err.name === 'AbortError' || /abort/i.test(err.message ?? '') ? 'aborted' : String(err.message ?? e);
    return { model, provider, verdict: null, latency_ms: 0, error };
  }
}
