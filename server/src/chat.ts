// One streaming chat client for every vendor we can reach, over the OpenAI-compatible
// chat/completions API: OpenAI, Gemini (its OpenAI-compatible endpoint), Groq, Cerebras, xAI.
// Supports tools (function calling), image parts, and streams deltas for perceived latency.

export interface ChatTool { type: 'function'; function: { name: string; description: string; parameters: unknown } }
export type ChatContentPart = { type: 'text'; text: string } | { type: 'image_url'; image_url: { url: string; detail?: 'low' | 'high' | 'auto' } };
export interface ChatMsg { role: 'system' | 'user' | 'assistant' | 'tool'; content: string | ChatContentPart[] | null; tool_calls?: ToolCall[]; tool_call_id?: string; name?: string }
export interface ToolCall { id: string; type: 'function'; function: { name: string; arguments: string } }
export interface ChatResult { text: string; toolCalls: ToolCall[]; ttft_ms: number; total_ms: number; usage?: unknown; model: string; finish?: string }

interface Endpoint { base: string; key: string; alt?: string; reasoning: (string | null)[] }
function endpointFor(model: string): { ep: Endpoint; name: string } {
  const [vendor, ...rest] = model.split('/');
  if (rest.length) {
    const table: Record<string, Endpoint> = {
      groq: { base: 'https://api.groq.com/openai/v1', key: 'GROQ_API_KEY', reasoning: /gpt-oss/.test(model) ? ['low', null] : ['none', null] },
      cerebras: { base: 'https://api.cerebras.ai/v1', key: 'CEREBRAS_API_KEY', reasoning: /gpt-oss/.test(model) ? ['low', null] : ['none', null] },
      xai: { base: 'https://api.x.ai/v1', key: 'XAI_API_KEY', alt: 'GROK_API_KEY', reasoning: [null] },
      openrouter: { base: 'https://openrouter.ai/api/v1', key: 'OPENROUTER_API_KEY', reasoning: [null] },
      ollama: { base: 'http://localhost:11434/v1', key: '', reasoning: [null] },
    };
    if (!table[vendor]) throw new Error(`unknown vendor prefix ${vendor}`);
    return { ep: table[vendor], name: rest.join('/') };
  }
  if (/^(gemini|gemma)/.test(model)) return { ep: { base: 'https://generativelanguage.googleapis.com/v1beta/openai', key: 'GEMINI_API_KEY', reasoning: [null] }, name: model };
  return { ep: { base: 'https://api.openai.com/v1', key: 'OPENAI_API_KEY', reasoning: /^gpt-4|^chatgpt/.test(model) ? [null] : ['none', 'minimal', 'low', null] }, name: model };
}

const reasoningCache = new Map<string, string | null>();

