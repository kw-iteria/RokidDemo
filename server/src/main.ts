// PlatePress guide server: takes camera frames from the Rokid glasses (or a browser webcam,
// or a replayed clip), runs the vision model, drives the workflow state machine, and pushes
// the same state to the glasses HUD and the desktop dashboard.
import http from 'node:http';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { extname, resolve } from 'node:path';
import { WebSocketServer, WebSocket } from 'ws';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
import { loadEnv } from './env.ts';
import { keepWarm, prewarm } from './net.ts';
import { decodeFrame, encodeFrame, type Frame } from './frames.ts';
import { PressSession, DEFAULT_PARAMS, type SessionParams } from './session.ts';
import { Detector } from './detector.ts';
import { startReplay } from './replay.ts';
import { keepUsbForward } from './usb.ts';
import { RunRecorder } from './runlog.ts';
import { startBeacon, lanAddresses } from './beacon.ts';
import { CANDIDATE_MODELS, DEFAULT_PROMPT } from './vision.ts';
import { Agent, newConversationIntent, transcribePcm16, type ChatMessage } from './agent.ts';
import { ConversationStore, conversationsDir } from './conversations.ts';
import { motionScore } from './motion.ts';
import { defaultVoice, ELEVEN_PREFIX, Speaker, type VoiceConfig } from './tts.ts';
import { localAvailable, loadExtractor } from './local.ts';

loadEnv();
const ROOT = resolve(import.meta.dirname, '..', '..');
const WEB = resolve(ROOT, 'server', 'web');
const PORT = Number(process.env.PORT ?? 8787);
const BOOT = Date.now(); // in every state message: the console reloads itself when the server was restarted
const CONFIG_FILE = resolve(ROOT, 'config.local.json');
const REFS_DIR = resolve(ROOT, 'server', 'refs');

interface CameraConfig { rotation: 0 | 90 | 180 | 270; mirror: boolean; longEdge: number; fps: number; aspect: 'native' | 'landscape' | 'square' }
interface AppConfig {
  models: string[];
  mode: 'race' | 'primary' | 'local';
  camera: CameraConfig;
  chatFast: string;    // text-only conversation + tool calls
  chatVision: string;  // questions about the camera view
  voice: VoiceConfig;  // neural voice for replies (server-side TTS streamed to glasses + console)
  maxInflight: number;
  minIntervalMs: number;
  timeoutMs: number;
  prompt: string;
  source: string; // 'auto' | source id
  params: SessionParams;
  pairing?: { ssid: string; password: string }; // Wi-Fi handed to new glasses by the on-screen code (this Mac only)
}
const config: AppConfig = {
  models: (process.env.PRESS_MODELS ?? 'gpt-5.4-mini,gpt-4.1-mini').split(',').map((s) => s.trim()).filter(Boolean),
  mode: (process.env.PRESS_MODE as 'race' | 'primary' | 'local') ?? (localAvailable() ? 'local' : 'primary'),
  camera: { rotation: 0, mirror: false, longEdge: 720, fps: 6, aspect: 'native' },
  chatFast: process.env.CHAT_FAST_MODEL ?? 'groq/qwen/qwen3.8-27b',
  chatVision: process.env.CHAT_VISION_MODEL ?? 'gpt-5.4-mini',
  voice: defaultVoice(),
  maxInflight: 6,
  minIntervalMs: 100,
  timeoutMs: 8000,
  prompt: DEFAULT_PROMPT,
  source: 'auto',
  params: { ...DEFAULT_PARAMS },
};
if (existsSync(CONFIG_FILE)) {
  try { Object.assign(config, JSON.parse(readFileSync(CONFIG_FILE, 'utf8'))); } catch (e) { console.warn('config.local.json ignored:', (e as Error).message); }
  config.params = { ...DEFAULT_PARAMS, ...config.params }; // settings added later get their defaults
}
function persist(): void {
  const { models, mode, maxInflight, minIntervalMs, timeoutMs, prompt, params, camera, chatFast, chatVision, voice, pairing } = config;
  writeFileSync(CONFIG_FILE, JSON.stringify({ models, mode, maxInflight, minIntervalMs, timeoutMs, prompt, params, camera, chatFast, chatVision, voice, pairing }, null, 2));
}

// ----------------------------------------------------------------------------- core
function loadRefs(): { label: string; jpeg: Buffer }[] {
  // server/refs/open*.jpg and closed*.jpg; set_reference overwrites open.jpg / closed.jpg.
  if (!existsSync(REFS_DIR)) return [];
  return readdirSync(REFS_DIR).filter((f) => /^(open|closed|partial)\d*\.jpg$/.test(f)).sort().map((f) => ({
    label: f.startsWith('open') ? 'the plate press OPEN (lid raised, inside visible)' : f.startsWith('closed') ? 'the plate press CLOSED (lid down, one flat block, nothing touching it)' : 'the plate press NOT CLOSED YET (lid tilted / still moving / hand on it) — this counts as "partial"',
    jpeg: readFileSync(resolve(REFS_DIR, f)),
  }));
}
const session = new PressSession(config.params);
const detector = new Detector({ models: config.models, mode: config.mode, maxInflight: config.maxInflight, minIntervalMs: config.minIntervalMs, prompt: config.prompt, timeoutMs: config.timeoutMs, refs: loadRefs() });

