// Chat agent for the console and the glasses. General chatbot + workflow control.
// Two models: a fast text model for ordinary conversation and tool calls, and a vision-capable
// model when the question is about what the camera sees. Replies stream token by token.
import type { SessionSnapshot } from './session.ts';
import { streamChat, type ChatMsg, type ChatTool, type ToolCall } from './chat.ts';

export interface ChatMessage { id: string; role: 'user' | 'assistant'; text: string; at: number; from?: string; model?: string; ms?: number }

export interface AgentContext {
  state: SessionSnapshot;
  camera: { live: boolean; source: string | null; fps: number };
  config: { models: string[]; countdown_ms: number; confirmations: number };
  stats: { p50_ms: number; decisions_per_s: number };
  frame: Buffer | null;
  refs?: { label: string; jpeg: Buffer }[]; // a couple of reference photos for camera questions
}

/** Replies are spoken and shown on a tiny display: drop markdown decorations. */
export function stripMarkdown(t: string): string {
  return t
    .replace(/\*\*(.*?)\*\*/g, '$1').replace(/__(.*?)__/g, '$1')
    .replace(/(^|\s)\*(\S[^*]*)\*(?=\s|$|[.,!?])/g, '$1$2').replace(/`([^`]*)`/g, '$1')
    .replace(/^#{1,6}\s+/gm, '').replace(/^\s*[-*]\s+/gm, '- ')
    .trim();
}

export interface AgentTools {
  start_workflow: () => string;
  stop_workflow: () => string;
  set_press_time: (seconds: number) => string;
  set_confirmations: (n: number) => string;
  set_models: (models: string[]) => string;
  set_reference: (kind: 'open' | 'closed') => string;
}

export interface AgentModels { fast: string; vision: string }

const TOOL_DEFS: ChatTool[] = [
  { type: 'function', function: { name: 'start_workflow', description: 'Start (or restart) the plate-press workflow: detect the press, then guide close → countdown → open.', parameters: { type: 'object', properties: {}, additionalProperties: false } } },
  { type: 'function', function: { name: 'stop_workflow', description: 'Stop the workflow and go back to standby.', parameters: { type: 'object', properties: {}, additionalProperties: false } } },
  { type: 'function', function: { name: 'set_press_time', description: 'Change how long the press must stay closed, in seconds.', parameters: { type: 'object', properties: { seconds: { type: 'number' } }, required: ['seconds'], additionalProperties: false } } },
  { type: 'function', function: { name: 'set_confirmations', description: 'Consecutive agreeing camera verdicts needed before a state change (1-5).', parameters: { type: 'object', properties: { n: { type: 'integer' } }, required: ['n'], additionalProperties: false } } },
  { type: 'function', function: { name: 'set_models', description: 'Choose the vision model(s) for press detection.', parameters: { type: 'object', properties: { models: { type: 'array', items: { type: 'string' } } }, required: ['models'], additionalProperties: false } } },
  { type: 'function', function: { name: 'set_reference', description: 'Save the current camera frame as the reference photo of the press in the given lid state.', parameters: { type: 'object', properties: { kind: { type: 'string', enum: ['open', 'closed'] } }, required: ['kind'], additionalProperties: false } } },
];

const INSTRUCTIONS = `You are the Iteria assistant: a general-purpose, friendly chatbot that also operates the plate-press workflow in a lab. The operator talks to you from a desktop console or through Rokid smart glasses.
Answer anything: general knowledge, science, lab questions, math, small talk, translations, advice. Be accurate; say when you are unsure.
The workflow you run: find the plate press, ask the operator to close it, count down while it is closed, then ask them to open it, then report completion. The workflow runs by itself on the server; you only start or stop it.
The plate press in this lab looks like a small white / silver rectangular case with a hinged lid (about the size of a glasses case). When you see that white box, that IS the plate press; call it "the press". Reference photos of it (open and closed) may be attached before the live frame.
Tools: when the operator asks to start, begin, run, or do the workflow (any wording), call start_workflow. "Stop", "cancel", "standby" → stop_workflow. Change timing or settings with the matching tool. Never claim a tool ran unless you called it.
After a tool call you receive its result; then answer with ONE short sentence that states that result only (for example "Workflow started, looking for the press."). Never narrate, simulate or predict the following steps, countdowns or detections; the operator is guided by the glasses display.
Style: replies are read aloud in the glasses, so keep them short (one to three sentences) unless the operator asks for detail, a list, or an explanation; then answer fully. Plain text only: no markdown, no bold, no headings; simple numbered lists are fine on request.
When asked what you see, describe the attached camera frame plainly and say whether the press is visible and open or closed. If no frame is attached or the camera is not live, say the camera is not live.`;

/** Does this message need the camera picture (vision model) rather than just text? */
export function needsVision(text: string): boolean {
  return /\b(see|seeing|look|looking|view|camera|frame|picture|image|photo|scene|visible|in front|what is this|what's this|describe|open or closed|is it (open|closed)|is the (press|box|lid)|what colou?r|how many|read (the|this)|table|bench)\b/i.test(text);
}

export class Agent {
  history: ChatMessage[] = [];
  models: AgentModels;
  private getContext: () => AgentContext;
  private tools: AgentTools;
  private seq = 0;

  constructor(models: AgentModels, getContext: () => AgentContext, tools: AgentTools) {
    this.models = models;
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
      `press_time_s=${ctx.config.countdown_ms / 1000} confirmations=${ctx.config.confirmations} detection_models=${ctx.config.models.join('+')} verdict_latency_p50_ms=${ctx.stats.p50_ms}`,
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

  /**
   * One conversational turn. `onDelta` receives streamed text; `onEvent` reports tool calls and the model used.
   */
  async chat(
    userText: string,
    from = 'console',
    onDelta: (id: string, delta: string) => void = () => {},
    onEvent: (e: { type: 'tool'; name: string; result: string } | { type: 'model'; model: string; vision: boolean }) => void = () => {},
  ): Promise<ChatMessage> {
    const user: ChatMessage = { id: `m${++this.seq}`, role: 'user', text: userText, at: Date.now(), from };
    this.history.push(user);
    const replyId = `m${++this.seq}`;
    const ctx = this.getContext();
    const vision = needsVision(userText) && Boolean(ctx.frame);
    const model = vision ? this.models.vision : this.models.fast;
    onEvent({ type: 'model', model, vision });

    const messages: ChatMsg[] = [{ role: 'system', content: `${INSTRUCTIONS}\n\nCurrent state:\n${this.stateText(ctx)}` }];
    for (const m of this.history.slice(-21, -1)) messages.push({ role: m.role, content: m.text });
    if (vision && ctx.frame) {
      const parts: ChatMsg['content'] = [];
      for (const r of ctx.refs ?? []) {
        (parts as Exclude<ChatMsg['content'], string | null>).push({ type: 'text', text: `Reference photo, ${r.label}:` });
        (parts as Exclude<ChatMsg['content'], string | null>).push({ type: 'image_url', image_url: { url: `data:image/jpeg;base64,${r.jpeg.toString('base64')}`, detail: 'low' } });
      }
      (parts as Exclude<ChatMsg['content'], string | null>).push({ type: 'text', text: `Live camera frame now. ${userText}` });
      (parts as Exclude<ChatMsg['content'], string | null>).push({ type: 'image_url', image_url: { url: `data:image/jpeg;base64,${ctx.frame.toString('base64')}`, detail: 'low' } });
      messages.push({ role: 'user', content: parts });
    } else messages.push({ role: 'user', content: userText });

    const t0 = performance.now();
    let text = '';
    let usedModel = model;
    for (let round = 0; round < 4; round++) {
      let r;
      try {
        r = await streamChat(model, messages, { tools: TOOL_DEFS, maxTokens: 900, onDelta: (d) => { text += d; onDelta(replyId, d); } });
      } catch (e) {
        // fall back to the vision model (OpenAI) if the fast vendor fails
        if (model !== this.models.vision) {
          usedModel = this.models.vision;
          r = await streamChat(this.models.vision, messages, { tools: TOOL_DEFS, maxTokens: 900, onDelta: (d) => { text += d; onDelta(replyId, d); } });
        } else throw e;
      }
      if (!r.toolCalls.length) break;
      messages.push({ role: 'assistant', content: r.text || null, tool_calls: r.toolCalls });
      for (const call of r.toolCalls as ToolCall[]) {
        let args: Record<string, unknown> = {};
        try { args = JSON.parse(call.function.arguments || '{}'); } catch { /* empty */ }
        const result = this.runTool(call.function.name, args);
        onEvent({ type: 'tool', name: call.function.name, result });
        messages.push({ role: 'tool', tool_call_id: call.id, name: call.function.name, content: result });
      }
      text = '';
    }
    const reply: ChatMessage = { id: replyId, role: 'assistant', text: stripMarkdown(text) || 'Done.', at: Date.now(), model: usedModel, ms: Math.round(performance.now() - t0) };
    this.history.push(reply);
    if (this.history.length > 60) this.history.splice(0, this.history.length - 60);
    return reply;
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
