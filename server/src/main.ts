// PlatePress guide server: takes camera frames from the Rokid glasses (or a browser webcam,
// or a replayed clip), runs the vision model, drives the workflow state machine, and pushes
// the same state to the glasses HUD and the desktop dashboard.
import http from 'node:http';
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { extname, resolve } from 'node:path';
import { WebSocketServer, WebSocket } from 'ws';
import { loadEnv } from './env.ts';
import { decodeFrame, encodeFrame, type Frame } from './frames.ts';
import { PressSession, DEFAULT_PARAMS, type SessionParams } from './session.ts';
import { Detector } from './detector.ts';
import { startReplay } from './replay.ts';
import { startBeacon, lanAddresses } from './beacon.ts';
import { CANDIDATE_MODELS, DEFAULT_PROMPT } from './vision.ts';

loadEnv();
const ROOT = resolve(import.meta.dirname, '..', '..');
const WEB = resolve(ROOT, 'server', 'web');
const PORT = Number(process.env.PORT ?? 8787);
const CONFIG_FILE = resolve(ROOT, 'config.local.json');

interface AppConfig {
  models: string[];
  maxInflight: number;
  minIntervalMs: number;
  timeoutMs: number;
  prompt: string;
  source: string; // 'auto' | source id
  params: SessionParams;
}
const config: AppConfig = {
  models: (process.env.PRESS_MODELS ?? 'gpt-realtime-mini,gpt-4.1-mini').split(',').map((s) => s.trim()).filter(Boolean),
  maxInflight: 4,
  minIntervalMs: 150,
  timeoutMs: 8000,
  prompt: DEFAULT_PROMPT,
  source: 'auto',
  params: { ...DEFAULT_PARAMS },
};
if (existsSync(CONFIG_FILE)) {
  try { Object.assign(config, JSON.parse(readFileSync(CONFIG_FILE, 'utf8'))); } catch (e) { console.warn('config.local.json ignored:', (e as Error).message); }
}
function persist(): void {
  const { models, maxInflight, minIntervalMs, timeoutMs, prompt, params } = config;
  writeFileSync(CONFIG_FILE, JSON.stringify({ models, maxInflight, minIntervalMs, timeoutMs, prompt, params }, null, 2));
}

// ----------------------------------------------------------------------------- core
const session = new PressSession(config.params);
const detector = new Detector({ models: config.models, maxInflight: config.maxInflight, minIntervalMs: config.minIntervalMs, prompt: config.prompt, timeoutMs: config.timeoutMs });

interface Source { id: string; kind: 'glasses' | 'webcam' | 'replay'; ws?: WebSocket; lastFrameAt: number; frames: number[]; seq: number; info?: unknown }
const sources = new Map<string, Source>();
const desktops = new Set<WebSocket>();
const glassesClients = new Set<WebSocket>();
let latestFrame: Frame | null = null;
let lastRelayAt = 0;
const logLines: { at: number; level: string; text: string }[] = [];

function log(level: 'info' | 'warn' | 'error', text: string): void {
  const line = { at: Date.now(), level, text };
  logLines.push(line);
  if (logLines.length > 200) logLines.shift();
  (level === 'error' ? console.error : level === 'warn' ? console.warn : console.log)(`[${new Date(line.at).toISOString().slice(11, 23)}] ${text}`);
  broadcast(JSON.stringify({ t: 'log', ...line }));
}

function activeSourceId(): string | null {
  const now = Date.now();
  const alive = [...sources.values()].filter((s) => now - s.lastFrameAt < 2500);
  if (config.source !== 'auto') return sources.has(config.source) ? config.source : null;
  const order: Source['kind'][] = ['glasses', 'webcam', 'replay'];
  for (const k of order) { const s = alive.find((x) => x.kind === k); if (s) return s.id; }
  return null;
}

function sourceFps(s: Source): number {
  const now = Date.now();
  s.frames = s.frames.filter((t) => now - t <= 2000);
  return +(s.frames.length / 2).toFixed(1);
}

function onFrame(source: Source, frame: Frame): void {
  source.lastFrameAt = frame.recv_ts;
  source.frames.push(frame.recv_ts);
  source.seq++;
  if (activeSourceId() !== source.id) return;
  frame.header.src = source.id;
  latestFrame = frame;
  if (session.phase === 'IDLE') session.start();
  detector.offer(frame);
  // Relay a live preview to the dashboards (throttled, drop when a client is congested).
  const now = Date.now();
  if (now - lastRelayAt >= 70) {
    lastRelayAt = now;
    const payload = encodeFrame({ ...frame.header, recv_ts: frame.recv_ts }, frame.jpeg);
    for (const ws of desktops) if (ws.readyState === WebSocket.OPEN && ws.bufferedAmount < 512_000) ws.send(payload);
  }
}