interface Source { id: string; kind: 'glasses' | 'webcam' | 'replay'; ws?: WebSocket; lastFrameAt: number; frames: number[]; seq: number; info?: unknown }
const sources = new Map<string, Source>();
const desktops = new Set<WebSocket>();
const glassesClients = new Set<WebSocket>();
let latestFrame: Frame | null = null;
const recentFrames: Frame[] = []; // last few glasses frames, for inspection via /api/frame.jpg?n=
const recentVerdicts: Record<string, unknown>[] = []; // last judged frames + verdicts: /api/verdicts, /api/judged.jpg?n=
const judgedFrames: Buffer[] = [];
// Confident cloud verdicts on real glasses frames become training data for the local classifier (data/live).
const LIVE_DIR = process.env.LIVE_LABELS_DIR ?? resolve(ROOT, 'data', 'live'); // override for test instances
let lastLiveSave = 0;
// Every run's verdicts, phase changes and lags go to data/runs (RUNS_DIR override for test instances).
const runlog = new RunRecorder(process.env.RUNS_DIR ?? resolve(ROOT, 'data', 'runs'), () => ({ params: config.params, camera: config.camera, models: config.models, mode: config.mode, maxInflight: config.maxInflight }));
let lastCloudLid: { lid: string; at: number } | null = null;
function collectLiveLabel(v: { verdict: { press_visible: boolean; lid: string; confidence: number; bbox?: number[] }; frame: Frame; model: string }): void {
  const src = v.frame.header.src ?? '';
  if (!src.startsWith('glasses')) return;
  if (v.verdict.confidence < 0.85) return;
  const lid = v.verdict.press_visible ? v.verdict.lid : 'none';
  if (lid !== 'open' && lid !== 'closed' && lid !== 'none') return;
  const now = Date.now();
  const prev = lastCloudLid; lastCloudLid = { lid, at: v.frame.recv_ts };
  if (!prev || v.frame.recv_ts - prev.at > 2000 || prev.lid !== lid) return; // only labels the cloud model repeats consistently
  if (now - lastLiveSave < 700) return; // at most ~1.4 frames per second
  lastLiveSave = now;
  // Asynchronous: synchronous disk writes here stalled the event loop on the verdict path.
  if (!liveDirReady) { try { mkdirSync(LIVE_DIR, { recursive: true }); liveDirReady = true; } catch (e) { log('warn', `live label dir: ${(e as Error).message}`); return; } }
  const base = resolve(LIVE_DIR, `${v.frame.recv_ts}_${lid}`);
  Promise.all([
    writeFile(`${base}.jpg`, v.frame.jpeg),
    writeFile(`${base}.json`, JSON.stringify({ lid, bbox: v.verdict.bbox ?? null, confidence: v.verdict.confidence, model: v.model, at: v.frame.recv_ts, source: src })),
  ]).catch((e) => log('warn', `live label save failed: ${(e as Error).message}`));
}
let liveDirReady = existsSync(LIVE_DIR);
let lastRelayAt = 0;
function cameraMessage(): string { return JSON.stringify({ t: 'camera', ...config.camera }); }
const logLines: { at: number; level: string; text: string }[] = [];

function log(level: 'info' | 'warn' | 'error', text: string): void {
  const line = { at: Date.now(), level, text };
  logLines.push(line);
  if (logLines.length > 200) logLines.shift();
  (level === 'error' ? console.error : level === 'warn' ? console.warn : console.log)(`[${new Date(line.at).toISOString().slice(11, 23)}] ${text}`);
  broadcastDesktops(JSON.stringify({ t: 'log', ...line })); // the glasses ignore log lines
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
  if (typeof frame.header.motion !== 'number') frame.header.motion = motionScore(source.id, frame.jpeg); // sources that don't measure it themselves
  source.lastFrameAt = frame.recv_ts;
  source.frames.push(frame.recv_ts);
  source.seq++;
  if (activeSourceId() !== source.id) return;
  frame.header.src = source.id;
  latestFrame = frame;
  if (source.kind === 'glasses' && (recentFrames.length === 0 || frame.recv_ts - recentFrames[recentFrames.length - 1].recv_ts > 400)) {
    recentFrames.push(frame);
    if (recentFrames.length > 24) recentFrames.shift();
  }
  if (session.phase !== 'IDLE') detector.offer(frame); // standby: frames flow to the dashboards, no model calls
  // Relay a live preview to the dashboards (throttled just below the camera rate so no frame is
  // skipped at up to 15 fps; drop when a client is congested).
  const now = Date.now();
  if (now - lastRelayAt >= Math.min(70, 800 / Math.max(1, config.camera.fps))) {
    lastRelayAt = now;
    const payload = encodeFrame({ ...frame.header, recv_ts: frame.recv_ts }, frame.jpeg);
    for (const ws of desktops) if (ws.readyState === WebSocket.OPEN && ws.bufferedAmount < 512_000) ws.send(payload);
  }
}