export async function streamChat(
  model: string,
  messages: ChatMsg[],
  opts: { tools?: ChatTool[]; maxTokens?: number; temperature?: number; onDelta?: (text: string) => void; signal?: AbortSignal; timeoutMs?: number; stream?: boolean; firstByteMs?: number } = {},
): Promise<ChatResult> {
  const { ep, name } = endpointFor(model);
  const key = ep.key ? process.env[ep.key] || (ep.alt ? process.env[ep.alt] : '') : '';
  if (ep.key && !key) throw new Error(`${ep.key} missing`);
  const stream = opts.stream !== false;
  const cached = reasoningCache.get(model);
  const variants = cached !== undefined ? [cached] : ep.reasoning;
  let lastErr = '';
  for (const effort of variants) {
    const body: Record<string, unknown> = {
      model: name,
      messages,
      max_completion_tokens: opts.maxTokens ?? 400,
      stream,
      ...(stream ? { stream_options: { include_usage: true } } : {}),
      ...(opts.temperature !== undefined ? { temperature: opts.temperature } : {}),
      ...(opts.tools?.length ? { tools: opts.tools, tool_choice: 'auto' } : {}),
      ...(effort ? { reasoning_effort: effort } : {}),
    };
    const t0 = performance.now();
    const signals = [AbortSignal.timeout(opts.timeoutMs ?? 30_000)];
    if (opts.signal) signals.push(opts.signal);
    // Optional deadline for the response to start: a stalled vendor fails fast so the caller can fall back.
    const firstByte = opts.firstByteMs ? new AbortController() : null;
    const firstByteTimer = firstByte ? setTimeout(() => firstByte.abort(new Error(`no response from ${model} within ${opts.firstByteMs} ms`)), opts.firstByteMs) : null;
    if (firstByte) signals.push(firstByte.signal);
    let res: Response;
    try {
      res = await fetch(`${ep.base}/chat/completions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...(key ? { authorization: `Bearer ${key}` } : {}) },
        body: JSON.stringify(body),
        signal: AbortSignal.any(signals),
      });
    } finally {
      if (firstByteTimer) clearTimeout(firstByteTimer);
    }
    if (!res.ok) {
      const errText = await res.text();
      if (res.status === 400 && effort !== null && /reasoning|effort|unsupported|not supported|invalid/i.test(errText)) { lastErr = errText.slice(0, 200); continue; }
      if (res.status === 400 && /max_completion_tokens/i.test(errText) && !body.max_tokens) {
        // very old compat servers: retry once with max_tokens
        body.max_tokens = body.max_completion_tokens; delete body.max_completion_tokens;
        const res2 = await fetch(`${ep.base}/chat/completions`, { method: 'POST', headers: { 'content-type': 'application/json', ...(key ? { authorization: `Bearer ${key}` } : {}) }, body: JSON.stringify(body), signal: AbortSignal.any(signals) });
        if (!res2.ok) throw new Error(`chat HTTP ${res2.status}: ${(await res2.text()).slice(0, 300)}`);
        reasoningCache.set(model, effort);
        return stream ? await readStream(res2, t0, model, opts.onDelta) : await readJson(res2, t0, model);
      }
      throw new Error(`chat HTTP ${res.status}: ${errText.slice(0, 300)}`);
    }
    reasoningCache.set(model, effort);
    return stream ? await readStream(res, t0, model, opts.onDelta) : await readJson(res, t0, model);
  }
  throw new Error(`no reasoning variant accepted for ${model}: ${lastErr}`);
}

async function readJson(res: Response, t0: number, model: string): Promise<ChatResult> {
  const data = await res.json();
  const msg = data.choices?.[0]?.message ?? {};
  return { text: msg.content ?? '', toolCalls: msg.tool_calls ?? [], ttft_ms: performance.now() - t0, total_ms: performance.now() - t0, usage: data.usage, model, finish: data.choices?.[0]?.finish_reason };
}

async function readStream(res: Response, t0: number, model: string, onDelta?: (t: string) => void): Promise<ChatResult> {
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  let text = '';
  let ttft = 0;
  let usage: unknown;
  let finish: string | undefined;
  const calls = new Map<number, ToolCall>();
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let idx;
    while ((idx = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, idx).trim();
      buf = buf.slice(idx + 1);
      if (!line.startsWith('data:')) continue;
      const payload = line.slice(5).trim();
      if (payload === '[DONE]') continue;
      let j: any;
      try { j = JSON.parse(payload); } catch { continue; }
      if (j.usage) usage = j.usage;
      const choice = j.choices?.[0];
      if (!choice) continue;
      if (choice.finish_reason) finish = choice.finish_reason;
      const d = choice.delta ?? {};
      if (d.content) {
        if (!ttft) ttft = performance.now() - t0;
        text += d.content;
        onDelta?.(d.content);
      }
      for (const tc of d.tool_calls ?? []) {
        if (!ttft) ttft = performance.now() - t0;
        const i = tc.index ?? 0;
        const cur = calls.get(i) ?? { id: tc.id ?? `call_${i}`, type: 'function', function: { name: '', arguments: '' } };
        if (tc.id) cur.id = tc.id;
        if (tc.function?.name) cur.function.name += tc.function.name;
        if (tc.function?.arguments) cur.function.arguments += tc.function.arguments;
        calls.set(i, cur);
      }
    }
  }
  return { text, toolCalls: [...calls.values()], ttft_ms: ttft || performance.now() - t0, total_ms: performance.now() - t0, usage, model, finish };
}
