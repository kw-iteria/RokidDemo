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
      else if (msg.t === 'log.history') { els.log.replaceChildren(); for (const l of msg.lines) addLog(l); }
      else if (msg.t === 'chat') addChat(msg, true);
      else if (msg.t === 'chat.delta') addDelta(msg);
      else if (msg.t === 'chat.history') { els.chatLog.querySelectorAll('li:not(.hint)').forEach((n) => n.remove()); state.hudChat = null; for (const m of msg.messages) addChat(m, false); scrollSoon(els.chatLog); }
      else if (msg.t === 'conversations') renderConversations(msg);
      else if (msg.t === 'chat.thinking') { if (msg.on) showThinking(msg.stt ? 'transcribing' : ''); else if (!document.querySelector('.chat-log li.streaming')) hideThinking(); }
    };
  }
  function send(obj) { if (ws && ws.readyState === 1) ws.send(JSON.stringify(obj)); }
  const cmd = (o) => send({ t: 'cmd', ...o });

  // ------------------------------------------------------------------ frames
  // ---- streamed neural voice (PCM16 mono from the server) ----
  // One AudioContext for voice and beeps, opened once and unlocked on the first click/key: opening a
  // context per reply cost 20-100 ms, and a context created outside a user gesture may stay silent.
  let actx = null;
  function audioCtx() {
    if (!actx) actx = new (window.AudioContext || window.webkitAudioContext)();
    if (actx.state === 'suspended') actx.resume().catch(() => {});
    return actx;
  }
  const unlockAudio = () => { audioCtx(); window.removeEventListener('pointerdown', unlockAudio); window.removeEventListener('keydown', unlockAudio); };
  window.addEventListener('pointerdown', unlockAudio); window.addEventListener('keydown', unlockAudio);

  const voice = { nextTime: 0, currentId: null, sources: new Set() };
  function stopVoice() {
    for (const src of voice.sources) { try { src.stop(); } catch (e) { /* already ended */ } }
    voice.sources.clear(); voice.nextTime = 0; voice.currentId = null;
  }
  function playPcm(header, pcmBytes) {
    if (!state.voice) return;
    if (header.stop) { stopVoice(); return; }
    if (!pcmBytes.byteLength) return;
    const ctx = audioCtx();
    let lead = 0.005;
    if (voice.currentId !== header.id) { stopVoice(); voice.currentId = header.id; lead = 0.05; } // first chunk: small cushion against bursty arrival
    const samples = pcmBytes.byteLength >> 1;
    const int16 = new Int16Array(pcmBytes.buffer.slice(pcmBytes.byteOffset, pcmBytes.byteOffset + samples * 2));
    const buffer = ctx.createBuffer(1, samples, header.rate || 24000);
    const ch = buffer.getChannelData(0);
    for (let i = 0; i < samples; i++) ch[i] = int16[i] / 32768;
    const src = ctx.createBufferSource(); src.buffer = buffer; src.connect(ctx.destination);
    const at = Math.max(ctx.currentTime + lead, voice.nextTime);
    src.start(at); voice.nextTime = at + buffer.duration;
    voice.sources.add(src); src.onended = () => voice.sources.delete(src);
  }

  // Newest-frame-wins display: never more than one JPEG decoding, and every object URL is revoked.
  const frameView = { busy: false, pending: null, url: null };
  const headerDecoder = new TextDecoder();
  function showFrame(bytes) {
    if (frameView.busy) { frameView.pending = bytes; return; }
    frameView.busy = true;
    const url = URL.createObjectURL(new Blob([bytes], { type: 'image/jpeg' }));
    const done = () => {
      // size the box to the frame's shape so the whole picture is shown (portrait frames from the glasses too)
      const w = els.live.naturalWidth, h = els.live.naturalHeight;
      if (w && h && frameView.ar !== w / h) { frameView.ar = w / h; $('media-grid').style.setProperty('--ar', String(frameView.ar)); }
      if (frameView.url) URL.revokeObjectURL(frameView.url);
      frameView.url = url; frameView.busy = false;
      const next = frameView.pending; frameView.pending = null;
      if (next) showFrame(next);
    };
    els.live.onload = done; els.live.onerror = done;
    els.live.src = url;
    if (!$('frame-box').classList.contains('on')) {
      $('frame-box').classList.add('on'); els.liveEmpty.style.display = 'none';
      document.querySelector('.viewport').classList.add('has-frame');
    }
  }
  function onFrame(buf) {
    const n = new DataView(buf).getUint16(0);
    if (n < 400) {
      try { const h = JSON.parse(headerDecoder.decode(new Uint8Array(buf, 2, n))); if (h.t === 'tts') return playPcm(h, new Uint8Array(buf, 2 + n)); } catch (e) { /* camera frame */ }
    }
    showFrame(new Uint8Array(buf, 2 + n)); // a view, no copy
  }

  // ------------------------------------------------------------------ state
  function onState(msg) {
    state.offset = msg.server_now - Date.now();
    state.snap = msg;
    const s = msg.session;
    const active = msg.sources.find((x) => x.active);
    const idleGlasses = msg.sources.find((x) => x.kind === 'glasses' && !x.alive && x.info && x.info.camera);
    if (els.srcPill) els.srcPill.textContent = active ? `${active.kind} ${active.fps} fps` : idleGlasses ? `glasses connected, camera: ${idleGlasses.info.camera.status}${idleGlasses.info.camera.permission === false ? ' (permission missing)' : ''}` : 'no camera';
    if (els.srcPill) els.srcPill.className = active ? 'pill ok' : idleGlasses ? 'pill warn' : 'pill';
    if (els.srcPill) els.srcPill.title = idleGlasses && idleGlasses.info.camera.error ? idleGlasses.info.camera.error : '';
    document.querySelector('.viewport').classList.toggle('glasses-live', Boolean(active && active.kind === 'glasses'));
    if (els.modelPill) els.modelPill.textContent = msg.config.mode === 'local' ? `local CLIP · verified by ${msg.config.models[0]}` : msg.config.models.join(msg.config.mode === 'race' ? ' ∥ ' : ' → ');
    if (els.latPill) els.latPill.textContent = msg.stats.p50_ms ? `${msg.stats.p50_ms} ms · ${msg.stats.decisions_per_s}/s` : '— ms';
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
    renderOnboarding(msg);
    renderPairing(msg);
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
    // When the label shows the wanted state but the workflow is waiting, say why right under it.
    const why = v.why ? `<small class="why">${v.why}</small>` : '';
    els.badge.innerHTML = `<b class="${word === 'not seen' ? 'none' : word}">${word}</b>${why}<small>${detail}</small>`;
  }

  // ------------------------------------------------------------------ HUD mirror
  function serverNow() { return Date.now() + state.offset; }
  // The HUD mirror runs every animation frame; touch the DOM only when a value actually changed.
  const shown = new Map();
  function put(el, key, value, apply) { if (shown.get(key) === value) return; shown.set(key, value); apply(el, value); }
  const text = (el, v) => { el.textContent = v; };
  function renderHud() {
    const s = state.snap && state.snap.session;
    if (!s) return;
    put(els.hud, 'phase', s.phase, (el, v) => { el.dataset.phase = v; });
    put(els.message, 'message', s.phase === 'IDLE' ? '' : s.message, text);
    put(els.sub, 'sub', s.hint || s.sub, text);
    const lv = s.last_verdict;
    const showVerdict = lv && s.phase !== 'IDLE';
    put(els.footL, 'footL', showVerdict ? (lv.press_visible ? `press ${lv.lid}` : 'press not seen') : '', text);
    put(els.footR, 'footR', showVerdict ? `${(lv.latency_ms / 1000).toFixed(1)} s` : '', text);
    if (s.phase === 'COUNTDOWN' && s.countdown) {
      const remaining = Math.max(0, s.countdown.ends_at - serverNow());
      els.arc.style.strokeDashoffset = String(553 * (1 - remaining / s.countdown.duration_ms));
      put(els.number, 'number', String(Math.ceil(remaining / 1000)), text);
    } else {
      put(els.number, 'number', '', text);
    }
    const fresh = Boolean(state.hudChat && Date.now() - state.hudChat.at < 12_000);
    put(els.hudChat, 'hudChatHidden', !fresh, (el, v) => { el.hidden = v; });
    if (fresh) put(els.hudChat, 'hudChat', state.hudChat.text, text);
  }
  function loop() { renderHud(); requestAnimationFrame(loop); }
  requestAnimationFrame(loop);

  // ------------------------------------------------------------------ welcome / onboarding
  // A live checklist that ticks itself as the system notices each step; afterwards a compact ready
  // card. "Set up once" is remembered per browser so returning users go straight to the ready view.
  const ob = { root: $('onboard'), since: 0, completed: false, forceSetup: false };
  try { ob.completed = localStorage.getItem('iteria-onboarded') === '1'; } catch (e) { /* default: first run */ }
  ob.root.querySelector('.ob-replay').onclick = () => { ob.forceSetup = true; state.snap && renderOnboarding(state.snap); };
  function renderOnboarding(msg) {
    const g = msg.sources.find((x) => x.kind === 'glasses');
    const info = (g && g.info) || {};
    const connected = Boolean(g);
    const seeing = Boolean(g && g.alive);
    const heard = Boolean(info.mic && info.mic.utterances > 0) || ob.heard;
    const done = { wear: connected, pair: connected, see: seeing, talk: heard };
    const order = ['wear', 'pair', 'see', 'talk'];
    const all = order.every((k) => done[k]);
    if (all && !ob.completed) { ob.completed = true; ob.forceSetup = false; try { localStorage.setItem('iteria-onboarded', '1'); } catch (e) { /* ok */ } }
    const showSetup = ob.forceSetup ? !all : !(ob.completed && connected);
    ob.root.querySelector('.ob-setup').hidden = !showSetup;
    ob.root.querySelector('.ob-ready').hidden = showSetup;
    if (showSetup) {
      // returning users whose glasses are just not connected get a short "reconnect" greeting
      put(ob.root.querySelector('.ob-setup .ob-title'), 'obTitle', ob.completed ? 'Connect your glasses' : 'Welcome to Iteria', text);
      put(ob.root.querySelector('.ob-lead'), 'obLead', ob.completed ? 'Open Iteria on your Rokid glasses; they connect by themselves.' : "Let's set up your glasses. It takes about a minute.", text);
      const now = order.find((k) => !done[k]);
      // "wear" and "wifi" can't be observed; while waiting for the glasses they are the current steps together with "app"
      for (const li of ob.root.querySelectorAll('.ob-steps li')) {
        const k = li.dataset.step;
        // before the glasses appear, "look at the code" is the live step ("put on" can't be observed)
        const isNow = !done[k] && (connected ? k === now : k === 'pair');
        li.className = done[k] ? 'done' : isNow ? 'now' : '';
      }
      // not found after a while: the live step's note turns into a concrete way out
      if (!connected) { if (!ob.since) ob.since = Date.now(); } else ob.since = 0;
      const stuck = !connected && ob.since && Date.now() - ob.since > 20_000;
      const addr = msg.hosts.length ? `${msg.hosts[0]}:${msg.port}` : '';
      put(ob.root.querySelector('.ob-app-note'), 'obApp', connected ? `Found your ${info.model ? `Rokid ${info.model}` : 'glasses'}.`
        : stuck ? `Still waiting… come a little closer, or click the code to make it bigger.${addr ? ` This computer is ${addr}.` : ''}`
        : "From about a hand's span away. They join the Wi-Fi and connect by themselves.", text);
    } else {
      const parts = [info.model ? `Rokid ${info.model}` : 'Glasses', seeing ? `camera ${g.fps} fps` : 'camera starting', info.mic && info.mic.enabled === false ? 'mic muted (hold the temple to unmute)' : 'mic on'];
      put(ob.root.querySelector('.ob-status'), 'obStatus', parts.join(' · '), text);
    }
  }
  // ------------------------------------------------------------------ pairing code ("look at the screen")
  const pair = { img: $('pair-code'), key: '', editing: false };
  function renderPairing(msg) {
    const p = msg.pairing || { ssid: '', has_password: false };
    const key = `${msg.hosts.join(',')}|${msg.port}|${p.ssid}|${p.has_password}`;
    if (key !== pair.key) { pair.key = key; pair.img.src = $('pair-code-full').src = `/api/pair.svg?v=${encodeURIComponent(key)}`; }
    // the full-screen code closes by itself once the glasses are connected
    if (msg.sources.some((x) => x.kind === 'glasses')) $('pair-full').hidden = true;
    if (!pair.editing) {
      put($('pair-wifi-label'), 'pairLabel', p.ssid ? `Wi-Fi: ${p.ssid}` : 'No Wi-Fi set: the glasses must already be online.', text);
      put($('pair-edit'), 'pairEdit', p.ssid ? 'Change' : 'Set Wi-Fi', text);
    }
  }
  $('pair-zoom').onclick = () => { $('pair-full').hidden = false; };
  $('pair-full').onclick = () => { $('pair-full').hidden = true; };
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') $('pair-full').hidden = true; });
  const pairShow = document.querySelector('.pair-wifi-show'), pairEdit = document.querySelector('.pair-wifi-edit');
  $('pair-edit').onclick = () => {
    pair.editing = true; pairShow.hidden = true; pairEdit.hidden = false;
    $('pair-ssid').value = (state.snap && state.snap.pairing && state.snap.pairing.ssid) || ''; $('pair-pass').value = '';
    $('pair-ssid').focus();
  };
  $('pair-form').addEventListener('submit', (e) => {
    e.preventDefault();
    cmd({ cmd: 'set_pairing', ssid: $('pair-ssid').value, password: $('pair-pass').value });
    pair.editing = false; pairShow.hidden = false; pairEdit.hidden = true; $('pair-pass').value = '';
  });
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
  function beep(freq, ms, gain = 0.08) {
    if (!state.sound) return;
    const audio = audioCtx();
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
    const b = document.createElement('b'); b.textContent = new Date(line.at).toLocaleTimeString([], { hour12: false });
    li.append(b, line.text); // text, not HTML
    els.log.appendChild(li);
    while (els.log.children.length > 150) els.log.removeChild(els.log.firstChild);
    scrollSoon(els.log);
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

  // ------------------------------------------------------------------ conversations sidebar
  const convList = $('conv-list');
  function dayGroup(ts) {
    const d = new Date(ts); const today = new Date(); today.setHours(0, 0, 0, 0);
    const diff = (today - new Date(d.getFullYear(), d.getMonth(), d.getDate())) / 86_400_000;
    return diff <= 0 ? 'Today' : diff === 1 ? 'Yesterday' : diff < 7 ? 'Previous 7 days' : diff < 30 ? 'Previous 30 days' : 'Older';
  }
  function renderConversations(msg) {
    const frag = document.createDocumentFragment();
    let group = '';
    for (const c of msg.items) {
      const g = dayGroup(c.updated_at);
      if (g !== group) { group = g; const h = document.createElement('h3'); h.textContent = g; frag.appendChild(h); }
      const row = document.createElement('div');
      row.className = 'conv' + (c.id === msg.current ? ' current' : '');
      const open = document.createElement('button');
      open.type = 'button'; open.className = 'conv-open'; open.textContent = c.title; open.title = c.title;
      if (c.id === msg.current) open.setAttribute('aria-current', 'true');
      open.onclick = () => send({ t: 'open_chat', id: c.id });
      const del = document.createElement('button');
      del.type = 'button'; del.className = 'conv-del'; del.setAttribute('aria-label', `Delete "${c.title}"`); del.title = 'Delete';
      del.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 6h18M8 6V4h8v2M6 6l1 14h10l1-14"/></svg>';
      del.onclick = (e) => { // two clicks: arm, then delete
        e.stopPropagation();
        if (del.classList.contains('armed')) { send({ t: 'delete_chat', id: c.id }); return; }
        del.classList.add('armed'); del.textContent = 'Delete';
        setTimeout(() => { if (del.isConnected) { del.classList.remove('armed'); del.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 6h18M8 6V4h8v2M6 6l1 14h10l1-14"/></svg>'; } }, 3000);
      };
      row.append(open, del);
      frag.appendChild(row);
    }
    if (!msg.items.length) { const p = document.createElement('p'); p.className = 'conv-empty'; p.textContent = 'Past chats appear here.'; frag.appendChild(p); }
    convList.replaceChildren(frag);
    const cur = msg.items.find((c) => c.id === msg.current);
    $('chat-title').textContent = cur ? cur.title : 'New chat';
  }
  const newChat = () => { send({ t: 'new_chat' }); els.chatInput.focus(); };
  $('btn-new-chat').onclick = newChat;
  $('btn-new-chat-top').onclick = newChat;
  // Conversations drawer: slides out over the left part of the chat window (nothing else moves).
  const chatBox = document.querySelector('.chat');
  const sidebarBtn = $('btn-sidebar');
  const setDrawer = (open) => {
    chatBox.classList.toggle('drawer-open', open);
    sidebarBtn.setAttribute('aria-expanded', String(open));
    sidebarBtn.setAttribute('aria-label', open ? 'Hide conversations' : 'Show conversations');
  };
  const drawerOpen = () => chatBox.classList.contains('drawer-open');
  sidebarBtn.onclick = () => setDrawer(!drawerOpen());
  $('chat-scrim').onclick = () => setDrawer(false);
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && drawerOpen()) setDrawer(false); });
  convList.addEventListener('click', (e) => { if (e.target.closest('.conv-open')) setDrawer(false); });
  $('btn-new-chat').addEventListener('click', () => setDrawer(false));

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
  // Scroll to the bottom at most once per frame (each scroll forces a layout).
  const toScroll = new Set();
  function scrollSoon(el) {
    if (!toScroll.size) requestAnimationFrame(() => { for (const e of toScroll) e.scrollTop = e.scrollHeight; toScroll.clear(); });
    toScroll.add(el);
  }
  function showThinking(label) {
    let li = document.getElementById('chat-thinking-bubble');
    if (!li) { li = document.createElement('li'); li.id = 'chat-thinking-bubble'; li.className = 'assistant thinking'; li.innerHTML = '<i></i><i></i><i></i><small></small>'; els.chatLog.appendChild(li); }
    li.querySelector('small').textContent = label || '';
    els.chatLog.appendChild(li); // keep it last
    scrollSoon(els.chatLog);
  }
  function hideThinking() { const li = document.getElementById('chat-thinking-bubble'); if (li) li.remove(); }
  function addDelta(m) {
    hideThinking();
    let li = document.getElementById(`chat-${m.id}`);
    if (!li) {
      li = document.createElement('li'); li.className = 'assistant streaming'; li.id = `chat-${m.id}`;
      li.appendChild(document.createTextNode(''));
      els.chatLog.appendChild(li);
    }
    li.firstChild.appendData(m.delta); // append, don't rebuild the whole string
    scrollSoon(els.chatLog);
  }
  function addChat(m, fresh) {
    if (m.role === 'user' && m.from && String(m.from).startsWith('glasses')) ob.heard = true;
    if (m.role === 'assistant') hideThinking();
    let li = document.getElementById(`chat-${m.id}`);
    if (li) { li.classList.remove('streaming'); li.textContent = m.text; }
    else { li = document.createElement('li'); li.className = m.role; li.id = `chat-${m.id}`; li.textContent = m.text; }
    const small = document.createElement('small');
    small.textContent = `${new Date(m.at).toLocaleTimeString([], { hour12: false })}${m.from && m.role === 'user' ? ` · from ${m.from}` : ''}${m.model ? ` · ${m.model}${m.ms ? ` · ${m.ms} ms` : ''}` : ''}`;
    li.appendChild(small);
    if (!li.parentNode) els.chatLog.appendChild(li);
    if (m.role === 'user' && fresh) showThinking('');
    scrollSoon(els.chatLog);
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
    const enc = new TextEncoder();
    camTimer = setInterval(() => {
      if (!camWs || camWs.readyState !== 1 || camWs.bufferedAmount > 200_000) return;
      const w = 480, h = Math.round((480 * video.videoHeight) / (video.videoWidth || 640));
      if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h; } // resizing reallocates the canvas
      canvas.getContext('2d').drawImage(video, 0, 0, w, h);
      const meta = { seq: seq++, ts: Date.now(), w, h, motion: +measureMotion().toFixed(3) }; // capture time, before encoding
      canvas.toBlob((blob) => {
        if (!blob || !camWs || camWs.readyState !== 1) return;
        const header = enc.encode(JSON.stringify(meta));
        camWs.send(new Blob([new Uint8Array([header.length >> 8, header.length & 255]), header, blob]));
      }, 'image/jpeg', 0.6);
    }, 150);
    e.target.textContent = 'Stop this computer\'s camera';
  };

  connect();
})();


