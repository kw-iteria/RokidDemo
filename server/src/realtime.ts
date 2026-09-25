// Persistent OpenAI Realtime session used as a low-latency vision classifier.
// One WebSocket per model; each frame is an out-of-band response (conversation: 'none') correlated
// by metadata, so several frames can be in flight at once. Reconnects lazily after any drop.
import WebSocket from 'ws';

export interface RealtimeAnswer { text: string; latency_ms: number; usage?: unknown }

interface Pending { resolve: (a: RealtimeAnswer) => void; reject: (e: Error) => void; out: string; t0: number; timer: NodeJS.Timeout; responseId?: string }

const MAX_SESSION_AGE_MS = 50 * 60_000; // OpenAI closes realtime sessions after ~60 min; recycle before that

export class RealtimeSession {
  private ws: WebSocket | null = null;
  private opening: Promise<void> | null = null;
  private openedAt = 0;
  private pending = new Map<string, Pending>();
  private idToKey = new Map<string, string>();
  private seq = 0;
  lastError = '';

  readonly model: string;
  private readonly apiKey: string;

  constructor(model: string, apiKey: string) {
    this.model = model;
    this.apiKey = apiKey;
  }

  private async ensureOpen(instructions: string): Promise<void> {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      if (Date.now() - this.openedAt > MAX_SESSION_AGE_MS && this.pending.size === 0) this.close();
      else return;
    }
    if (this.opening) return this.opening;
    this.opening = new Promise<void>((resolve, reject) => {
      const ws = new WebSocket(`wss://api.openai.com/v1/realtime?model=${this.model}`, { headers: { Authorization: `Bearer ${this.apiKey}` } });
      const timer = setTimeout(() => { ws.terminate(); reject(new Error('realtime connect timeout')); }, 8000);
      ws.on('open', () => {
        clearTimeout(timer);
        ws.send(JSON.stringify({ type: 'session.update', session: { type: 'realtime', output_modalities: ['text'], instructions } }));
        this.ws = ws;
        this.openedAt = Date.now();
        resolve();
      });
      ws.on('message', (d) => this.onMessage(d.toString()));
      ws.on('error', (e) => { clearTimeout(timer); this.lastError = e.message; reject(e); this.failAll(new Error(`realtime error: ${e.message}`)); });
      ws.on('close', (code, reason) => { this.lastError = `closed ${code} ${reason.toString()}`; if (this.ws === ws) this.ws = null; this.failAll(new Error(`realtime ${this.lastError}`)); });
    }).finally(() => { this.opening = null; });
    return this.opening;
  }

  private failAll(err: Error): void {
    for (const [key, p] of this.pending) { clearTimeout(p.timer); p.reject(err); this.pending.delete(key); }
    this.idToKey.clear();
  }

  private onMessage(raw: string): void {
    let m: any;
    try { m = JSON.parse(raw); } catch { return; }
    if (m.type === 'response.created' && m.response?.metadata?.key) {
      this.idToKey.set(m.response.id, m.response.metadata.key);
      const p = this.pending.get(m.response.metadata.key);
      if (p) p.responseId = m.response.id;
      return;
    }
    if (m.type === 'error') { this.lastError = JSON.stringify(m.error).slice(0, 200); return; }
    const rid: string | undefined = m.response_id ?? m.response?.id;
    const key = rid ? this.idToKey.get(rid) : undefined;
    const p = key ? this.pending.get(key) : undefined;
    if (!p || !key) return;
    if (m.type === 'response.output_text.delta') p.out += m.delta ?? '';
    else if (m.type === 'response.done') {
      clearTimeout(p.timer);
      this.pending.delete(key);
      if (rid) this.idToKey.delete(rid);
      if (!p.out) for (const it of m.response?.output ?? []) for (const c of it.content ?? []) if (c.text) p.out += c.text;
      if (!p.out) p.reject(new Error(`empty realtime response (status ${m.response?.status})`));
      else p.resolve({ text: p.out, latency_ms: performance.now() - p.t0, usage: m.response?.usage });
    }
  }

  async ask(jpeg: Buffer, instructions: string, question: string, opts: { timeoutMs?: number; signal?: AbortSignal } = {}): Promise<RealtimeAnswer> {
    await this.ensureOpen(instructions);
    const ws = this.ws;
    if (!ws || ws.readyState !== WebSocket.OPEN) throw new Error('realtime not connected');
    const key = `k${++this.seq}`;
    return new Promise<RealtimeAnswer>((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(key); reject(new Error('realtime timeout')); }, opts.timeoutMs ?? 8000);
      const p: Pending = { resolve, reject, out: '', t0: performance.now(), timer };
      this.pending.set(key, p);
      opts.signal?.addEventListener('abort', () => {
        if (!this.pending.has(key)) return;
        clearTimeout(timer);
        this.pending.delete(key);
        if (p.responseId) { try { ws.send(JSON.stringify({ type: 'response.cancel', response_id: p.responseId })); } catch { /* ignore */ } }
        reject(new Error('aborted'));
      }, { once: true });
      ws.send(JSON.stringify({
        type: 'response.create',
        response: {
          conversation: 'none',
          metadata: { key },
          output_modalities: ['text'],
          instructions,
          input: [{ type: 'message', role: 'user', content: [{ type: 'input_image', image_url: `data:image/jpeg;base64,${jpeg.toString('base64')}`, detail: 'low' }, { type: 'input_text', text: question }] }],
        },
      }));
    });
  }

  get inflight(): number { return this.pending.size; }
  get connected(): boolean { return this.ws?.readyState === WebSocket.OPEN; }

  close(): void {
    const ws = this.ws;
    this.ws = null;
    try { ws?.close(); } catch { /* ignore */ }
  }
}
