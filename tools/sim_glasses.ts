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
