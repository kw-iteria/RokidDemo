// Streaming neural text-to-speech (OpenAI gpt-4o-mini-tts, raw PCM 24 kHz mono 16-bit).
// Sentences are synthesized in order as the assistant's reply streams in, and audio chunks are
// pushed to every client in the binary envelope: [u16 len][{"t":"tts",...}][pcm16 bytes].

export interface VoiceConfig { enabled: boolean; voice: string; speed: number; instructions: string }
export const DEFAULT_VOICE: VoiceConfig = { enabled: true, voice: 'nova', speed: 1.25, instructions: 'A sweet, cheerful young woman with a warm, affectionate, smiling tone; upbeat and caring, clear and natural, never robotic or flat.' };
export const TTS_RATE = 24000;

export function ttsEnvelope(header: Record<string, unknown>, pcm: Buffer): Buffer {
  const h = Buffer.from(JSON.stringify(header));
  const out = Buffer.allocUnsafe(2 + h.length + pcm.length);
  out.writeUInt16BE(h.length, 0);
  h.copy(out, 2);
  pcm.copy(out, 2 + h.length);
  return out;
}

/** Split streamed text into speakable sentences; returns [complete sentences, remainder]. */
export function takeSentences(buffer: string, final = false): [string[], string] {
  const out: string[] = [];
  let start = 0;
  const re = /[.!?。！？]["')\]]*(?=\s)|\n/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(buffer))) {
    const end = m.index + m[0].length;
    const candidate = buffer.slice(start, end).trim();
    if (candidate.length >= 12 || (m[0] === '\n' && candidate.length >= 4)) { out.push(candidate); start = end; }
  }
  let rest = buffer.slice(start);
  if (final && rest.trim()) { out.push(rest.trim()); rest = ''; }
  return [out.filter(Boolean), rest];
}

/**
 * Speaks one reply: call `push(delta)` as text streams in, `end()` when it is complete, `cancel()`
 * to stop. Audio chunks go to `send` in order with seq numbers; `last:true` marks the end of the reply.
 */
export class Speaker {
  private queue: string[] = [];
  private buffer = '';
  private working = false;
  private ended = false;
  private cancelled = false;
  private seq = 0;
  private ac = new AbortController();
  private readonly id: string;
  private readonly cfg: VoiceConfig;
  private readonly send: (buf: Buffer) => void;
  private readonly onError: (e: string) => void;

  constructor(id: string, cfg: VoiceConfig, send: (buf: Buffer) => void, onError: (e: string) => void) {
    this.id = id;
    this.cfg = cfg;
    this.send = send;
    this.onError = onError;
  }

  push(delta: string): void {
    if (this.cancelled) return;
    this.buffer += delta;
    const [sentences, rest] = takeSentences(this.buffer);
    this.buffer = rest;
    if (sentences.length) { this.queue.push(...sentences); void this.work(); }
  }

  end(finalText?: string): void {
    if (this.cancelled) return;
    if (finalText !== undefined && !this.buffer && !this.queue.length && this.seq === 0 && !this.working) this.buffer = finalText; // nothing streamed: speak the whole text
    const [sentences, rest] = takeSentences(this.buffer, true);
    this.buffer = rest;
    this.queue.push(...sentences);
    this.ended = true;
    void this.work();
  }

  cancel(): void {
    this.cancelled = true;
    this.queue = [];
    this.ac.abort();
    this.send(ttsEnvelope({ t: 'tts', id: this.id, seq: this.seq++, rate: TTS_RATE, stop: true, last: true }, Buffer.alloc(0)));
  }

  private async work(): Promise<void> {
    if (this.working) return;
    this.working = true;
    try {
      while (this.queue.length && !this.cancelled) {
        const sentence = this.queue.shift()!;
        await this.synth(sentence);
      }
      if (this.ended && !this.cancelled && !this.queue.length) this.send(ttsEnvelope({ t: 'tts', id: this.id, seq: this.seq++, rate: TTS_RATE, last: true }, Buffer.alloc(0)));
    } finally {
      this.working = false;
      if (this.queue.length && !this.cancelled) void this.work();
    }
  }

  private async synth(text: string): Promise<void> {
    const key = process.env.OPENAI_API_KEY;
    if (!key) { this.onError('OPENAI_API_KEY missing'); return; }
    try {
      const res = await fetch('https://api.openai.com/v1/audio/speech', {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
        body: JSON.stringify({ model: 'gpt-4o-mini-tts', voice: this.cfg.voice, input: text, response_format: 'pcm', speed: this.cfg.speed, instructions: this.cfg.instructions }),
        signal: AbortSignal.any([this.ac.signal, AbortSignal.timeout(20_000)]),
      });
      if (!res.ok || !res.body) { this.onError(`tts HTTP ${res.status}: ${(await res.text()).slice(0, 160)}`); return; }
      const reader = res.body.getReader();
      let carry = Buffer.alloc(0);
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        if (this.cancelled) { await reader.cancel(); return; }
        let chunk = carry.length ? Buffer.concat([carry, Buffer.from(value)]) : Buffer.from(value);
        if (chunk.length % 2) { carry = chunk.subarray(chunk.length - 1); chunk = chunk.subarray(0, chunk.length - 1); } else carry = Buffer.alloc(0);
        if (chunk.length) this.send(ttsEnvelope({ t: 'tts', id: this.id, seq: this.seq++, rate: TTS_RATE, text }, chunk));
      }
    } catch (e) {
      if (!this.cancelled) this.onError((e as Error).message);
    }
  }
}