detector.onVerdict = (v) => {
  const motion = typeof v.frame.header.motion === 'number' ? v.frame.header.motion : 0;
  if (!v.model.startsWith('local')) collectLiveLabel(v);
  const phase = session.phase; // the phase this verdict was judged in
  session.onVerdict({ verdict: v.verdict, frame_ts: v.frame.recv_ts, latency_ms: v.latency_ms, model: v.model, seq: v.frame.header.seq, motion, box_area: v.seen_area });
  runlog.verdict({ at: v.frame.recv_ts, latency_ms: Math.round(v.latency_ms), model: v.model, phase, lid: v.verdict.lid, press_visible: v.verdict.press_visible, confidence: v.verdict.confidence, hand: Boolean(v.verdict.hand_on_press), motion: +motion.toFixed(3), box_area: +(v.seen_area ?? 0).toFixed(3), why: session.blocked });
  recentVerdicts.push({ at: v.frame.recv_ts, phase, ...v.verdict, motion: +motion.toFixed(3), box_area: +(v.box_area ?? 0).toFixed(3), seen_area: +(v.seen_area ?? 0).toFixed(3), zoomed: Boolean(v.zoomed), latency_ms: Math.round(v.latency_ms), model: v.model, seq: v.frame.header.seq, why: session.blocked });
  judgedFrames.push(v.frame.jpeg);
  if (recentVerdicts.length > 150) { recentVerdicts.shift(); judgedFrames.shift(); }
  broadcastDesktops(JSON.stringify({ t: 'verdict', ...v.verdict, motion: +motion.toFixed(3), box_area: +(v.box_area ?? 0).toFixed(3), zoomed: Boolean(v.zoomed), latency_ms: Math.round(v.latency_ms), model: v.model, seq: v.frame.header.seq, frame_ts: v.frame.recv_ts, server_now: Date.now(), why: session.blocked }));
};
detector.onError = (model, err) => log('warn', `model error (${model}): ${err.slice(0, 200)}`);
detector.onVerifier = (v) => {
  const motion = typeof v.frame.header.motion === 'number' ? v.frame.header.motion : 0;
  collectLiveLabel(v);
  recentVerdicts.push({ at: v.frame.recv_ts, phase: session.phase, ...v.verdict, motion: +motion.toFixed(3), box_area: +(v.box_area ?? 0).toFixed(3), seen_area: +(v.seen_area ?? 0).toFixed(3), zoomed: Boolean(v.zoomed), latency_ms: Math.round(v.latency_ms), model: `${v.model} (verifier)`, seq: v.frame.header.seq });
  judgedFrames.push(v.frame.jpeg);
  if (recentVerdicts.length > 150) { recentVerdicts.shift(); judgedFrames.shift(); }
  broadcastDesktops(JSON.stringify({ t: 'verifier', ...v.verdict, latency_ms: Math.round(v.latency_ms), model: v.model, frame_ts: v.frame.recv_ts, server_now: Date.now() }));
  // The verifier's opinion also counts: when the local classifier is unsure (small, blurry press) the
  // cloud verdicts carry the state machine at cloud speed; when both see it, they must agree.
  session.onVerdict({ verdict: v.verdict, frame_ts: v.frame.recv_ts, latency_ms: v.latency_ms, model: v.model, seq: v.frame.header.seq, motion, box_area: v.seen_area });
  runlog.verdict({ at: v.frame.recv_ts, latency_ms: Math.round(v.latency_ms), model: `${v.model} (verifier)`, phase: session.phase, lid: v.verdict.lid, press_visible: v.verdict.press_visible, confidence: v.verdict.confidence, hand: Boolean(v.verdict.hand_on_press), motion: +motion.toFixed(3), box_area: +(v.seen_area ?? 0).toFixed(3), why: session.blocked });
};
if (config.mode === 'local' && localAvailable()) { loadExtractor().then(() => log('info', 'local classifier ready (CLIP ViT-B/32)')).catch((e) => log('warn', `local classifier failed to load: ${(e as Error).message}`)); }
let lastHint = '';
let lastPhase: string = session.phase;
session.onChange((snap, changed) => {
  if (changed) {
    log('info', `phase → ${snap.phase}`); broadcastState();
    runlog.phase(snap.run, lastPhase, snap.phase, Date.now(), snap.phase_since, snap.events[snap.events.length - 1]?.text ?? '');
    lastPhase = snap.phase;
  }
  else if (snap.hint !== lastHint) broadcastState(); // "Look at the press" etc. reach the HUD at once, not on the 500 ms beat
  lastHint = snap.hint;
});
setInterval(() => { if (session.phase !== 'IDLE' && !activeSourceId()) session.idle('camera lost'); session.tick(); }, 100);
setInterval(() => broadcastState(), 500);
// While waiting for a close/open, log a compact summary of what the model has been saying.
setInterval(() => {
  if (session.phase !== 'AWAIT_CLOSE' && session.phase !== 'AWAIT_OPEN') return;
  const since = Date.now() - 5000;
  const recent = recentVerdicts.filter((r) => (r.at as number) >= since);
  if (!recent.length) return;
  const tally = (k: string) => recent.filter((r) => (r.press_visible ? r.lid : 'none') === k).length;
  const hands = recent.filter((r) => r.hand_on_press).length;
  const moving = recent.filter((r) => (r.motion as number) > config.params.motion_max).length;
  const st = session.snapshot().streak;
  log('info', `${session.phase}: last 5 s → open ${tally('open')}, closed ${tally('closed')}, partial ${tally('partial')}, not seen ${tally('none')}; hand on ${hands}, moving ${moving}; streak ${st.state}×${st.count} (${st.span_ms} ms, hand-free ${st.hand_free}, open seen ${st.open_seen})`);
}, 5000);
detector.start();