detector.onVerdict = (v) => {
  session.onVerdict({ verdict: v.verdict, frame_ts: v.frame.recv_ts, latency_ms: v.latency_ms, model: v.model, seq: v.frame.header.seq });
  broadcast(JSON.stringify({ t: 'verdict', ...v.verdict, latency_ms: Math.round(v.latency_ms), model: v.model, seq: v.frame.header.seq, frame_ts: v.frame.recv_ts, server_now: Date.now() }));
};
detector.onError = (model, err) => log('warn', `model error (${model}): ${err.slice(0, 200)}`);
session.onChange((snap, changed) => { if (changed) { log('info', `phase → ${snap.phase}`); broadcastState(); } });
setInterval(() => { if (session.phase !== 'IDLE' && !activeSourceId()) session.idle(); session.tick(); }, 100);
setInterval(() => broadcastState(), 500);
detector.start();

function stateMessage(): string {
  const now = Date.now();
  return JSON.stringify({
    t: 'state',
    server_now: now,
    session: session.snapshot(now),
    stats: detector.stats(),
    config: { models: config.models, maxInflight: config.maxInflight, minIntervalMs: config.minIntervalMs, timeoutMs: config.timeoutMs, source: config.source, params: config.params },
    sources: [...sources.values()].map((s) => ({ id: s.id, kind: s.kind, fps: sourceFps(s), alive: now - s.lastFrameAt < 2500, active: activeSourceId() === s.id, info: s.info ?? null })),
    hosts: lanAddresses(),
    port: PORT,
  });
}
function broadcast(msg: string): void {
  for (const ws of desktops) if (ws.readyState === WebSocket.OPEN) ws.send(msg);
  for (const ws of glassesClients) if (ws.readyState === WebSocket.OPEN) ws.send(msg);
}
function broadcastState(): void { broadcast(stateMessage()); }

// ----------------------------------------------------------------------------- replay
let replay: { stop: () => void } | null = null;
function startReplaySource(loop: boolean, fps = 6): void {
  stopReplaySource();
  const id = 'replay';
  const src: Source = { id, kind: 'replay', lastFrameAt: 0, frames: [], seq: 0, info: { file: 'assets/press_demo_640.mp4', fps, loop } };
  sources.set(id, src);
  replay = startReplay({
    file: resolve(ROOT, 'assets', 'press_demo_640.mp4'), fps, width: 480, loop,
    onFrame: (jpeg, index) => onFrame(src, { header: { seq: index, ts: Date.now() }, jpeg, recv_ts: Date.now() }),
    onEnd: () => { sources.delete(id); replay = null; log('info', 'replay finished'); broadcastState(); },
  });
  log('info', `replay started (${fps} fps${loop ? ', loop' : ''})`);
}
function stopReplaySource(): void { if (replay) { replay.stop(); replay = null; sources.delete('replay'); } }

// ----------------------------------------------------------------------------- commands
function applyCommand(msg: Record<string, unknown>, from: string): void {
  switch (msg.cmd) {
    case 'restart': session.gesture('restart'); log('info', `restart (${from})`); break;
    case 'set': {
      const c = (msg.config ?? {}) as Partial<AppConfig>;
      if (Array.isArray(c.models) && c.models.length) config.models = c.models.map(String);
      if (typeof c.maxInflight === 'number') config.maxInflight = Math.max(1, Math.min(6, c.maxInflight));
      if (typeof c.minIntervalMs === 'number') config.minIntervalMs = Math.max(50, c.minIntervalMs);
      if (typeof c.timeoutMs === 'number') config.timeoutMs = Math.max(1000, c.timeoutMs);
      if (typeof c.prompt === 'string' && c.prompt.trim()) config.prompt = c.prompt;
      if (typeof c.source === 'string') config.source = c.source;
      if (c.params && typeof c.params === 'object') { config.params = { ...config.params, ...c.params }; session.setParams(config.params); }
      Object.assign(detector.config, { models: config.models, maxInflight: config.maxInflight, minIntervalMs: config.minIntervalMs, prompt: config.prompt, timeoutMs: config.timeoutMs });
      persist();
      log('info', `config updated (${from}): models=${config.models.join('+')} inflight=${config.maxInflight} interval=${config.minIntervalMs}ms source=${config.source}`);
      break;
    }
    case 'replay': msg.action === 'stop' ? stopReplaySource() : startReplaySource(Boolean(msg.loop), Number(msg.fps ?? 6)); break;
    default: log('warn', `unknown cmd ${String(msg.cmd)}`);
  }
  broadcastState();
}

