// Chat agent for the console and the glasses. It sees the latest camera frame and the workflow
// state, answers briefly (replies are spoken on the glasses), and drives the workflow with tools.
import type { SessionSnapshot } from './session.ts';

export interface ChatMessage { id: string; role: 'user' | 'assistant'; text: string; at: number; from?: string }

export interface AgentContext {
  state: SessionSnapshot;
  camera: { live: boolean; source: string | null; fps: number };
  config: { models: string[]; countdown_ms: number; confirmations: number };
  stats: { p50_ms: number; decisions_per_s: number };
  frame: Buffer | null;
}

export type ToolResult = string;
export interface AgentTools {
  start_workflow: () => ToolResult;
  stop_workflow: () => ToolResult;
  set_press_time: (seconds: number) => ToolResult;
  set_confirmations: (n: number) => ToolResult;
  set_models: (models: string[]) => ToolResult;
  set_reference: (kind: 'open' | 'closed') => ToolResult;
}

const TOOL_DEFS = [
  { type: 'function', name: 'start_workflow', description: 'Start (or restart) the plate-press workflow: begin detecting the press, then guide close → 10 s countdown → open.', parameters: { type: 'object', properties: {}, additionalProperties: false }, strict: true },
  { type: 'function', name: 'stop_workflow', description: 'Stop the workflow and go back to standby (no detection, no countdown).', parameters: { type: 'object', properties: {}, additionalProperties: false }, strict: true },
  { type: 'function', name: 'set_press_time', description: 'Change how long the press must stay closed, in seconds.', parameters: { type: 'object', properties: { seconds: { type: 'number' } }, required: ['seconds'], additionalProperties: false }, strict: true },
  { type: 'function', name: 'set_confirmations', description: 'How many consecutive agreeing camera verdicts are needed before a state change is accepted (1-5).', parameters: { type: 'object', properties: { n: { type: 'integer' } }, required: ['n'], additionalProperties: false }, strict: true },
  { type: 'function', name: 'set_models', description: 'Choose the vision model(s). Several models race per frame; the fastest valid answer wins.', parameters: { type: 'object', properties: { models: { type: 'array', items: { type: 'string' } } }, required: ['models'], additionalProperties: false }, strict: true },
  { type: 'function', name: 'set_reference', description: 'Save the current camera frame as the reference photo of the press in the given lid state.', parameters: { type: 'object', properties: { kind: { type: 'string', enum: ['open', 'closed'] } }, required: ['kind'], additionalProperties: false }, strict: true },
];

const INSTRUCTIONS = `You are the PlatePress assistant: a general-purpose, friendly chatbot that also operates the plate-press workflow in a lab. The operator talks to you from a desktop console or through Rokid smart glasses.
Answer anything: general knowledge, science, lab questions, math, small talk, translations, advice. Be accurate; say when you are unsure.
You also receive the live camera frame and the workflow state with every message; use them when the question is about the scene or the workflow.
The workflow you run: find the plate press (a small silver glass box with a hinged lid), ask the operator to close it, count down while it is closed, then ask them to open it, then report completion.
Tools: when the operator asks to start, begin, run, or do the workflow (any wording), call start_workflow. "Stop", "cancel", "standby" → stop_workflow. Change timing or settings with the matching tool. After a tool call, confirm briefly in words. Never claim a tool ran unless you called it.
Style: replies are read aloud in the glasses, so keep them short (one to three sentences) unless the operator asks for detail, a list, or an explanation; then answer fully. Plain text, no markdown tables or headings; simple lists are fine on request.
When asked what you see, describe the frame plainly and say whether the press is visible and open or closed. If the camera is not live, say so.`;

const reasoningCache = new Map<string, string | null>();

export class Agent {
  history: ChatMessage[] = [];
  private model: string;
  private getContext: () => AgentContext;
  private tools: AgentTools;
  private seq = 0;

  constructor(model: string, getContext: () => AgentContext, tools: AgentTools) {
    this.model = model;
    this.getContext = getContext;
    this.tools = tools;
  }

  private stateText(ctx: AgentContext): string {
    const s = ctx.state;
    const remaining = s.countdown ? Math.max(0, Math.round((s.countdown.ends_at - Date.now()) / 100) / 10) : null;
    return [
      `phase=${s.phase} ("${s.message}"${s.sub ? ` / ${s.sub}` : ''})`,
      `camera=${ctx.camera.live ? `live (${ctx.camera.source}, ${ctx.camera.fps} fps)` : 'not live'}`,
      remaining !== null ? `countdown_remaining_s=${remaining}` : '',
      s.last_verdict ? `last_camera_verdict: press_visible=${s.last_verdict.press_visible} lid=${s.last_verdict.lid} confidence=${s.last_verdict.confidence} age_ms=${s.last_verdict.age_ms}` : 'last_camera_verdict: none yet',
      `press_time_s=${ctx.config.countdown_ms / 1000} confirmations=${ctx.config.confirmations} models=${ctx.config.models.join('+')} verdict_latency_p50_ms=${ctx.stats.p50_ms}`,
      `run=${s.run}`,
    ].filter(Boolean).join('\n');
  }