let hostsCache: { at: number; hosts: string[] } = { at: 0, hosts: [] };
function hosts(): string[] {
  const now = Date.now();
  if (now - hostsCache.at > 10_000) hostsCache = { at: now, hosts: lanAddresses() };
  return hostsCache.hosts;
}
/**
 * "Look at the screen" pairing: the console shows this as a large code; the glasses app reads it
 * with its camera, joins the Wi-Fi (when given) and connects straight to this computer, so no phone
 * app and no working discovery broadcast are needed. Kept short so the code stays coarse (version 4).
 */
function pairingPayload(): string {
  const q = new URLSearchParams({ h: hosts().slice(0, 2).join(','), p: String(PORT) });
  if (config.pairing?.ssid) { q.set('s', config.pairing.ssid); if (config.pairing.password) q.set('k', config.pairing.password); }
  return `iteria:?${q.toString()}`;
}
function stateMessage(): string {
  const now = Date.now();
  const active = activeSourceId();
  return JSON.stringify({
    t: 'state',
    server_now: now,
    boot: BOOT,
    session: session.snapshot(now),
    stats: detector.stats(),
    config: { models: config.models, mode: config.mode, maxInflight: config.maxInflight, minIntervalMs: config.minIntervalMs, timeoutMs: config.timeoutMs, source: config.source, params: config.params, camera: config.camera, chatFast: config.chatFast, chatVision: config.chatVision, voice: config.voice },
    sources: [...sources.values()].map((s) => ({ id: s.id, kind: s.kind, fps: sourceFps(s), alive: now - s.lastFrameAt < 2500, active: active === s.id, info: s.info ?? null })),
    camera: { live: Boolean(active), source: active },
    hosts: hosts(),
    pairing: { ssid: config.pairing?.ssid ?? '', has_password: Boolean(config.pairing?.password) }, // never the password itself
    port: PORT,
  });
}
function broadcast(msg: string | Buffer): void {
  for (const ws of desktops) if (ws.readyState === WebSocket.OPEN && (typeof msg === 'string' || ws.bufferedAmount < 2_000_000)) ws.send(msg);
  for (const ws of glassesClients) if (ws.readyState === WebSocket.OPEN && (typeof msg === 'string' || ws.bufferedAmount < 2_000_000)) ws.send(msg);
}
function broadcastDesktops(msg: string): void {
  for (const ws of desktops) if (ws.readyState === WebSocket.OPEN) ws.send(msg);
}
// `stt: 'staged'` tells the glasses this server understands the two-step utterance hand-over (handleAudio).
function voiceMessage(): string { return JSON.stringify({ t: 'voice', mode: config.voice.enabled ? 'server' : 'device', voice: config.voice.voice, stt: 'staged' }); }
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
const agent = new Agent({ fast: config.chatFast, vision: config.chatVision }, () => {
  const src = activeSourceId();
  const srcObj = src ? sources.get(src) : undefined;
  return {
    state: session.snapshot(),
    camera: { live: Boolean(src), source: src, fps: srcObj ? sourceFps(srcObj) : 0 },
    config: { models: config.models, countdown_ms: config.params.countdown_ms, confirmations: config.params.confirmations },
    stats: { p50_ms: detector.stats().p50_ms, decisions_per_s: detector.stats().decisions_per_s },
    frame: latestFrame && Date.now() - latestFrame.recv_ts < 5000 ? latestFrame.jpeg : null,
    refs: (detector.config.refs ?? []).filter((r, i, arr) => i === arr.findIndex((x) => x.label === r.label)).filter((r) => !/NOT CLOSED/.test(r.label)), // one open + one closed
  };
}, {
  start_workflow: startWorkflow,
  stop_workflow: () => { session.idle('stopped by chat'); return 'workflow stopped, standing by'; },
  set_press_time: (seconds) => { if (!(seconds > 0 && seconds <= 3600)) return 'invalid seconds'; applyCommand({ cmd: 'set', config: { params: { countdown_ms: Math.round(seconds * 1000) } } }, 'chat'); return `press time set to ${seconds} s`; },
  set_confirmations: (n) => { applyCommand({ cmd: 'set', config: { params: { confirmations: Math.max(1, Math.min(5, Math.round(n))) } } }, 'chat'); return `confirmations set to ${config.params.confirmations}`; },
  set_models: (models) => { const ok = models.filter((m) => typeof m === 'string' && m.trim()); if (!ok.length) return 'no models given'; applyCommand({ cmd: 'set', config: { models: ok } }, 'chat'); return `models set to ${config.models.join(' + ')}`; },
  set_reference: (kind) => { if (!latestFrame) return 'no live frame to capture'; applyCommand({ cmd: 'set_reference', kind }, 'chat'); return `saved the current frame as the "${kind}" reference`; },
});
// Saved conversations: the agent's history is the current conversation's message list.
const convos = new ConversationStore(conversationsDir(ROOT));
agent.history = convos.current.messages;
function conversationsMessage(): string { return JSON.stringify({ t: 'conversations', current: convos.current.id, items: convos.list() }); }
let chatInflight: AbortController | null = null;
let currentSpeaker: Speaker | null = null;
/** Stops any reply in progress and shows `messages` as the chat everywhere (console + glasses). */
function switchConversation(from: string): void {
  if (chatInflight) { chatInflight.abort(); chatInflight = null; }
  if (currentSpeaker) { currentSpeaker.cancel(); currentSpeaker = null; }
  agent.history = convos.current.messages;
  broadcast(JSON.stringify({ t: 'chat.reset', from }));
  broadcast(JSON.stringify({ t: 'chat.history', messages: convos.current.messages }));
  broadcast(JSON.stringify({ t: 'chat.thinking', on: false }));
  broadcastDesktops(conversationsMessage());
}
function openConversation(id: string, from: string): void {
  if (id === convos.current.id) return;
  if (!convos.open(id)) { log('warn', `open conversation: unknown id ${id}`); return; }
  switchConversation(from);
  log('info', `opened conversation "${convos.current.title}" (${from})`);
}
function deleteConversation(id: string, from: string): void {
  const wasCurrent = convos.remove(id);
  if (wasCurrent) switchConversation(from); else broadcastDesktops(conversationsMessage());
  log('info', `deleted a conversation (${from})`);
}
/** New conversation: the previous one stays saved in the sidebar; every chat view is cleared. */
function newConversation(from: string, spoken = false): void {
  if (convos.current.messages.length) convos.startNew();
  switchConversation(from);
  log('info', `new conversation (${from})`);
  // A short spoken confirmation for the wearer (the console sees the cleared chat).
  if (spoken && config.voice.enabled) {
    const s = new Speaker(`reset${Date.now()}`, config.voice, (buf) => broadcast(buf), (e) => log('warn', `tts: ${e}`));
    currentSpeaker = s;
    s.end('Okay, fresh start.');
  }
}