// ----------------------------------------------------------------------------- http
const MIME: Record<string, string> = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.mp4': 'video/mp4', '.json': 'application/json', '.woff2': 'font/woff2' };
function latestBench(): unknown {
  // Merge every bench json (chronological), keeping the newest row per model.
  const dir = resolve(ROOT, 'bench-results');
  if (!existsSync(dir)) return null;
  const files = readdirSync(dir).filter((f) => f.endsWith('.json')).sort();
  const byModel = new Map<string, unknown>();
  for (const f of files) {
    try {
      const j = JSON.parse(readFileSync(resolve(dir, f), 'utf8'));
      for (const row of j.summary ?? []) if (row.p50_ms) byModel.set(row.model, row);
    } catch { /* skip */ }
  }
  return byModel.size ? { summary: [...byModel.values()] } : null;
}
const server = http.createServer((req, res) => {
  const url = new URL(req.url ?? '/', 'http://x');
  const send = (code: number, body: string | Buffer, type = 'application/json') => { res.writeHead(code, { 'content-type': type, 'cache-control': 'no-store' }); res.end(body); };
  if (url.pathname === '/api/state') return send(200, stateMessage());
  if (url.pathname === '/api/models') return send(200, JSON.stringify({ candidates: CANDIDATE_MODELS, bench: latestBench(), default_prompt: DEFAULT_PROMPT }));
  if (url.pathname === '/api/log') return send(200, JSON.stringify(logLines));
  if (url.pathname === '/health') return send(200, '{"ok":true}');
  if (url.pathname === '/api/cmd' && req.method === 'POST') {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => { try { applyCommand(JSON.parse(body || '{}'), 'http'); send(200, '{"ok":true}'); } catch (e) { send(400, JSON.stringify({ error: String((e as Error).message) })); } });
    return;
  }
  let p = url.pathname === '/' ? '/index.html' : url.pathname;
  if (p.startsWith('/assets/')) p = resolve(ROOT, '.' + p); else p = resolve(WEB, '.' + p);
  if (!p.startsWith(WEB) && !p.startsWith(resolve(ROOT, 'assets'))) return send(403, 'forbidden', 'text/plain');
  if (!existsSync(p)) return send(404, 'not found', 'text/plain');
  send(200, readFileSync(p), MIME[extname(p)] ?? 'application/octet-stream');
});

// ----------------------------------------------------------------------------- websockets
const wss = new WebSocketServer({ server });
wss.on('connection', (ws, req) => {
  const url = new URL(req.url ?? '/', 'http://x');
  const role = url.pathname.replace(/^\/ws\/?/, '') || 'desktop';
  const remote = req.socket.remoteAddress ?? '?';
  if (role === 'desktop') {
    desktops.add(ws);
    ws.send(stateMessage());
    ws.on('message', (data, isBinary) => {
      if (isBinary) return;
      try { const msg = JSON.parse(data.toString()); if (msg.t === 'cmd') applyCommand(msg, 'desktop'); else if (msg.t === 'ping') ws.send(JSON.stringify({ t: 'pong', ts: msg.ts, server_now: Date.now() })); } catch { /* ignore */ }
    });
    ws.on('close', () => desktops.delete(ws));
    return;
  }
  if (role === 'glasses' || role === 'webcam') {
    const id = role === 'glasses' ? `glasses-${remote.replace(/^.*:/, '')}` : `webcam-${Math.random().toString(36).slice(2, 6)}`;
    const src: Source = { id, kind: role, ws, lastFrameAt: 0, frames: [], seq: 0 };
    sources.set(id, src);
    if (role === 'glasses') glassesClients.add(ws); else desktops.add(ws);
    log('info', `${role} connected from ${remote}`);
    ws.send(stateMessage());
    ws.on('message', (data, isBinary) => {
      if (isBinary) { const f = decodeFrame(data as Buffer); if (f) onFrame(src, f); return; }
      try {
        const msg = JSON.parse(data.toString());
        if (msg.t === 'hello') { src.info = msg.device ?? msg; log('info', `${id} hello ${JSON.stringify(src.info).slice(0, 160)}`); }
        else if (msg.t === 'gesture') { session.gesture(String(msg.name)); log('info', `gesture ${msg.name} from ${id}`); }
        else if (msg.t === 'cmd') applyCommand(msg, id);
        else if (msg.t === 'ping') ws.send(JSON.stringify({ t: 'pong', ts: msg.ts, server_now: Date.now() }));
      } catch { /* ignore */ }
    });
    ws.on('close', () => { sources.delete(id); glassesClients.delete(ws); desktops.delete(ws); log('info', `${id} disconnected`); broadcastState(); });
    broadcastState();
    return;
  }
  ws.close(1008, 'unknown role');
});

server.listen(PORT, () => {
  const hosts = lanAddresses();
  console.log(`PlatePress server  http://localhost:${PORT}   (LAN: ${hosts.map((h) => `http://${h}:${PORT}`).join(', ') || 'none'})`);
  console.log(`models: ${config.models.join(' + ')}   glasses ws: ws://<host>:${PORT}/ws/glasses`);
  startBeacon(PORT);
});
process.on('SIGINT', () => { stopReplaySource(); process.exit(0); });
