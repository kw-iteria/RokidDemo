/* PlatePress console: mirrors the glasses HUD, shows the live camera and model verdicts, and
   lets you switch camera source / model / prompt. Plain JS, no build step. */
(() => {
  const $ = (id) => document.getElementById(id);
  const els = {
    conn: $('conn'), srcPill: $('src-pill'), modelPill: $('model-pill'), latPill: $('lat-pill'),
    live: $('live'), liveEmpty: $('live-empty'), badge: $('verdict-badge'),
    hud: $('hud'), arc: $('dial-arc'), number: $('hud-number'), message: $('hud-message'), sub: $('hud-sub'),
    footL: $('hud-foot-left'), footR: $('hud-foot-right'), timing: $('timing'),
    source: $('source'), model: $('model'), model2: $('model2'), mode: $('mode'), inflight: $('inflight'), interval: $('interval'),
    confirm: $('confirm'), dwell: $('dwell'), settle: $('settle'), handfree: $('handfree'), hosts: $('hosts'), log: $('log'),
    prompt: $('prompt'), promptBox: $('prompt-box'),
    camRot: $('cam-rot'), camMirror: $('cam-mirror'), camAspect: $('cam-aspect'), camEdge: $('cam-edge'), camFps: $('cam-fps'),
    chatFast: $('chat-fast'), chatVision: $('chat-vision'), voiceName: $('voice-name'), voiceSpeed: $('voice-speed'), voiceEnabled: $('voice-enabled'),
    chatLog: $('chat-log'), chatForm: $('chat-form'), chatInput: $('chat-input'), mic: $('btn-mic'), hudChat: $('hud-chat'),
  };
  const state = { snap: null, offset: 0, verdicts: [], lastFrameUrl: null, sound: true, voice: true, lastPhase: null, lastBeep: 0, defaultPrompt: '', bench: null, editing: false };

  // ------------------------------------------------------------------ websocket
  let ws = null;
  function connect() {
    ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws/desktop`);
    ws.binaryType = 'arraybuffer';
    ws.onopen = () => { els.conn.textContent = 'connected'; els.conn.className = 'pill ok'; };
    ws.onclose = () => { els.conn.textContent = 'reconnecting'; els.conn.className = 'pill warn'; setTimeout(connect, 1000); };
    ws.onmessage = (ev) => {
      if (ev.data instanceof ArrayBuffer) return onFrame(ev.data);
      const msg = JSON.parse(ev.data);
      if (msg.t === 'state') onState(msg);
      else if (msg.t === 'verdict') onVerdict(msg);
      else if (msg.t === 'verifier') { state.lastVerifier = msg; }
      else if (msg.t === 'log') addLog(msg);
      else if (msg.t === 'chat') addChat(msg, true);
      else if (msg.t === 'chat.delta') addDelta(msg);
      else if (msg.t === 'chat.history') { els.chatLog.querySelectorAll('li:not(.hint)').forEach((n) => n.remove()); for (const m of msg.messages) addChat(m, false); }
      else if (msg.t === 'chat.thinking') { if (msg.on) showThinking(msg.stt ? 'transcribing' : ''); else if (!document.querySelector('.chat-log li.streaming')) hideThinking(); }
    };
  }
  function send(obj) { if (ws && ws.readyState === 1) ws.send(JSON.stringify(obj)); }
  const cmd = (o) => send({ t: 'cmd', ...o });

  // ------------------------------------------------------------------ frames
  // ---- streamed neural voice (PCM16 mono from the server) ----
  const voice = { ctx: null, nextTime: 0, currentId: null };
  function playPcm(header, pcmBytes) {
    if (!state.voice) return;
    if (header.stop) { voice.currentId = null; voice.nextTime = 0; if (voice.ctx) { voice.ctx.close(); voice.ctx = null; } return; }
    if (!pcmBytes.byteLength) return;
    if (voice.currentId !== header.id) { voice.currentId = header.id; voice.nextTime = 0; }
    voice.ctx = voice.ctx || new (window.AudioContext || window.webkitAudioContext)({ sampleRate: 48000 });
    const int16 = new Int16Array(pcmBytes.buffer.slice(pcmBytes.byteOffset, pcmBytes.byteOffset + pcmBytes.byteLength - (pcmBytes.byteLength % 2)));
    const buffer = voice.ctx.createBuffer(1, int16.length, header.rate || 24000);
    const ch = buffer.getChannelData(0);
    for (let i = 0; i < int16.length; i++) ch[i] = int16[i] / 32768;
    const src = voice.ctx.createBufferSource(); src.buffer = buffer; src.connect(voice.ctx.destination);
    const at = Math.max(voice.ctx.currentTime + 0.02, voice.nextTime);
    src.start(at); voice.nextTime = at + buffer.duration;
  }
  function onFrame(buf) {
    const view = new DataView(buf);
    const n = view.getUint16(0);
    if (n < 400) {
      try { const h = JSON.parse(new TextDecoder().decode(new Uint8Array(buf, 2, n))); if (h.t === 'tts') return playPcm(h, new Uint8Array(buf, 2 + n)); } catch (e) { /* camera frame */ }
    }
    const jpeg = new Blob([buf.slice(2 + n)], { type: 'image/jpeg' });
    const url = URL.createObjectURL(jpeg);
    els.live.onload = () => { if (state.lastFrameUrl) URL.revokeObjectURL(state.lastFrameUrl); state.lastFrameUrl = url; };
    els.live.src = url;
    els.live.classList.add('on');
    els.liveEmpty.style.display = 'none';
    document.querySelector('.viewport').classList.add('has-frame');
  }

  // ------------------------------------------------------------------ state
  function onState(msg) {
    state.offset = msg.server_now - Date.now();
    state.snap = msg;
    const s = msg.session;
    const active = msg.sources.find((x) => x.active);
    const idleGlasses = msg.sources.find((x) => x.kind === 'glasses' && !x.alive && x.info && x.info.camera);
    els.srcPill.textContent = active ? `${active.kind} ${active.fps} fps` : idleGlasses ? `glasses connected, camera: ${idleGlasses.info.camera.status}${idleGlasses.info.camera.permission === false ? ' (permission missing)' : ''}` : 'no camera';
    els.srcPill.className = active ? 'pill ok' : idleGlasses ? 'pill warn' : 'pill';
    els.srcPill.title = idleGlasses && idleGlasses.info.camera.error ? idleGlasses.info.camera.error : '';
    document.querySelector('.viewport').classList.toggle('glasses-live', Boolean(active && active.kind === 'glasses'));
    els.modelPill.textContent = msg.config.mode === 'local' ? `local CLIP · verified by ${msg.config.models[0]}` : msg.config.models.join(msg.config.mode === 'race' ? ' ∥ ' : ' → ');
    els.latPill.textContent = msg.stats.p50_ms ? `${msg.stats.p50_ms} ms · ${msg.stats.decisions_per_s}/s` : '— ms';
    els.hosts.textContent = msg.hosts.length ? `glasses find this Mac at ${msg.hosts.map((h) => `${h}:${msg.port}`).join(' or ')}` : '';
    if (!state.editing) syncControls(msg);
    // camera source options
    const opts = [['auto', 'automatic'], ...msg.sources.map((x) => [x.id, `${x.kind}${x.alive ? '' : ' (idle)'}`])];
    if (els.source.options.length !== opts.length || [...els.source.options].some((o, i) => o.value !== opts[i][0])) {
      els.source.innerHTML = opts.map(([v, l]) => `<option value="${v}">${l}</option>`).join('');
    }
    els.source.value = msg.config.source;
    if (s.phase !== state.lastPhase) onPhaseChange(state.lastPhase, s.phase, s);
    state.lastPhase = s.phase;
    renderHud();
    renderTiming(msg);
  }
  function syncControls(msg) {
    els.model.value = msg.config.models[0] || '';
    els.model2.value = msg.config.models[1] || '';
    els.mode.value = msg.config.mode || 'primary';
    if (msg.config.chatFast) { els.chatFast.value = msg.config.chatFast; els.chatVision.value = msg.config.chatVision; }
    if (msg.config.voice) { els.voiceName.value = msg.config.voice.voice; els.voiceSpeed.value = msg.config.voice.speed; els.voiceEnabled.value = String(msg.config.voice.enabled); }
    if (msg.config.camera) { if (els.camRot) els.camRot.value = String(msg.config.camera.rotation); if (els.camMirror) els.camMirror.value = String(msg.config.camera.mirror); if (els.camAspect) els.camAspect.value = msg.config.camera.aspect || 'native'; els.camEdge.value = msg.config.camera.longEdge; els.camFps.value = msg.config.camera.fps; }
    els.inflight.value = msg.config.maxInflight;
    els.interval.value = msg.config.minIntervalMs;
    els.confirm.value = msg.config.params.confirmations;
    els.dwell.value = Math.round(msg.config.params.countdown_ms / 1000);
    els.settle.value = msg.config.params.settle_ms ?? 700;
    els.handfree.value = String(msg.config.params.hand_free_close ?? true);
    if (els.prompt && document.activeElement !== els.prompt) els.prompt.value = msg.config.prompt;
  }

  function onVerdict(v) {
    state.verdicts.push(v);
    if (state.verdicts.length > 400) state.verdicts.shift();
    // Subtitle over the live picture: the state word, with a small detail line.
    const word = v.press_visible ? v.lid : 'not seen';
    const detail = [v.hand_on_press ? 'hand on it' : '', v.motion > 0.25 ? 'moving' : '', `${v.confidence.toFixed(2)}`, `${v.latency_ms} ms`, v.model.replace(' (vetoed)', ' · vetoed')].filter(Boolean).join(' · ');
    els.badge.innerHTML = `<b class="${word === 'not seen' ? 'none' : word}">${word}</b><small>${detail}</small>`;
  }

  // ------------------------------------------------------------------ HUD mirror
  function serverNow() { return Date.now() + state.offset; }
  function renderHud() {
    const s = state.snap && state.snap.session;
    if (!s) return;
    els.hud.dataset.phase = s.phase;
    els.message.textContent = s.phase === 'IDLE' ? '' : s.message;
    els.sub.textContent = s.hint || s.sub;
    const lv = s.last_verdict;
    const showVerdict = lv && s.phase !== 'IDLE';
    els.footL.textContent = showVerdict ? (lv.press_visible ? `press ${lv.lid}` : 'press not seen') : '';
    els.footR.textContent = showVerdict ? `${(lv.latency_ms / 1000).toFixed(1)} s` : '';
    if (s.phase === 'COUNTDOWN' && s.countdown) {
      const remaining = Math.max(0, s.countdown.ends_at - serverNow());
      const frac = remaining / s.countdown.duration_ms;
      els.arc.style.strokeDashoffset = String(553 * (1 - frac));
      els.number.textContent = String(Math.ceil(remaining / 1000));
    } else {
      els.number.textContent = '';
    }
    const fresh = state.hudChat && Date.now() - state.hudChat.at < 12_000;
    els.hudChat.hidden = !fresh;
    if (fresh) els.hudChat.textContent = state.hudChat.text;
  }
  function loop() { renderHud(); requestAnimationFrame(loop); }
  requestAnimationFrame(loop);

  function renderTiming(msg) {
    const st = msg.stats;
    const s = msg.session;
    const closedEv = s.events.slice().reverse().find((e) => e.text.startsWith('closed detected'));
    els.timing.innerHTML = [
      ['Decision latency', st.p50_ms ? `${st.p50_ms} ms median · ${st.p90_ms} ms p90` : '—'],
      ['Decisions', `${st.decisions_per_s}/s · ${st.inflight} in flight`],
      ['Errors', String(st.errors)],
      ['Run', `${s.run} · ${s.phase.toLowerCase().replace('_', ' ')}`],
      ['Last close detection', closedEv ? closedEv.text.replace('closed detected ', '') : '—'],
      ['Verdicts by model', (st.local ? `local ${st.local.count} (${st.local.p50_ms} ms, ${st.local.vetoed} vetoed) · ` : '') + (Object.entries(st.per_model || {}).map(([m, v]) => `${m} ${v.wins} (${v.p50_ms} ms${v.errors ? `, ${v.errors} err` : ''})`).join(' · ') || '—')],
    ].map(([k, v]) => `<div><span>${k}</span>${v}</div>`).join('');
  }

  // ------------------------------------------------------------------ sound + voice
  let audio = null;
  function beep(freq, ms, gain = 0.08) {
    if (!state.sound) return;
    audio = audio || new (window.AudioContext || window.webkitAudioContext)();
    const o = audio.createOscillator(); const g = audio.createGain();
    o.type = 'sine'; o.frequency.value = freq; g.gain.value = gain;
    o.connect(g); g.connect(audio.destination);
    const t = audio.currentTime; o.start(t); g.gain.setValueAtTime(gain, t); g.gain.exponentialRampToValueAtTime(0.0001, t + ms / 1000); o.stop(t + ms / 1000);
  }
  function say(text) {
    // Spoken replies come from the server's neural voice (playPcm); the browser voice is only used for
    // workflow prompts when the neural voice is turned off in the settings.
    if (!state.voice || !('speechSynthesis' in window)) return;
    if (state.snap && state.snap.config.voice && state.snap.config.voice.enabled) return;
    speechSynthesis.cancel(); const u = new SpeechSynthesisUtterance(text); u.rate = 1.05; speechSynthesis.speak(u);
  }
  function onPhaseChange(from, to, s) {
    if (from === null) return;
    if (to === 'AWAIT_CLOSE') { beep(660, 120); say('Please close the plate press'); }
    if (to === 'COUNTDOWN') { beep(880, 90); setTimeout(() => beep(1175, 140), 110); }
    if (to === 'AWAIT_OPEN') { say('Open the plate press'); }
    if (to === 'COMPLETE') { beep(880, 100); setTimeout(() => beep(1320, 220), 130); say('Plate press motion completed'); }
  }
  setInterval(() => {
    const s = state.snap && state.snap.session;
    if (s && s.alarm && Date.now() - state.lastBeep > 600) { state.lastBeep = Date.now(); beep(1000, 160, 0.12); }
  }, 100);

  // ------------------------------------------------------------------ log
  function addLog(line) {
    const li = document.createElement('li');
    li.className = line.level;
    li.innerHTML = `<b>${new Date(line.at).toLocaleTimeString([], { hour12: false })}</b>${line.text}`;
    els.log.appendChild(li);
    while (els.log.children.length > 80) els.log.removeChild(els.log.firstChild);
    els.log.scrollTop = els.log.scrollHeight;
  }

  // ------------------------------------------------------------------ controls
  async function loadModels() {
    const r = await fetch('/api/models'); const m = await r.json();
    state.defaultPrompt = m.default_prompt; state.bench = m.bench;
    const bench = new Map((m.bench && m.bench.summary || []).map((b) => [b.model, b]));
    const label = (id) => { const b = bench.get(id); return b && b.p50_ms ? `${id} · ${b.p50_ms} ms · ${Math.round(b.strict_acc * 100)}%` : id; };
    const opts = m.candidates.map((id) => `<option value="${id}">${label(id)}</option>`).join('');
    els.model.innerHTML = opts; els.model2.innerHTML = `<option value="">nothing</option>` + opts;
    if (state.snap) syncControls(state.snap);
  }
  loadModels();
  const pushConfig = () => cmd({ cmd: 'set', config: {
    models: [els.model.value, els.model2.value].filter(Boolean),
    mode: els.mode.value,
    maxInflight: Number(els.inflight.value), minIntervalMs: Number(els.interval.value),
    params: { confirmations: Number(els.confirm.value), countdown_ms: Number(els.dwell.value) * 1000, settle_ms: Number(els.settle.value), hand_free_close: els.handfree.value === 'true' },
  } });
  for (const el of [els.model, els.model2, els.mode, els.inflight, els.interval, els.confirm, els.dwell, els.settle, els.handfree]) {
    el.addEventListener('focus', () => (state.editing = true));
    el.addEventListener('blur', () => (state.editing = false));
    el.addEventListener('change', pushConfig);
  }
  els.source.addEventListener('change', () => cmd({ cmd: 'set', config: { source: els.source.value } }));
  const cam = () => (state.snap && state.snap.config.camera) || { rotation: 0, mirror: false, aspect: 'native' };
  const pushCamera = () => cmd({ cmd: 'set_camera', camera: { rotation: els.camRot ? Number(els.camRot.value) : cam().rotation, mirror: els.camMirror ? els.camMirror.value === 'true' : cam().mirror, aspect: els.camAspect ? els.camAspect.value : cam().aspect, longEdge: Number(els.camEdge.value), fps: Number(els.camFps.value) } });
  for (const el of [els.camRot, els.camMirror, els.camAspect, els.camEdge, els.camFps].filter(Boolean)) {
    el.addEventListener('focus', () => (state.editing = true));
    el.addEventListener('blur', () => (state.editing = false));
    el.addEventListener('change', pushCamera);
  }
  let replaying = false;
  if ($('btn-replay')) $('btn-replay').onclick = (e) => { replaying = !replaying; cmd({ cmd: 'replay', action: replaying ? 'start' : 'stop', loop: false, fps: 6 }); e.target.textContent = replaying ? 'Stop replay' : 'Replay demo clip'; };
  $('btn-sound').onclick = (e) => { state.sound = !state.sound; e.target.setAttribute('aria-pressed', String(state.sound)); e.target.textContent = state.sound ? 'Sound on' : 'Sound off'; if (state.sound) beep(660, 80); };
  $('btn-voice').onclick = (e) => { state.voice = !state.voice; e.target.setAttribute('aria-pressed', String(state.voice)); e.target.textContent = state.voice ? 'Voice on' : 'Voice off'; if (!state.voice) playPcm({ stop: true }, new Uint8Array(0)); };
  for (const el of [els.voiceName, els.voiceSpeed, els.voiceEnabled]) {
    el.addEventListener('focus', () => (state.editing = true));
    el.addEventListener('blur', () => (state.editing = false));
    el.addEventListener('change', () => cmd({ cmd: 'set', config: { voice: { enabled: els.voiceEnabled.value === 'true', voice: els.voiceName.value, speed: Number(els.voiceSpeed.value) } } }));
  }
  if ($('btn-prompt')) $('btn-prompt').onclick = () => { els.promptBox.hidden = !els.promptBox.hidden; };
  if ($('btn-prompt-save')) $('btn-prompt-save').onclick = () => cmd({ cmd: 'set', config: { prompt: els.prompt.value } });
  if ($('btn-prompt-reset')) $('btn-prompt-reset').onclick = () => { els.prompt.value = state.defaultPrompt; cmd({ cmd: 'set', config: { prompt: state.defaultPrompt } }); };

  // ------------------------------------------------------------------ chat
  const CHAT_MODELS = ['groq/openai/gpt-oss-20b', 'groq/openai/gpt-oss-120b', 'groq/qwen/qwen3.8-27b', 'cerebras/gpt-oss-120b', 'cerebras/qwen-3.8-27b', 'gpt-5.4-nano', 'gpt-5.4-mini', 'gpt-4.1-nano', 'gpt-4.1-mini', 'gpt-4o-mini', 'gemini-3.5-flash-lite', 'gemini-3.1-flash-lite', 'xai/grok-4.20-0309-non-reasoning'];
  const VISION_MODELS = ['gpt-4.1-mini', 'gpt-4.1-nano', 'gpt-5.4-mini', 'gpt-5.4-nano', 'gpt-4o-mini', 'gemini-3.5-flash-lite', 'gemini-3.1-flash-lite'];
  els.chatFast.innerHTML = CHAT_MODELS.map((m) => `<option value="${m}">${m}</option>`).join('');
  els.chatVision.innerHTML = VISION_MODELS.map((m) => `<option value="${m}">${m}</option>`).join('');
  for (const el of [els.chatFast, els.chatVision]) {
    el.addEventListener('focus', () => (state.editing = true));
    el.addEventListener('blur', () => (state.editing = false));
    el.addEventListener('change', () => cmd({ cmd: 'set', config: { chatFast: els.chatFast.value, chatVision: els.chatVision.value } }));
  }
  function showThinking(label) {
    let li = document.getElementById('chat-thinking-bubble');
    if (!li) { li = document.createElement('li'); li.id = 'chat-thinking-bubble'; li.className = 'assistant thinking'; li.innerHTML = '<i></i><i></i><i></i><small></small>'; els.chatLog.appendChild(li); }
    li.querySelector('small').textContent = label || '';
    els.chatLog.appendChild(li); // keep it last
    els.chatLog.scrollTop = els.chatLog.scrollHeight;
  }
  function hideThinking() { const li = document.getElementById('chat-thinking-bubble'); if (li) li.remove(); }
  function addDelta(m) {
    hideThinking();
    let li = document.getElementById(`chat-${m.id}`);
    if (!li) {
      li = document.createElement('li'); li.className = 'assistant streaming'; li.id = `chat-${m.id}`; li.textContent = '';
      els.chatLog.appendChild(li);
    }
    li.textContent += m.delta;
    els.chatLog.scrollTop = els.chatLog.scrollHeight;
  }
  function addChat(m, fresh) {
    if (m.role === 'assistant') hideThinking();
    let li = document.getElementById(`chat-${m.id}`);
    if (li) { li.classList.remove('streaming'); li.textContent = m.text; }
    else { li = document.createElement('li'); li.className = m.role; li.id = `chat-${m.id}`; li.textContent = m.text; }
    const small = document.createElement('small');
    small.textContent = `${new Date(m.at).toLocaleTimeString([], { hour12: false })}${m.from && m.role === 'user' ? ` · from ${m.from}` : ''}${m.model ? ` · ${m.model}${m.ms ? ` · ${m.ms} ms` : ''}` : ''}`;
    li.appendChild(small);
    if (!li.parentNode) els.chatLog.appendChild(li);
    if (m.role === 'user' && fresh) showThinking('');
    els.chatLog.scrollTop = els.chatLog.scrollHeight;
    if (m.role === 'assistant' && fresh) { state.hudChat = { text: m.text, at: Date.now() }; }
  }
  els.chatForm.addEventListener('submit', (e) => {
    e.preventDefault();
    const text = els.chatInput.value.trim();
    if (!text) return;
    send({ t: 'chat', text });
    els.chatInput.value = '';
    showThinking('');
  });
  // Voice at the Mac: browser speech recognition, one utterance per click.
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  let rec = null;
  if (!SR) { els.mic.disabled = true; els.mic.title = 'Speech recognition is not available in this browser'; }
  els.mic.onclick = () => {
    if (rec) { rec.stop(); return; }
    rec = new SR(); rec.lang = 'en-US'; rec.interimResults = true; rec.continuous = false;
    els.mic.setAttribute('aria-pressed', 'true'); els.mic.textContent = 'Listening';
    rec.onresult = (ev) => { let t = ''; for (const r of ev.results) t += r[0].transcript; els.chatInput.value = t; if (ev.results[ev.results.length - 1].isFinal) { send({ t: 'chat', text: t.trim() }); els.chatInput.value = ''; showThinking(''); } };
    rec.onend = () => { rec = null; els.mic.setAttribute('aria-pressed', 'false'); els.mic.textContent = 'Mic'; };
    rec.onerror = () => { rec = null; els.mic.setAttribute('aria-pressed', 'false'); els.mic.textContent = 'Mic'; };
    rec.start();
  };
  $('btn-retrain').onclick = async (e) => { e.target.disabled = true; const r = await fetch('/api/retrain', { method: 'POST' }); const j = await r.json(); e.target.textContent = `Retraining on ${j.live_frames} real frames…`; setTimeout(() => { e.target.disabled = false; e.target.textContent = 'Retrain local classifier'; }, 90000); };

  // ------------------------------------------------------------------ webcam source (this computer's camera acts like the glasses)
  let camWs = null, camTimer = null;
  if ($('btn-webcam')) $('btn-webcam').onclick = async (e) => {
    if (camWs) { clearInterval(camTimer); camWs.close(); camWs = null; e.target.textContent = "Use this computer's camera"; return; }
    const video = $('webcam-video'); const canvas = $('webcam-canvas');
    const stream = await navigator.mediaDevices.getUserMedia({ video: { width: 640, height: 360 }, audio: false });
    video.srcObject = stream; await video.play();
    camWs = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws/webcam`);
    camWs.onopen = () => camWs.send(JSON.stringify({ t: 'hello', device: { kind: 'browser-webcam', ua: navigator.userAgent.slice(0, 60) } }));
    let seq = 0;
    let prevSmall = null;
    const smallCanvas = document.createElement('canvas'); smallCanvas.width = 48; smallCanvas.height = 36;
    const measureMotion = () => {
      const c = smallCanvas.getContext('2d', { willReadFrequently: true }); c.drawImage(video, 0, 0, 48, 36);
      const d = c.getImageData(0, 0, 48, 36).data; const cur = new Uint8Array(48 * 36);
      for (let i = 0; i < cur.length; i++) cur[i] = (d[i * 4] * 77 + d[i * 4 + 1] * 150 + d[i * 4 + 2] * 29) >> 8;
      let sum = 0; if (prevSmall) for (let i = 0; i < cur.length; i++) sum += Math.abs(cur[i] - prevSmall[i]);
      const score = prevSmall ? Math.min(1, sum / cur.length / 40) : 0; prevSmall = cur; return score;
    };
    camTimer = setInterval(() => {
      if (!camWs || camWs.readyState !== 1 || camWs.bufferedAmount > 200_000) return;
      const w = 480, h = Math.round((480 * video.videoHeight) / (video.videoWidth || 640));
      canvas.width = w; canvas.height = h;
      canvas.getContext('2d').drawImage(video, 0, 0, w, h);
      canvas.toBlob(async (blob) => {
        const header = new TextEncoder().encode(JSON.stringify({ seq: seq++, ts: Date.now(), w, h, motion: +measureMotion().toFixed(3) }));
        const out = new Uint8Array(2 + header.length + blob.size);
        out[0] = header.length >> 8; out[1] = header.length & 255; out.set(header, 2); out.set(new Uint8Array(await blob.arrayBuffer()), 2 + header.length);
        camWs.send(out);
      }, 'image/jpeg', 0.6);
    }, 150);
    e.target.textContent = 'Stop this computer\'s camera';
  };

  connect();
})();