async function handleChat(text: string, from: string): Promise<void> {
  const clean = text.trim();
  if (!clean) return;
  if (newConversationIntent(clean)) { newConversation(from, from.startsWith('glasses')); return; }
  const user: ChatMessage = { id: `u${Date.now()}`, role: 'user', text: clean, at: Date.now(), from };
  broadcast(JSON.stringify({ t: 'chat', ...user }));
  if (chatInflight) { log('warn', 'chat: cancelling the previous reply, a new message arrived'); chatInflight.abort(); }
  const ac = new AbortController();
  chatInflight = ac;
  if (currentSpeaker) { currentSpeaker.cancel(); currentSpeaker = null; }
  broadcast(JSON.stringify({ t: 'chat.thinking', on: true }));
  const t0 = Date.now();
  const speaker = config.voice.enabled ? new Speaker(`s${Date.now()}`, config.voice, (buf) => broadcast(buf), (e) => log('warn', `tts: ${e}`)) : null;
  currentSpeaker = speaker;
  ac.signal.addEventListener('abort', () => speaker?.cancel(), { once: true });
  try {
    const reply = await agent.chat(
      clean, from,
      (id, delta) => { broadcast(JSON.stringify({ t: 'chat.delta', id, delta })); speaker?.push(delta); },
      (e) => { if (e.type === 'tool') log('info', `agent tool ${e.name}: ${e.result}`); else log('info', `chat model ${e.model}${e.vision ? ' (with camera frame)' : ''}`); },
      ac.signal,
    );
    if (ac.signal.aborted) return;
    speaker?.end(reply.text);
    broadcast(JSON.stringify({ t: 'chat', ...reply }));
    log('info', `chat (${from}, ${reply.model}, ${Date.now() - t0} ms): "${clean.slice(0, 80)}" → "${reply.text.slice(0, 100)}"`);
  } catch (e) {
    if (ac.signal.aborted) return;
    const msg = (e as Error).message;
    log('error', `chat failed after ${Date.now() - t0} ms: ${msg}`);
    broadcast(JSON.stringify({ t: 'chat', id: `a${Date.now()}`, role: 'assistant', text: `Sorry, the assistant failed: ${msg.slice(0, 120)}`, at: Date.now() }));
  } finally {
    if (chatInflight === ac) { chatInflight = null; broadcast(JSON.stringify({ t: 'chat.thinking', on: false })); }
    convos.save();
    broadcastDesktops(conversationsMessage());
    broadcastState();
  }
}
/**
 * Speech to text with a head start. The glasses send an utterance twice: once after a short pause
 * ("partial": everything captured so far), then when their end-of-speech rule fires ("final": only
 * the audio recorded since the partial, with `extends` when that was nothing but silence). The
 * transcription starts on the partial, so it is usually done by the time the final arrives and the
 * reply begins ~0.3 s sooner (Groq takes 0.25-0.3 s). If the wearer went on talking after the
 * partial, the final is re-transcribed as a whole. A message without `stage` is transcribed as is.
 */
