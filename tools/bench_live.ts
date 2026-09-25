// Persistent-session latency experiment: one WebSocket per model (OpenAI Realtime, Gemini Live),
// then sequential per-frame questions. Compares against the request/response path in bench.ts.
//   node tools/bench_live.ts [--models a,b] [--n 12]
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import WebSocket from 'ws';
import { loadEnv } from '../server/src/env.ts';
import { DEFAULT_PROMPT, type LidState } from '../server/src/vision.ts';

loadEnv();
const args = new Map<string, string>();
for (let i = 2; i < process.argv.length; i++) if (process.argv[i].startsWith('--')) args.set(process.argv[i].slice(2), process.argv[i + 1] ?? 'true');
const MODELS = (args.get('models') ?? 'gpt-realtime-2.1-mini,gpt-realtime-mini,gemini-3.1-flash-live-preview,gemini-3.8-live').split(',');
const TRUTH: Record<number, LidState> = {};
for (const i of [1, 2, 3, 4, 25]) TRUTH[i] = 'open';
for (const i of [5, 6, 7, 23, 24]) TRUTH[i] = 'partial';
for (let i = 8; i <= 22; i++) TRUTH[i] = 'closed';
const IDS = (args.get('frames') === 'all' ? Object.keys(TRUTH).map(Number) : [1, 3, 4, 5, 7, 8, 9, 14, 20, 23, 24, 25]).slice(0, Number(args.get('n') ?? 99));
const CONC = Number(args.get('concurrency') ?? 1);
const frames = IDS.map((id) => ({ id, truth: TRUTH[id], b64: readFileSync(resolve('bench-results/frames_480', `f_${String(id).padStart(3, '0')}.jpg`)).toString('base64') }));
const ASK = 'Report the state of the press in this frame as the JSON object.';
const pct = (xs: number[], p: number) => { const s = [...xs].sort((a, b) => a - b); return s.length ? Math.round(s[Math.min(s.length - 1, Math.floor(p * s.length))]) : NaN; };
const parseLid = (t: string) => { try { const m = t.match(/\{[\s\S]*\}/); return String(JSON.parse(m ? m[0] : t).lid ?? '?'); } catch { return '?'; } };

function waitOpen(ws: WebSocket): Promise<void> { return new Promise((res, rej) => { ws.once('open', res); ws.once('error', rej); }); }

