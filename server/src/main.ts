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
import { Agent, transcribePcm16, type ChatMessage } from './agent.ts';

loadEnv();
const ROOT = resolve(import.meta.dirname, '..', '..');
const WEB = resolve(ROOT, 'server', 'web');
const PORT = Number(process.env.PORT ?? 8787);
const CONFIG_FILE = resolve(ROOT, 'config.local.json');
const REFS_DIR = resolve(ROOT, 'server', 'refs');

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
function loadRefs(): { label: string; jpeg: Buffer }[] {
  const out: { label: string; jpeg: Buffer }[] = [];
  for (const [file, label] of [['open.jpg', 'the plate press OPEN (lid raised, inside visible)'], ['closed.jpg', 'the plate press CLOSED (lid down, flat block)']] as const) {
    const f = resolve(REFS_DIR, file);
    if (existsSync(f)) out.push({ label, jpeg: readFileSync(f) });
  }
  return out;
}
const session = new PressSession(config.params);
const detector = new Detector({ models: config.models, maxInflight: config.maxInflight, minIntervalMs: config.minIntervalMs, prompt: config.prompt, timeoutMs: config.timeoutMs, refs: loadRefs() });

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
  if (session.phase !== 'IDLE') detector.offer(frame); // standby: frames flow to the dashboards, no model calls
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
setInterval(() => { if (session.phase !== 'IDLE' && !activeSourceId()) session.idle('camera lost'); session.tick(); }, 100);
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
    camera: { live: Boolean(activeSourceId()), source: activeSourceId() },
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

// ----------------------------------------------------------------------------- chat agent
function startWorkflow(): string {
  if (!activeSourceId()) { session.start(); return 'workflow started, but no camera is live yet (start the glasses app or a camera in the console)'; }
  session.start();
  return 'workflow started: looking for the press';
}
const agent = new Agent(process.env.CHAT_MODEL ?? 'gpt-5.4-mini', () => {
  const src = activeSourceId();
  const srcObj = src ? sources.get(src) : undefined;
  return {
    state: session.snapshot(),
    camera: { live: Boolean(src), source: src, fps: srcObj ? sourceFps(srcObj) : 0 },
    config: { models: config.models, countdown_ms: config.params.countdown_ms, confirmations: config.params.confirmations },
    stats: { p50_ms: detector.stats().p50_ms, decisions_per_s: detector.stats().decisions_per_s },
    frame: latestFrame && Date.now() - latestFrame.recv_ts < 5000 ? latestFrame.jpeg : null,
  };
}, {
  start_workflow: startWorkflow,
  stop_workflow: () => { session.idle('stopped by chat'); return 'workflow stopped, standing by'; },
  set_press_time: (seconds) => { if (!(seconds > 0 && seconds <= 3600)) return 'invalid seconds'; applyCommand({ cmd: 'set', config: { params: { countdown_ms: Math.round(seconds * 1000) } } }, 'chat'); return `press time set to ${seconds} s`; },
  set_confirmations: (n) => { applyCommand({ cmd: 'set', config: { params: { confirmations: Math.max(1, Math.min(5, Math.round(n))) } } }, 'chat'); return `confirmations set to ${config.params.confirmations}`; },
  set_models: (models) => { const ok = models.filter((m) => typeof m === 'string' && m.trim()); if (!ok.length) return 'no models given'; applyCommand({ cmd: 'set', config: { models: ok } }, 'chat'); return `models set to ${config.models.join(' + ')}`; },
  set_reference: (kind) => { if (!latestFrame) return 'no live frame to capture'; applyCommand({ cmd: 'set_reference', kind }, 'chat'); return `saved the current frame as the "${kind}" reference`; },
});
let chatBusy = false;
async function handleChat(text: string, from: string): Promise<void> {
  const clean = text.trim();
  if (!clean) return;
  const user: ChatMessage = { id: `u${Date.now()}`, role: 'user', text: clean, at: Date.now(), from };
  broadcast(JSON.stringify({ t: 'chat', ...user }));
  if (chatBusy) { broadcast(JSON.stringify({ t: 'chat', id: `a${Date.now()}`, role: 'assistant', text: 'One moment, still answering the previous message.', at: Date.now() })); return; }
  chatBusy = true;
  broadcast(JSON.stringify({ t: 'chat.thinking', on: true }));
  try {
    const reply = await agent.chat(clean, from, (e) => log('info', `agent tool ${e.name}: ${e.result}`));
    broadcast(JSON.stringify({ t: 'chat', ...reply }));
    log('info', `chat (${from}): "${clean.slice(0, 80)}" → "${reply.text.slice(0, 100)}"`);
  } catch (e) {
    const msg = (e as Error).message;
    log('error', `chat failed: ${msg}`);
    broadcast(JSON.stringify({ t: 'chat', id: `a${Date.now()}`, role: 'assistant', text: `Sorry, the assistant failed: ${msg.slice(0, 120)}`, at: Date.now() }));
  } finally {
    chatBusy = false;
    broadcast(JSON.stringify({ t: 'chat.thinking', on: false }));
    broadcastState();
  }
}
async function handleAudio(pcm: Buffer, from: string, sampleRate = 16000): Promise<void> {
  broadcast(JSON.stringify({ t: 'chat.thinking', on: true, stt: true }));
  try {
    const text = await transcribePcm16(pcm, sampleRate);
    log('info', `heard (${from}): "${text}"`);
    if (text) await handleChat(text, from);
    else broadcast(JSON.stringify({ t: 'chat', id: `a${Date.now()}`, role: 'assistant', text: "I didn't catch that.", at: Date.now() }));
  } catch (e) {
    log('error', `speech to text failed: ${(e as Error).message}`);
  } finally {
    broadcast(JSON.stringify({ t: 'chat.thinking', on: false }));
  }
}

