// Streaming neural text-to-speech, raw PCM 24 kHz mono 16-bit.
// Sentences are synthesized as the assistant's reply streams in and audio chunks are pushed to every
// client in the binary envelope: [u16 len][{"t":"tts",...}][pcm16 bytes], strictly in reply order.
// Voices "eleven:<voice id>" use ElevenLabs Flash v2.5 (measured ~0.18-0.22 s to first audio, a
// sentence fully generated in ~0.35 s); plain names use OpenAI gpt-4o-mini-tts (~0.5-1.8 s), which is
// also the fallback when ElevenLabs fails. Later sentences are requested while earlier ones play.

export interface VoiceConfig { enabled: boolean; voice: string; speed: number; instructions: string }
export const ELEVEN_PREFIX = 'eleven:';
/** Default voice; call after the .env is loaded (the ElevenLabs key decides the provider). */
export const defaultVoice = (): VoiceConfig => ({
  enabled: true,
  voice: process.env.ELEVENLABS_API_KEY ? `${ELEVEN_PREFIX}cgSgspJ2msm6clMCkdW9` : 'nova', // Jessica: playful, bright, warm
  speed: 1.1,
  instructions: 'A sweet, cheerful young woman with a warm, affectionate, smiling tone; upbeat and caring, clear and natural, never robotic or flat.',
});
const OPENAI_FALLBACK_VOICE = 'nova';
export const TTS_RATE = 24000;

export function ttsEnvelope(header: Record<string, unknown>, pcm: Buffer): Buffer {
  const h = Buffer.from(JSON.stringify(header));
  const out = Buffer.allocUnsafe(2 + h.length + pcm.length);
  out.writeUInt16BE(h.length, 0);
  h.copy(out, 2);
  pcm.copy(out, 2 + h.length);
  return out;
}

/** Split streamed text into speakable sentences; returns [complete sentences, remainder].
 *  `firstClause` lets the opening segment of a reply end at a clause break (comma, colon, dash)
 *  once it is long enough, so the voice can start before the first full sentence has arrived. */
export function takeSentences(buffer: string, final = false, firstClause = false): [string[], string] {
  const out: string[] = [];
  let start = 0;
  const re = /[.!?。！？]["')\]]*(?=\s)|\n/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(buffer))) {
    const end = m.index + m[0].length;
    const candidate = buffer.slice(start, end).trim();
    if (candidate.length >= 12 || (m[0] === '\n' && candidate.length >= 4)) { out.push(candidate); start = end; }
  }
  if (firstClause && !out.length) {
    const clause = /[,;:，；：—–]\s/g;
    let c: RegExpExecArray | null;
    while ((c = clause.exec(buffer))) {
      const candidate = buffer.slice(0, c.index + 1).trim();
      if (candidate.length >= 24) { out.push(candidate); start = c.index + c[0].length; break; }
    }
  }
  let rest = buffer.slice(start);
  if (final && rest.trim()) { out.push(rest.trim()); rest = ''; }
  return [out.filter(Boolean), rest];
}

const PREFETCH = 3; // synthesis requests in flight per reply
/**
 * Audio is forwarded in pieces of at least this many bytes (100 ms). ElevenLabs streams in ~440-byte
 * HTTP chunks (9 ms of audio each); forwarded one by one, a sentence was ~190 WebSocket messages,
 * each one parsed and written to the AudioTrack on the glasses. The first piece of every sentence
 * still goes out the moment it arrives, so playback starts on the first byte.
 */
const PIECE_BYTES = TTS_RATE * 2 / 10;

interface Job { text: string; previous: string; chunks: Buffer[]; done: boolean; wake: (() => void) | null; sent: number }

/**
 * Speaks one reply: call `push(delta)` as text streams in, `end()` when it is complete, `cancel()`
 * to stop. Audio chunks go to `send` in order with seq numbers; `last:true` marks the end of the reply.
 */