async function openaiRealtime(model: string) {
  const ws = new WebSocket(`wss://api.openai.com/v1/realtime?model=${model}`, { headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}` } });
  await waitOpen(ws);
  ws.send(JSON.stringify({ type: 'session.update', session: { type: 'realtime', output_modalities: ['text'], instructions: DEFAULT_PROMPT } }));
  const pending = new Map<string, { resolve: (t: string) => void; out: string; timer: NodeJS.Timeout }>();
  const idToKey = new Map<string, string>();
  ws.on('message', (d) => {
    const m = JSON.parse(d.toString());
    if (m.type === 'response.created' && m.response?.metadata?.key) idToKey.set(m.response.id, m.response.metadata.key);
    const key = m.response_id ? idToKey.get(m.response_id) : m.response?.id ? idToKey.get(m.response.id) : undefined;
    const p = key ? pending.get(key) : undefined;
    if (!p) { if (m.type === 'error') console.log('  error event:', JSON.stringify(m.error).slice(0, 200)); return; }
    if (m.type === 'response.output_text.delta') p.out += m.delta ?? '';
    else if (m.type === 'response.done') {
      clearTimeout(p.timer); pending.delete(key!);
      if (!p.out) { for (const it of m.response?.output ?? []) for (const c of it.content ?? []) if (c.text) p.out += c.text; }
      p.resolve(p.out || `EMPTY status=${m.response?.status} ${JSON.stringify(m.response?.status_details ?? '').slice(0, 120)}`);
    }
  });
  const ask = (f: { id: number; b64: string }) => new Promise<string>((resolve) => {
    const key = `f${f.id}-${Math.random().toString(36).slice(2, 6)}`;
    const timer = setTimeout(() => { pending.delete(key); resolve('TIMEOUT'); }, 15_000);
    pending.set(key, { resolve, out: '', timer });
    ws.send(JSON.stringify({ type: 'response.create', response: { conversation: 'none', metadata: { key }, output_modalities: ['text'], instructions: DEFAULT_PROMPT, input: [{ type: 'message', role: 'user', content: [{ type: 'input_image', image_url: `data:image/jpeg;base64,${f.b64}`, detail: 'low' }, { type: 'input_text', text: ASK }] }] } }));
  });
  const lat: number[] = []; const rows: string[] = []; let errors = 0, exact = 0, strictN = 0, strictOk = 0;
  const t0all = performance.now();
  let next = 0;
  await Promise.all(Array.from({ length: CONC }, async () => {
    while (next < frames.length) {
      const f = frames[next++];
      const t0 = performance.now();
      const text = await ask(f);
      const ms = performance.now() - t0;
      const bad = text.startsWith('ERROR') || text === 'TIMEOUT' || text.startsWith('EMPTY');
      if (bad) errors++; else lat.push(ms);
      const lid = parseLid(text);
      if (lid === f.truth) exact++;
      if (f.truth !== 'partial') { strictN++; if (lid === f.truth) strictOk++; }
      rows.push(`  f${String(f.id).padStart(2)} truth=${f.truth.padEnd(7)} got=${lid.padEnd(7)} ${Math.round(ms)}ms ${bad || lid === '?' ? text.slice(0, 140).replace(/\n/g, ' ') : ''}`);
    }
  }));
  const wall = performance.now() - t0all;
  ws.close();
  rows.sort();
  rows.push(`  exact=${(exact / frames.length).toFixed(2)} strict=${(strictOk / (strictN || 1)).toFixed(2)} wall=${Math.round(wall)}ms throughput=${(frames.length / (wall / 1000)).toFixed(2)}/s concurrency=${CONC}`);
  return { lat, rows, errors };
}

async function geminiLive(model: string) {
  const ws = new WebSocket(`wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent?key=${process.env.GEMINI_API_KEY}`);
  await waitOpen(ws);
  const setupDone = new Promise<string>((res) => {
    const timer = setTimeout(() => res('setup timeout'), 10_000);
    ws.once('message', (d) => { clearTimeout(timer); const m = JSON.parse(d.toString()); res(m.setupComplete ? 'ok' : JSON.stringify(m).slice(0, 200)); });
    ws.once('close', (code, reason) => { clearTimeout(timer); res(`closed ${code} ${reason.toString()}`); });
  });
  ws.send(JSON.stringify({ setup: { model: `models/${model}`, generationConfig: { responseModalities: ['TEXT'], temperature: 0 }, systemInstruction: { parts: [{ text: DEFAULT_PROMPT }] } } }));
  const setup = await setupDone;
  if (setup !== 'ok') { ws.close(); return { lat: [], rows: [`  setup failed: ${setup}`], errors: frames.length }; }
  const lat: number[] = []; const rows: string[] = []; let errors = 0;
  for (const f of frames) {
    const t0 = performance.now();
    const text = await new Promise<string>((res) => {
      let out = '';
      const timer = setTimeout(() => { ws.off('message', h); res('TIMEOUT'); }, 15_000);
      const h = (d: WebSocket.RawData) => {
        const m = JSON.parse(d.toString());
        const sc = m.serverContent;
        if (sc?.modelTurn?.parts) for (const p of sc.modelTurn.parts) out += p.text ?? '';
        if (sc?.turnComplete) { clearTimeout(timer); ws.off('message', h); res(out); }
        if (m.error) { clearTimeout(timer); ws.off('message', h); res('ERROR ' + JSON.stringify(m.error).slice(0, 200)); }
      };
      ws.on('message', h);
      ws.once('close', (code, reason) => { clearTimeout(timer); res(`ERROR closed ${code} ${reason.toString().slice(0, 120)}`); });
      ws.send(JSON.stringify({ clientContent: { turns: [{ role: 'user', parts: [{ inlineData: { mimeType: 'image/jpeg', data: f.b64 } }, { text: ASK }] }], turnComplete: true } }));
    });
    const ms = performance.now() - t0;
    if (text.startsWith('ERROR') || text === 'TIMEOUT') errors++; else lat.push(ms);
    rows.push(`  f${String(f.id).padStart(2)} truth=${f.truth.padEnd(7)} got=${parseLid(text).padEnd(7)} ${Math.round(ms)}ms ${text.startsWith('ERROR') || text === 'TIMEOUT' ? text.slice(0, 160) : ''}`);
    if (text.startsWith('ERROR closed')) break;
  }
  ws.close();
  return { lat, rows, errors };
}

const summary: Record<string, unknown>[] = [];
for (const model of MODELS) {
  try {
    const r = model.startsWith('gemini') ? await geminiLive(model) : await openaiRealtime(model);
    console.log(`\n=== ${model} (persistent session) ===  p50=${pct(r.lat, 0.5)}ms p90=${pct(r.lat, 0.9)}ms n=${r.lat.length} errors=${r.errors}`);
    console.log(r.rows.join('\n'));
    const acc = r.rows.find((x) => x.includes('exact='))?.match(/exact=([\d.]+) strict=([\d.]+)/);
    summary.push({ model, n: frames.length, errors: r.errors, p50_ms: pct(r.lat, 0.5), p90_ms: pct(r.lat, 0.9), exact_acc: acc ? Number(acc[1]) : null, strict_acc: acc ? Number(acc[2]) : null, persistent: true, concurrency: CONC });
  } catch (e) {
    console.log(`\n=== ${model} === failed: ${(e as Error).message}`);
  }
}
mkdirSync('bench-results', { recursive: true });
const file = `bench-results/bench_live_${new Date().toISOString().replace(/[:.]/g, '-')}.json`;
writeFileSync(file, JSON.stringify({ frames: IDS, summary }, null, 2));
console.log('saved', file);
