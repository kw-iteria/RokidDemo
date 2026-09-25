/* PlatePress console: mirrors the glasses HUD, shows the live camera and model verdicts, and
   lets you switch camera source / model / prompt. Plain JS, no build step. */
(() => {
  const $ = (id) => document.getElementById(id);
  const els = {
    conn: $('conn'), srcPill: $('src-pill'), modelPill: $('model-pill'), latPill: $('lat-pill'),
    live: $('live'), liveEmpty: $('live-empty'), badge: $('verdict-badge'), ribbon: $('ribbon'),
    hud: $('hud'), arc: $('dial-arc'), number: $('hud-number'), message: $('hud-message'), sub: $('hud-sub'),
    footL: $('hud-foot-left'), footR: $('hud-foot-right'), timing: $('timing'),
    source: $('source'), model: $('model'), model2: $('model2'), inflight: $('inflight'), interval: $('interval'),
    confirm: $('confirm'), dwell: $('dwell'), hosts: $('hosts'), log: $('log'),
    prompt: $('prompt'), promptBox: $('prompt-box'),
  };
  const state = { snap: null, offset: 0, verdicts: [], lastFrameUrl: null, sound: true, voice: false, lastPhase: null, lastBeep: 0, defaultPrompt: '', bench: null, editing: false };

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
      else if (msg.t === 'log') addLog(msg);
    };
  }
  function send(obj) { if (ws && ws.readyState === 1) ws.send(JSON.stringify(obj)); }
  const cmd = (o) => send({ t: 'cmd', ...o });

  // ------------------------------------------------------------------ frames
  function onFrame(buf) {
    const view = new DataView(buf);
    const n = view.getUint16(0);
    const jpeg = new Blob([buf.slice(2 + n)], { type: 'image/jpeg' });
    const url = URL.createObjectURL(jpeg);
    els.live.onload = () => { if (state.lastFrameUrl) URL.revokeObjectURL(state.lastFrameUrl); state.lastFrameUrl = url; };
    els.live.src = url;
    els.live.classList.add('on');
    els.liveEmpty.style.display = 'none';
  }

  // ------------------------------------------------------------------ state
  function onState(msg) {
    state.offset = msg.server_now - Date.now();
    state.snap = msg;
    const s = msg.session;
    const active = msg.sources.find((x) => x.active);
    els.srcPill.textContent = active ? `${active.kind} ${active.fps} fps` : 'no camera';
    els.srcPill.className = active ? 'pill ok' : 'pill';
    els.modelPill.textContent = msg.config.models.join(' + ');
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
    els.inflight.value = msg.config.maxInflight;
    els.interval.value = msg.config.minIntervalMs;
    els.confirm.value = msg.config.params.confirmations;
    els.dwell.value = Math.round(msg.config.params.countdown_ms / 1000);
    if (document.activeElement !== els.prompt) els.prompt.value = msg.config.prompt;
  }

  function onVerdict(v) {
    state.verdicts.push(v);
    if (state.verdicts.length > 400) state.verdicts.shift();
    els.badge.innerHTML = v.press_visible ? `<b>${v.lid}</b> · ${v.confidence.toFixed(2)} · ${v.latency_ms} ms · ${v.model}` : `<b>press not seen</b> · ${v.latency_ms} ms · ${v.model}`;
    drawRibbon();
  }

  // ------------------------------------------------------------------ HUD mirror
  function serverNow() { return Date.now() + state.offset; }
  function renderHud() {
    const s = state.snap && state.snap.session;
    if (!s) return;
    els.hud.dataset.phase = s.phase;
    els.message.textContent = s.message;
    els.sub.textContent = s.hint || s.sub;
    const lv = s.last_verdict;
    els.footL.textContent = lv ? (lv.press_visible ? `press ${lv.lid}` : 'press not seen') : '';
    els.footR.textContent = lv ? `${(lv.latency_ms / 1000).toFixed(1)} s` : '';
    if (s.phase === 'COUNTDOWN' && s.countdown) {
      const remaining = Math.max(0, s.countdown.ends_at - serverNow());
      const frac = remaining / s.countdown.duration_ms;
      els.arc.style.strokeDashoffset = String(553 * (1 - frac));
      els.number.textContent = String(Math.ceil(remaining / 1000));
    }
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
      ['Race wins', Object.entries(st.per_model || {}).map(([m, v]) => `${m} ${v.wins} (${v.p50_ms} ms${v.errors ? `, ${v.errors} err` : ''})`).join(' · ') || '—'],
    ].map(([k, v]) => `<div><span>${k}</span>${v}</div>`).join('');
  }

  // ------------------------------------------------------------------ ribbon (last 60 s of verdicts)
  function drawRibbon() {
    const c = els.ribbon; const ctx = c.getContext('2d');
    const w = (c.width = c.clientWidth * devicePixelRatio); const h = (c.height = 28 * devicePixelRatio);
    ctx.clearRect(0, 0, w, h);
    const now = serverNow(); const span = 60_000;
    const color = { open: '#8ccfff', closed: '#f0b241', partial: '#6c7a86', unknown: '#2f3a43' };
    for (const v of state.verdicts) {
      const age = now - v.frame_ts; if (age > span) continue;
      const x = w - (age / span) * w;
      const st = v.press_visible ? v.lid : 'unknown';
      ctx.fillStyle = color[st] || color.unknown;
      const bh = h * (0.35 + 0.65 * (v.confidence || 0.5));
      ctx.fillRect(x - 2 * devicePixelRatio, h - bh, 3 * devicePixelRatio, bh);
    }
  }
  setInterval(drawRibbon, 500);

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
    if (!state.voice || !('speechSynthesis' in window)) return;
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
    maxInflight: Number(els.inflight.value), minIntervalMs: Number(els.interval.value),
    params: { confirmations: Number(els.confirm.value), countdown_ms: Number(els.dwell.value) * 1000 },
  } });
  for (const el of [els.model, els.model2, els.inflight, els.interval, els.confirm, els.dwell]) {
    el.addEventListener('focus', () => (state.editing = true));
    el.addEventListener('blur', () => (state.editing = false));
    el.addEventListener('change', pushConfig);
  }
  els.source.addEventListener('change', () => cmd({ cmd: 'set', config: { source: els.source.value } }));
  $('btn-restart').onclick = () => cmd({ cmd: 'restart' });
  let replaying = false;
  $('btn-replay').onclick = (e) => { replaying = !replaying; cmd({ cmd: 'replay', action: replaying ? 'start' : 'stop', loop: false, fps: 6 }); e.target.textContent = replaying ? 'Stop replay' : 'Replay demo clip'; };
  $('btn-sound').onclick = (e) => { state.sound = !state.sound; e.target.setAttribute('aria-pressed', String(state.sound)); e.target.textContent = state.sound ? 'Sound on' : 'Sound off'; if (state.sound) beep(660, 80); };
  $('btn-voice').onclick = (e) => { state.voice = !state.voice; e.target.setAttribute('aria-pressed', String(state.voice)); e.target.textContent = state.voice ? 'Voice on' : 'Voice off'; if (state.voice) say('Voice on'); };
  $('btn-prompt').onclick = () => { els.promptBox.hidden = !els.promptBox.hidden; };
  $('btn-prompt-save').onclick = () => cmd({ cmd: 'set', config: { prompt: els.prompt.value } });
  $('btn-prompt-reset').onclick = () => { els.prompt.value = state.defaultPrompt; cmd({ cmd: 'set', config: { prompt: state.defaultPrompt } }); };

  // ------------------------------------------------------------------ webcam source (this computer's camera acts like the glasses)
  let camWs = null, camTimer = null;
  $('btn-webcam').onclick = async (e) => {
    if (camWs) { clearInterval(camTimer); camWs.close(); camWs = null; e.target.textContent = "Use this computer's camera"; return; }
    const video = $('webcam-video'); const canvas = $('webcam-canvas');
    const stream = await navigator.mediaDevices.getUserMedia({ video: { width: 640, height: 360 }, audio: false });
    video.srcObject = stream; await video.play();
    camWs = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws/webcam`);
    camWs.onopen = () => camWs.send(JSON.stringify({ t: 'hello', device: { kind: 'browser-webcam', ua: navigator.userAgent.slice(0, 60) } }));
    let seq = 0;
    camTimer = setInterval(() => {
      if (!camWs || camWs.readyState !== 1 || camWs.bufferedAmount > 200_000) return;
      const w = 480, h = Math.round((480 * video.videoHeight) / (video.videoWidth || 640));
      canvas.width = w; canvas.height = h;
      canvas.getContext('2d').drawImage(video, 0, 0, w, h);
      canvas.toBlob(async (blob) => {
        const header = new TextEncoder().encode(JSON.stringify({ seq: seq++, ts: Date.now(), w, h }));
        const out = new Uint8Array(2 + header.length + blob.size);
        out[0] = header.length >> 8; out[1] = header.length & 255; out.set(header, 2); out.set(new Uint8Array(await blob.arrayBuffer()), 2 + header.length);
        camWs.send(out);
      }, 'image/jpeg', 0.6);
    }, 150);
    e.target.textContent = 'Stop this computer\'s camera';
  };

  connect();
})();