  private runTool(name: string, args: Record<string, unknown>): string {
    try {
      switch (name) {
        case 'start_workflow': return this.tools.start_workflow();
        case 'stop_workflow': return this.tools.stop_workflow();
        case 'set_press_time': return this.tools.set_press_time(Number(args.seconds));
        case 'set_confirmations': return this.tools.set_confirmations(Number(args.n));
        case 'set_models': return this.tools.set_models((args.models as string[]) ?? []);
        case 'set_reference': return this.tools.set_reference(args.kind === 'closed' ? 'closed' : 'open');
        default: return `unknown tool ${name}`;
      }
    } catch (e) {
      return `tool failed: ${(e as Error).message}`;
    }
  }

  async chat(userText: string, from = 'console', onEvent: (e: { type: 'tool'; name: string; result: string }) => void = () => {}): Promise<ChatMessage> {
    const key = process.env.OPENAI_API_KEY;
    if (!key) throw new Error('OPENAI_API_KEY missing');
    const user: ChatMessage = { id: `m${++this.seq}`, role: 'user', text: userText, at: Date.now(), from };
    this.history.push(user);
    const ctx = this.getContext();
    const recent = this.history.slice(-21, -1).map((m) => ({ role: m.role, content: m.text }));
    const content: unknown[] = [{ type: 'input_text', text: userText }];
    if (ctx.frame) content.push({ type: 'input_image', image_url: `data:image/jpeg;base64,${ctx.frame.toString('base64')}`, detail: 'low' });
    const input: unknown[] = [...recent, { role: 'user', content }];
    const instructions = `${INSTRUCTIONS}\n\nCurrent state:\n${this.stateText(ctx)}`;

    let text = '';
    for (let round = 0; round < 4; round++) {
      const data = await this.call(key, instructions, input);
      const calls = (data.output ?? []).filter((it: { type: string }) => it.type === 'function_call');
      for (const it of data.output ?? []) if (it.type === 'message') for (const c of it.content ?? []) if (c.type === 'output_text') text += c.text ?? '';
      if (!calls.length) break;
      for (const call of calls) {
        let args: Record<string, unknown> = {};
        try { args = JSON.parse(call.arguments || '{}'); } catch { /* empty */ }
        const result = this.runTool(call.name, args);
        onEvent({ type: 'tool', name: call.name, result });
        input.push({ type: 'function_call', call_id: call.call_id, name: call.name, arguments: call.arguments ?? '{}' });
        input.push({ type: 'function_call_output', call_id: call.call_id, output: result });
      }
      text = '';
    }
    const reply: ChatMessage = { id: `m${++this.seq}`, role: 'assistant', text: text.trim() || 'Done.', at: Date.now() };
    this.history.push(reply);
    if (this.history.length > 60) this.history.splice(0, this.history.length - 60);
    return reply;
  }

  private async call(key: string, instructions: string, input: unknown[]): Promise<any> {
    const cached = reasoningCache.get(this.model);
    const variants: (string | null)[] = cached !== undefined ? [cached] : /^gpt-4/.test(this.model) ? [null] : ['none', 'minimal', 'low', null];
    let lastErr = '';
    for (const effort of variants) {
      const res = await fetch('https://api.openai.com/v1/responses', {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
        body: JSON.stringify({ model: this.model, instructions, input, tools: TOOL_DEFS, tool_choice: 'auto', max_output_tokens: 900, store: false, ...(effort ? { reasoning: { effort } } : {}) }),
        signal: AbortSignal.timeout(30_000),
      });
      const body = await res.text();
      if (res.status === 400 && effort && /reasoning|effort/i.test(body)) { lastErr = body.slice(0, 200); continue; }
      if (!res.ok) throw new Error(`chat HTTP ${res.status}: ${body.slice(0, 300)}`);
      reasoningCache.set(this.model, effort);
      return JSON.parse(body);
    }
    throw new Error(`chat: no reasoning variant accepted: ${lastErr}`);
  }
}

/** Speech to text for push-to-talk audio from the glasses or the console (16 kHz mono PCM16 → WAV → OpenAI). */
export async function transcribePcm16(pcm: Buffer, sampleRate = 16000, model = process.env.STT_MODEL ?? 'gpt-4o-mini-transcribe'): Promise<string> {
  const key = process.env.OPENAI_API_KEY;
  if (!key) throw new Error('OPENAI_API_KEY missing');
  const header = Buffer.alloc(44);
  header.write('RIFF', 0); header.writeUInt32LE(36 + pcm.length, 4); header.write('WAVE', 8);
  header.write('fmt ', 12); header.writeUInt32LE(16, 16); header.writeUInt16LE(1, 20); header.writeUInt16LE(1, 22);
  header.writeUInt32LE(sampleRate, 24); header.writeUInt32LE(sampleRate * 2, 28); header.writeUInt16LE(2, 32); header.writeUInt16LE(16, 34);
  header.write('data', 36); header.writeUInt32LE(pcm.length, 40);
  const form = new FormData();
  form.append('file', new Blob([Buffer.concat([header, pcm])], { type: 'audio/wav' }), 'speech.wav');
  form.append('model', model);
  form.append('language', 'en');
  const res = await fetch('https://api.openai.com/v1/audio/transcriptions', { method: 'POST', headers: { authorization: `Bearer ${key}` }, body: form, signal: AbortSignal.timeout(20_000) });
  const body = await res.text();
  if (!res.ok) throw new Error(`stt HTTP ${res.status}: ${body.slice(0, 200)}`);
  return String(JSON.parse(body).text ?? '').trim();
}