// Settings and Activity: dedicated pages at #settings / #activity (browser back and Esc return to the console).
(() => {
  const pages = { settings: document.getElementById('btn-settings'), activity: document.getElementById('btn-activity') };
  let pushed = false; // only step back in history if we opened the page ourselves
  const current = () => location.hash.slice(1);
  const sync = () => {
    const open = current();
    for (const [name, btn] of Object.entries(pages)) {
      const on = open === name;
      document.getElementById(`${name}-page`).hidden = !on;
      btn.setAttribute('aria-expanded', String(on));
    }
    document.body.classList.toggle('page-open', Boolean(pages[open]));
    if (pages[open]) window.scrollTo(0, 0);
    if (open === 'activity') { const log = document.getElementById('log'); log.scrollTop = log.scrollHeight; }
  };
  const close = () => {
    if (!pages[current()]) return;
    if (pushed) { pushed = false; history.back(); }
    else { history.replaceState(null, '', location.pathname + location.search); sync(); }
  };
  for (const [name, btn] of Object.entries(pages)) {
    btn.addEventListener('click', () => {
      if (current() === name) close();
      else if (pages[current()]) location.replace(`#${name}`); // switching between pages: no extra history step
      else { pushed = true; location.hash = name; }
    });
  }
  for (const b of document.querySelectorAll('.page-close')) b.addEventListener('click', close);
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && pages[current()]) close(); });
  window.addEventListener('hashchange', sync);
  sync();
})();

// Theme toggle (dark / light), remembered per browser.
(() => {
  const btn = document.getElementById('btn-theme');
  const apply = (t) => {
    document.documentElement.dataset.theme = t;
    btn.setAttribute('aria-label', t === 'dark' ? 'Switch to light mode' : 'Switch to dark mode');
  };
  apply(document.documentElement.dataset.theme === 'light' ? 'light' : 'dark');
  btn.addEventListener('click', () => {
    const next = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
    apply(next);
    try { localStorage.setItem('iteria-theme', next); } catch (e) { /* private mode */ }
  });
})();