// ----------------------------------------------------------------------------- commands
function applyCommand(msg: Record<string, unknown>, from: string): void {
  switch (msg.cmd) {
    case 'restart': case 'start': session.gesture('restart'); log('info', `start/restart (${from})`); break;
    case 'stop': session.gesture('stop'); log('info', `stop (${from})`); break;
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
    case 'set_reference': {
      const kind = msg.kind === 'open' ? 'open' : msg.kind === 'closed' ? 'closed' : null;
      if (!kind || !latestFrame) { log('warn', 'set_reference: need kind open|closed and a live frame'); break; }
      writeFileSync(resolve(REFS_DIR, `${kind}.jpg`), latestFrame.jpeg);
      detector.config.refs = loadRefs();
      log('info', `reference "${kind}" captured from the live frame (${from})`);
      break;
    }
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
  if (url.pathname.startsWith('/refs/')) {
    const f = resolve(REFS_DIR, url.pathname.slice(6).replace(/[^a-z.]/g, ''));
    return existsSync(f) ? send(200, readFileSync(f), 'image/jpeg') : send(404, 'no reference yet', 'text/plain');
  }
  if (url.pathname === '/health') return send(200, '{"ok":true}');
  if (url.pathname === '/api/chat' && req.method === 'GET') return send(200, JSON.stringify(agent.history));
  if (url.pathname === '/api/chat' && req.method === 'POST') {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => { try { void handleChat(String(JSON.parse(body || '{}').text ?? ''), 'http'); send(200, '{"ok":true}'); } catch (e) { send(400, JSON.stringify({ error: String((e as Error).message) })); } });
    return;
  }
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
      try {
        const msg = JSON.parse(data.toString());
        if (msg.t === 'cmd') applyCommand(msg, 'desktop');
        else if (msg.t === 'chat') void handleChat(String(msg.text ?? ''), 'console');
        else if (msg.t === 'ping') ws.send(JSON.stringify({ t: 'pong', ts: msg.ts, server_now: Date.now() }));
      } catch { /* ignore */ }
    });
    ws.on('close', () => desktops.delete(ws));
    ws.send(JSON.stringify({ t: 'chat.history', messages: agent.history }));
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
      if (isBinary) {
        const buf = data as Buffer;
        // Audio envelope: [u16 len]["{...\"t\":\"audio\"...}"][pcm16]; frames use the same envelope with a JPEG body.
        if (buf.length > 4 && !(buf[0] === 0xff && buf[1] === 0xd8)) {
          const n = buf.readUInt16BE(0);
          try {
            const h = JSON.parse(buf.subarray(2, 2 + n).toString('utf8'));
            if (h.t === 'audio') { void handleAudio(buf.subarray(2 + n), id, Number(h.rate ?? 16000)); return; }
          } catch { /* not an audio envelope */ }
        }
        const f = decodeFrame(buf);
        if (f) onFrame(src, f);
        return;
      }
      try {
        const msg = JSON.parse(data.toString());
        if (msg.t === 'hello') { src.info = msg.device ?? msg; log('info', `${id} hello ${JSON.stringify(src.info).slice(0, 160)}`); }
        else if (msg.t === 'gesture') { session.gesture(String(msg.name)); log('info', `gesture ${msg.name} from ${id}`); }
        else if (msg.t === 'chat') void handleChat(String(msg.text ?? ''), id);
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