export class Speaker {
  private jobs: Job[] = [];        // in reply order; jobs[0] is the one currently being emitted
  private pendingText: string[] = []; // sentences waiting for a synthesis slot
  private active = 0;
  private buffer = '';
  private emitting = false;
  private ended = false;
  private cancelled = false;
  private started = false;         // any text segment taken yet (first-clause rule applies before)
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
    const [sentences, rest] = takeSentences(this.buffer, false, !this.started);
    this.buffer = rest;
    this.enqueue(sentences);
  }

  end(finalText?: string): void {
    if (this.cancelled) return;
    if (finalText !== undefined && !this.buffer && !this.started) this.buffer = finalText; // nothing streamed: speak the whole text
    const [sentences, rest] = takeSentences(this.buffer, true, !this.started);
    this.buffer = rest;
    this.enqueue(sentences);
    this.ended = true;
    void this.emit();
  }

  cancel(): void {
    this.cancelled = true;
    this.pendingText = [];
    for (const j of this.jobs) j.wake?.();
    this.jobs = [];
    this.ac.abort();
    this.send(ttsEnvelope({ t: 'tts', id: this.id, seq: this.seq++, rate: TTS_RATE, stop: true, last: true }, Buffer.alloc(0)));
  }

  private enqueue(sentences: string[]): void {
    if (!sentences.length) return;
    this.started = true;
    this.pendingText.push(...sentences);
    this.startJobs();
    void this.emit();
  }

  private lastQueuedText = '';

  private startJobs(): void {
    while (!this.cancelled && this.active < PREFETCH && this.pendingText.length) {
      const text = this.pendingText.shift()!;
      const job: Job = { text, previous: this.lastQueuedText, chunks: [], done: false, wake: null, sent: 0 };
      this.lastQueuedText = text;
      this.jobs.push(job);
      this.active++;
      void this.synth(job).finally(() => {
        job.done = true;
        this.active--;
        job.wake?.();
        this.startJobs();
      });
    }
  }

  /** Sends audio strictly in reply order: the head job's chunks as they arrive, then the next job. */
  private async emit(): Promise<void> {
    if (this.emitting) return;
    this.emitting = true;
    try {
      while (!this.cancelled) {
        const job = this.jobs[0];
        if (!job) {
          if (this.ended && !this.pendingText.length && !this.buffer) {
            this.send(ttsEnvelope({ t: 'tts', id: this.id, seq: this.seq++, rate: TTS_RATE, last: true }, Buffer.alloc(0)));
          }
          return;
        }
        while (job.chunks.length) {
          // the sentence text rides along once, on the first piece (clients only display it)
          const header: Record<string, unknown> = { t: 'tts', id: this.id, seq: this.seq++, rate: TTS_RATE };
          if (!job.sent++) header.text = job.text;
          this.send(ttsEnvelope(header, job.chunks.shift()!));
        }
        if (job.done) { this.jobs.shift(); continue; }
        await new Promise<void>((r) => { job.wake = r; });
        job.wake = null;
      }
    } finally {
      this.emitting = false;
      if (!this.cancelled && this.jobs.length && this.jobs[0].chunks.length) void this.emit();
    }
  }

  private async synth(job: Job): Promise<void> {
    const signal = AbortSignal.any([this.ac.signal, AbortSignal.timeout(20_000)]);
    const eleven = this.cfg.voice.startsWith(ELEVEN_PREFIX) && process.env.ELEVENLABS_API_KEY;
    try {
      if (eleven) {
        const res = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(this.cfg.voice.slice(ELEVEN_PREFIX.length))}/stream?output_format=pcm_${TTS_RATE}`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'xi-api-key': process.env.ELEVENLABS_API_KEY! },
          body: JSON.stringify({
            text: job.text,
            model_id: 'eleven_flash_v2_5',
            ...(job.previous ? { previous_text: job.previous } : {}), // keeps intonation continuous across sentence splits
            voice_settings: { speed: Math.max(0.7, Math.min(1.2, this.cfg.speed)) },
          }),
          signal,
        });
        if (res.ok && res.body) { await this.readPcm(res, job); return; }
        this.onError(`elevenlabs HTTP ${res.status}: ${(await res.text()).slice(0, 160)}; falling back to OpenAI`);
      }
      const key = process.env.OPENAI_API_KEY;
      if (!key) { this.onError('OPENAI_API_KEY missing'); return; }
      const res = await fetch('https://api.openai.com/v1/audio/speech', {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
        body: JSON.stringify({ model: 'gpt-4o-mini-tts', voice: eleven || this.cfg.voice.startsWith(ELEVEN_PREFIX) ? OPENAI_FALLBACK_VOICE : this.cfg.voice, input: job.text, response_format: 'pcm', speed: this.cfg.speed, instructions: this.cfg.instructions }),
        signal,
      });
      if (!res.ok || !res.body) { this.onError(`tts HTTP ${res.status}: ${(await res.text()).slice(0, 160)}`); return; }
      await this.readPcm(res, job);
    } catch (e) {
      if (!this.cancelled) this.onError((e as Error).message);
    }
  }

  /** Streams 16-bit PCM from a response into the job in PIECE_BYTES pieces, keeping sample alignment across reads. */
  private async readPcm(res: Response, job: Job): Promise<void> {
    const reader = res.body!.getReader();
    let carry = Buffer.alloc(0);
    const parts: Buffer[] = [];
    let size = 0;
    const flush = () => { if (!size) return; job.chunks.push(parts.length === 1 ? parts[0] : Buffer.concat(parts, size)); parts.length = 0; size = 0; job.wake?.(); };
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      if (this.cancelled) { await reader.cancel(); return; }
      const bytes = Buffer.from(value.buffer, value.byteOffset, value.byteLength);
      let chunk = carry.length ? Buffer.concat([carry, bytes]) : bytes;
      if (chunk.length % 2) { carry = chunk.subarray(chunk.length - 1); chunk = chunk.subarray(0, chunk.length - 1); } else carry = Buffer.alloc(0);
      if (!chunk.length) continue;
      const first = !job.sent && !job.chunks.length; // nothing of this sentence has gone out yet
      parts.push(chunk); size += chunk.length;
      if (first || size >= PIECE_BYTES) flush();
    }
    flush();
  }
}
