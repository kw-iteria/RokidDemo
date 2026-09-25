// Pretends to be the glasses: connects to /ws/glasses, streams demo frames in the binary
// envelope at 6 fps, sends hello/ping/gesture. Prints what the glasses would render.
//   node tools/sim_glasses.ts [ws://localhost:8787] [seconds]
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import WebSocket from 'ws';
import { encodeFrame } from '../server/src/frames.ts';

const base = process.argv[2] ?? 'ws://localhost:8787';
const seconds = Number(process.argv[3] ?? 30);
// --say "text" [--say "text2"]: synthesize speech (OpenAI TTS) and send it as glasses audio after 3 s, 10 s, ...
const sayTexts: string[] = [];
for (let i = 2; i < process.argv.length; i++) if (process.argv[i] === '--say') sayTexts.push(process.argv[++i]);
import { loadEnv } from '../server/src/env.ts';
loadEnv();
async function synthPcm16(text: string): Promise<Buffer> {
  const res = await fetch('https://api.openai.com/v1/audio/speech', { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${process.env.OPENAI_API_KEY}` }, body: JSON.stringify({ model: 'gpt-4o-mini-tts', voice: 'alloy', input: text, response_format: 'pcm' }) });
  if (!res.ok) throw new Error(`tts ${res.status}: ${(await res.text()).slice(0, 120)}`);
  const pcm24 = Buffer.from(await res.arrayBuffer()); // 24 kHz mono s16le
  const n = Math.floor(pcm24.length / 2 / 1.5);       // naive 24k -> 16k resample (every 3 samples -> 2)
  const out = Buffer.alloc(n * 2);
  for (let i = 0; i < n; i++) out.writeInt16LE(pcm24.readInt16LE(Math.floor(i * 1.5) * 2), i * 2);
  return out;
}
function audioEnvelope(pcm: Buffer): Buffer {
  const h = Buffer.from(JSON.stringify({ t: 'audio', rate: 16000, ts: Date.now() }));
  const b = Buffer.alloc(2 + h.length + pcm.length); b.writeUInt16BE(h.length, 0); h.copy(b, 2); pcm.copy(b, 2 + h.length); return b;
}
const dir = resolve('bench-results/sim_frames');
if (!existsSync(dir)) {
  mkdirSync(dir, { recursive: true });
  execFileSync('ffmpeg', ['-v', 'error', '-y', '-i', resolve('assets/press_demo_640.mp4'), '-vf', 'fps=6,scale=480:-2', '-q:v', '6', resolve(dir, 'f_%04d.jpg')]);
}
const files = readdirSync(dir).filter((f) => f.endsWith('.jpg')).sort();
const ws = new WebSocket(`${base}/ws/glasses`);
let i = 0, seq = 0, phase = '', offset = 0;
const t0 = Date.now();
ws.on('open', () => {
  ws.send(JSON.stringify({ t: 'hello', device: { model: 'sim-glasses', sdk: 32 } }));
  sayTexts.forEach((text, k) => setTimeout(async () => {
    try { const pcm = await synthPcm16(text); ws.send(audioEnvelope(pcm)); console.log(`${((Date.now() - t0) / 1000).toFixed(2).padStart(6)}s  SAID: "${text}" (${(pcm.length / 32000).toFixed(1)} s of audio)`); } catch (e) { console.log('say failed', (e as Error).message); }
  }, 3000 + k * 8000));
  const timer = setInterval(() => {
    if (ws.readyState !== WebSocket.OPEN) return clearInterval(timer);
    if (i >= files.length || Date.now() - t0 > seconds * 1000) { clearInterval(timer); setTimeout(() => ws.close(), 1500); return; }
    const jpeg = readFileSync(resolve(dir, files[i++]));
    ws.send(encodeFrame({ seq: seq++, ts: Date.now(), w: 480, h: 270 }, jpeg));
  }, 1000 / 6);
  setInterval(() => ws.readyState === WebSocket.OPEN && ws.send(JSON.stringify({ t: 'ping', ts: Date.now() })), 2000);
});
ws.on('message', (data, isBinary) => {
  if (isBinary) return;
  const m = JSON.parse(data.toString());
  if (m.t === 'pong') { offset = m.server_now + (Date.now() - m.ts) / 2 - Date.now(); return; }
  if (m.t === 'chat') { console.log(`${((Date.now() - t0) / 1000).toFixed(2).padStart(6)}s  CHAT ${m.role}${m.model ? ' (' + m.model + ', ' + m.ms + ' ms)' : ''}: ${String(m.text).slice(0, 120)}`); return; }
  if (m.t === 'chat.thinking') { console.log(`${((Date.now() - t0) / 1000).toFixed(2).padStart(6)}s  bubble ${m.on ? 'ON' : 'off'}${m.stt ? ' (transcribing)' : ''}`); return; }
  if (m.t !== 'state') return;
  const s = m.session;
  if (s.phase !== phase) {
    phase = s.phase;
    const cd = s.countdown ? ` ring=${((s.countdown.ends_at - (Date.now() + offset)) / 1000).toFixed(2)}s` : '';
    console.log(`${((Date.now() - t0) / 1000).toFixed(2).padStart(6)}s  HUD: ${s.phase.padEnd(12)} "${s.message}" ${s.sub ? '/ ' + s.sub : ''}${cd}  alarm=${s.alarm}  sources=${m.sources.map((x: { id: string; active: boolean; fps: number }) => `${x.id}${x.active ? '*' : ''}@${x.fps}`).join(',')}`);
  }
});
ws.on('close', () => { console.log('closed; frames sent', seq); process.exit(0); });
ws.on('error', (e) => { console.error('ws error', e.message); process.exit(1); });