interface AudioHeader { rate?: number; stage?: string; utt?: number; part?: number; extends?: boolean }
const sttPending = new Map<string, { part: number; pcm: Buffer; text: Promise<string>; at: number }>();
async function handleAudio(pcm: Buffer, from: string, h: AudioHeader): Promise<void> {
  const rate = Number(h.rate ?? 16000);
  const key = `${from}/${h.utt ?? 0}`;
  const now = Date.now();
  for (const [k, p] of sttPending) if (now - p.at > 15_000) sttPending.delete(k); // utterances that never got a final (speaker started, link dropped)
  if (h.stage === 'partial') {
    const text = transcribePcm16(pcm, rate);
    text.catch(() => { /* reported below, when the final arrives */ });
    sttPending.set(key, { part: Number(h.part ?? 0), pcm, text, at: now });
    return;
  }
  const p = sttPending.get(key);
  sttPending.delete(key);
  const ahead = Boolean(p && p.part === Number(h.part ?? 0));
  broadcast(JSON.stringify({ t: 'chat.thinking', on: true, stt: true }));
  try {
    let text: string;
    if (ahead && h.extends) {
      try { text = await p!.text; } catch { text = await transcribePcm16(Buffer.concat([p!.pcm, pcm]), rate); }
    } else text = await transcribePcm16(ahead ? Buffer.concat([p!.pcm, pcm]) : pcm, rate);
    log('info', `heard (${from}, ${Date.now() - now} ms${ahead && h.extends ? ' after the head start' : ''}): "${text}"`);
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
      if (c.mode === 'race' || c.mode === 'primary' || c.mode === 'local') config.mode = c.mode;
      if (typeof c.chatFast === 'string' && c.chatFast.trim()) { config.chatFast = c.chatFast.trim(); agent.models.fast = config.chatFast; }
      if (typeof c.chatVision === 'string' && c.chatVision.trim()) { config.chatVision = c.chatVision.trim(); agent.models.vision = config.chatVision; }
      if (c.voice && typeof c.voice === 'object') {
        const v = c.voice as Partial<VoiceConfig>;
        if (typeof v.enabled === 'boolean') config.voice.enabled = v.enabled;
        if (typeof v.voice === 'string' && v.voice.trim() && v.voice.trim() !== config.voice.voice) { config.voice.voice = v.voice.trim(); warmVoice(); }
        if (typeof v.speed === 'number') config.voice.speed = Math.max(0.5, Math.min(2, v.speed));
        if (typeof v.instructions === 'string') config.voice.instructions = v.instructions;
        for (const ws of glassesClients) if (ws.readyState === WebSocket.OPEN) ws.send(voiceMessage());
      }
      if (typeof c.maxInflight === 'number') config.maxInflight = Math.max(1, Math.min(6, c.maxInflight));
      if (typeof c.minIntervalMs === 'number') config.minIntervalMs = Math.max(50, c.minIntervalMs);
      if (typeof c.timeoutMs === 'number') config.timeoutMs = Math.max(1000, c.timeoutMs);
      if (typeof c.prompt === 'string' && c.prompt.trim()) config.prompt = c.prompt;
      if (typeof c.source === 'string') config.source = c.source;
      if (c.params && typeof c.params === 'object') { config.params = { ...config.params, ...c.params }; session.setParams(config.params); }
      Object.assign(detector.config, { models: config.models, mode: config.mode, maxInflight: config.maxInflight, minIntervalMs: config.minIntervalMs, prompt: config.prompt, timeoutMs: config.timeoutMs });
      persist();
      log('info', `config updated (${from}): models=${config.models.join('+')} inflight=${config.maxInflight} interval=${config.minIntervalMs}ms source=${config.source}`);
      break;
    }
    case 'replay': msg.action === 'stop' ? stopReplaySource() : startReplaySource(Boolean(msg.loop), Number(msg.fps ?? 6)); break;
    case 'set_camera': {
      const c = (msg.camera ?? {}) as Partial<CameraConfig>;
      if ([0, 90, 180, 270].includes(Number(c.rotation))) config.camera.rotation = Number(c.rotation) as CameraConfig['rotation'];
      if (typeof c.mirror === 'boolean') config.camera.mirror = c.mirror;
      if (typeof c.longEdge === 'number') config.camera.longEdge = Math.max(240, Math.min(1280, Math.round(c.longEdge)));
      if (typeof c.fps === 'number') config.camera.fps = Math.max(1, Math.min(15, c.fps));
      if (c.aspect === 'native' || c.aspect === 'landscape' || c.aspect === 'square') config.camera.aspect = c.aspect;
      persist();
      for (const ws of glassesClients) if (ws.readyState === WebSocket.OPEN) ws.send(cameraMessage());
      log('info', `camera settings → rotation ${config.camera.rotation}°${config.camera.mirror ? ', mirrored' : ''}, ${config.camera.aspect}, ${config.camera.longEdge}px, ${config.camera.fps} fps (${from})`);
      break;
    }
    case 'set_pairing': {
      const ssid = typeof msg.ssid === 'string' ? msg.ssid.trim().slice(0, 64) : '';
      const password = typeof msg.password === 'string' ? msg.password.slice(0, 64) : '';
      config.pairing = ssid ? { ssid, password } : undefined;
      persist();
      log('info', ssid ? `pairing Wi-Fi set to "${ssid}" (${from})` : `pairing Wi-Fi cleared (${from})`);
      break;
    }
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
  if (url.pathname === '/api/pair.svg') {
    const QR = require('qrcode');
    QR.toString(pairingPayload(), { type: 'svg', errorCorrectionLevel: 'L', margin: 2, color: { dark: '#000000', light: '#ffffff' } })
      .then((svg: string) => send(200, svg, 'image/svg+xml'))
      .catch((e: Error) => send(500, e.message, 'text/plain'));
    return;
  }
  if (url.pathname === '/api/models') return send(200, JSON.stringify({ candidates: CANDIDATE_MODELS, bench: latestBench(), default_prompt: DEFAULT_PROMPT }));
  if (url.pathname === '/api/log') return send(200, JSON.stringify(logLines));
  if (url.pathname === '/api/runs') return send(200, JSON.stringify(runlog.list())); // recorded runs, newest first
  if (url.pathname === '/api/verdicts') return send(200, JSON.stringify(recentVerdicts));
  if (url.pathname === '/api/retrain' && req.method === 'POST') {
    // Retrain the local classifier in the background with everything in data/live; the head hot-reloads.
    const { spawn } = require('node:child_process');
    const liveCount = existsSync(LIVE_DIR) ? readdirSync(LIVE_DIR).filter((f) => f.endsWith('.json')).length : 0;
    log('info', `retraining the local classifier (${liveCount} live frames)…`);
    const child = spawn(process.execPath, ['--no-warnings', resolve(ROOT, 'tools', 'train_local.ts')], { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    child.stdout.on('data', (d: Buffer) => { out += d.toString(); });
    child.stderr.on('data', (d: Buffer) => { out += d.toString(); });
    child.on('close', (code: number) => {
      const acc = out.match(/leave-one-clip-out accuracy: ([\d.]+%)/)?.[1];
      const live = out.match(/held-out live: (\d+\/\d+)/)?.[1];
      log(code === 0 ? 'info' : 'error', code === 0 ? `local classifier retrained: ${acc ?? '?'} cross-validated${live ? `, real frames held out ${live}` : ''}` : `retrain failed: ${out.slice(-300)}`);
    });
    return send(200, JSON.stringify({ ok: true, live_frames: liveCount }));
  }
  if (url.pathname === '/api/judged.jpg') {
    const n = Number(url.searchParams.get('n') ?? 0);
    const f = judgedFrames[judgedFrames.length - 1 - n];
    return f ? send(200, f, 'image/jpeg') : send(404, 'no judged frame', 'text/plain');
  }
  if (url.pathname === '/api/frame.jpg') {
    const n = Number(url.searchParams.get('n') ?? 0);
    const f = recentFrames[recentFrames.length - 1 - n] ?? latestFrame;
    return f ? send(200, f.jpeg, 'image/jpeg') : send(404, 'no frame yet', 'text/plain');
  }
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
// Liveness: a peer that vanishes without closing (Wi-Fi stall, cable pulled) otherwise stays in the
// client sets for as long as its TCP socket lingers; a zombie glasses socket kept a stale source and
// blocked the USB keeper. Three missed pings (9 s) and the socket is dropped, which runs its 'close'.
interface LiveSocket extends WebSocket { missed?: number }
setInterval(() => {
  for (const c of wss.clients as Set<LiveSocket>) {
    if ((c.missed ?? 0) >= 3) { c.terminate(); continue; }
    c.missed = (c.missed ?? 0) + 1;
    c.ping();
  }
}, 3000).unref();
wss.on('connection', (ws, req) => {
  (ws as LiveSocket).missed = 0;
  ws.on('pong', () => { (ws as LiveSocket).missed = 0; });
  ws.on('message', () => { (ws as LiveSocket).missed = 0; }); // any traffic proves the peer is there
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
        else if (msg.t === 'new_chat') newConversation('console');
        else if (msg.t === 'open_chat') openConversation(String(msg.id ?? ''), 'console');
        else if (msg.t === 'delete_chat') deleteConversation(String(msg.id ?? ''), 'console');
        else if (msg.t === 'ping') ws.send(JSON.stringify({ t: 'pong', ts: msg.ts, server_now: Date.now() }));
      } catch { /* ignore */ }
    });
    ws.on('close', () => desktops.delete(ws));
    ws.send(JSON.stringify({ t: 'chat.history', messages: agent.history }));
    ws.send(conversationsMessage());
    ws.send(JSON.stringify({ t: 'log.history', lines: logLines.slice(-150) })); // Activity page starts with recent history
    return;
  }
  if (role === 'glasses' || role === 'webcam') {
    const id = role === 'glasses' ? `glasses-${remote.replace(/^.*:/, '')}` : `webcam-${Math.random().toString(36).slice(2, 6)}`;
    const src: Source = { id, kind: role, ws, lastFrameAt: 0, frames: [], seq: 0 };
    // The same glasses coming back (after a Wi-Fi stall the old socket never said goodbye): drop the
    // old socket now rather than waiting for the heartbeat to notice.
    const stale = sources.get(id)?.ws;
    if (stale && stale !== ws) stale.terminate();
    sources.set(id, src);
    if (role === 'glasses') { glassesClients.add(ws); prewarm(); } // webcam senders don't get the console stream (they never read it)
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
            if (h.t === 'audio') { void handleAudio(buf.subarray(2 + n), id, h); return; }
            const jpeg = buf.subarray(2 + n);
            if (typeof h.seq === 'number' && jpeg[0] === 0xff && jpeg[1] === 0xd8) { onFrame(src, { header: h, jpeg, recv_ts: Date.now() }); return; } // header parsed once
          } catch { /* not an audio envelope */ }
        }
        const f = decodeFrame(buf);
        if (f) onFrame(src, f);
        return;
      }
      try {
        const msg = JSON.parse(data.toString());
        if (msg.t === 'hello') {
          src.info = msg.device ?? msg; log('info', `${id} hello ${JSON.stringify(src.info).slice(0, 160)}`); ws.send(cameraMessage()); ws.send(voiceMessage());
          if (role === 'glasses' && config.voice.enabled) { // a short spoken greeting so the wearer knows the assistant is live and listening
            const greeter = new Speaker(`greet${Date.now()}`, config.voice, (buf) => { if (ws.readyState === WebSocket.OPEN) ws.send(buf); }, (e) => log('warn', `tts: ${e}`));
            greeter.end("Hi! I'm listening. Just talk to me.");
          }
        }
        else if (msg.t === 'interrupt') { if (chatInflight) chatInflight.abort(); if (currentSpeaker) { currentSpeaker.cancel(); currentSpeaker = null; } broadcast(JSON.stringify({ t: 'chat.thinking', on: false })); log('info', `${id}: interrupted`); }
        else if (msg.t === 'gesture') { session.gesture(String(msg.name)); log('info', `gesture ${msg.name} from ${id}`); }
        else if (msg.t === 'chat') void handleChat(String(msg.text ?? ''), id);
        else if (msg.t === 'new_chat') newConversation(id, role === 'glasses');
        else if (msg.t === 'status') {
          const prevCam = JSON.stringify((src.info as { camera?: unknown } | undefined)?.camera ?? null);
          const prevMic = JSON.stringify((src.info as { mic?: unknown } | undefined)?.mic ?? null);
          src.info = { ...((src.info as object) ?? {}), camera: msg.camera, voice: msg.voice, mic: msg.mic };
          // log camera changes that matter (status / permission / error), not the ever-increasing frame counter
          const camKey = (c: unknown) => { const x = (c ?? {}) as Record<string, unknown>; return JSON.stringify([x.status, x.permission, x.error]); };
          if (camKey(msg.camera) !== camKey(JSON.parse(prevCam))) log('info', `${id} camera: ${JSON.stringify(msg.camera)}`);
          const micKey = (m: unknown) => { const x = (m ?? {}) as Record<string, unknown>; return JSON.stringify([x.enabled, x.running, x.source]); };
          if (msg.mic && micKey(msg.mic) !== micKey(JSON.parse(prevMic))) log('info', `${id} mic: ${JSON.stringify(msg.mic)}`);
        }
        else if (msg.t === 'cmd') applyCommand(msg, id);
        else if (msg.t === 'ping') ws.send(JSON.stringify({ t: 'pong', ts: msg.ts, server_now: Date.now() }));
      } catch { /* ignore */ }
    });
    ws.on('close', () => { if (sources.get(id)?.ws === ws) sources.delete(id); glassesClients.delete(ws); desktops.delete(ws); log('info', `${id} disconnected`); broadcastState(); });
    broadcastState();
    return;
  }
  ws.close(1008, 'unknown role');
});

keepWarm(() => glassesClients.size > 0 || desktops.size > 0);
keepUsbForward(PORT, () => glassesClients.size === 0, (t) => log('info', t)); // the cable path heals itself after a re-plug
// ElevenLabs unloads idle library voices (measured: a cold voice takes 4-6 s to its first audio instead
// of ~0.2 s). While someone is connected, keep the selected voice loaded with a 2-character request
// every 3 minutes (~40 characters an hour of quota).
function warmVoice(): void {
  const v = config.voice.voice;
  if (!config.voice.enabled || !v.startsWith(ELEVEN_PREFIX) || !process.env.ELEVENLABS_API_KEY) return;
  fetch(`https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(v.slice(ELEVEN_PREFIX.length))}/stream?output_format=pcm_24000`, {
    method: 'POST', headers: { 'content-type': 'application/json', 'xi-api-key': process.env.ELEVENLABS_API_KEY },
    body: JSON.stringify({ text: 'Hi', model_id: 'eleven_flash_v2_5' }), signal: AbortSignal.timeout(15_000),
  }).then((r) => r.arrayBuffer()).catch(() => { /* best effort */ });
}
setInterval(() => { if (glassesClients.size > 0 || desktops.size > 0) warmVoice(); }, 3 * 60_000).unref();
server.listen(PORT, () => {
  const hosts = lanAddresses();
  console.log(`Iteria Agent  http://localhost:${PORT}   (LAN: ${hosts.map((h) => `http://${h}:${PORT}`).join(', ') || 'none'})`);
  console.log(`models: ${config.models.join(' + ')}   glasses ws: ws://<host>:${PORT}/ws/glasses`);
  if (!process.env.NO_BEACON) startBeacon(PORT); // NO_BEACON=1 for a test instance that the glasses must not discover
});
process.on('SIGINT', () => { stopReplaySource(); runlog.close(); process.exit(0); });
