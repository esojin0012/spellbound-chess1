/* Spellbound Chess client */
(() => {
  const $ = (id) => document.getElementById(id);
  const socket = io();
  const FILES = 'abcdefgh';
  const VAL = { p: 1, n: 3, b: 3, r: 5, q: 9, k: 0 };
  const MAX_HP = { p: 1, n: 3, b: 3, r: 3, q: 5, k: 3 };
  const getMaxHp = (p) => MAX_HP[p && p.t] || 3;
  function renderHpBarHtml(p) {
    if (!p || !(p.dmg > 0)) return '';
    const mHp = getMaxHp(p);
    const hpLeft = Math.max(0, mHp - p.dmg);
    const pips = Array.from({ length: mHp }, (_, i) => `<span class="hp-pip ${hpLeft >= i + 1 ? 'on' : ''}"></span>`).join('');
    return `<div class="hp-bar" title="${hpLeft}/${mHp} HP before capture">${pips}</div>`;
  }
  const opp = (c) => (c === 'w' ? 'b' : 'w');

  let token = sessionStorage.getItem('sbc_token');
  if (!token) {
    token = Math.random().toString(36).slice(2) + Date.now().toString(36);
    sessionStorage.setItem('sbc_token', token);
  }

  let S = null; // latest state from server
  let userFlip = false;
  let selected = null;
  let drag = null;
  let lastEffectsId = null;
  let lastShotgunId = null;
  let lastNoticeId = null;
  let lastFourDimUnmergeId = null;
  let eventHorizonPendingCut = false;
  let lastMoveCount = 0;
  let lastResultKey = null;
  let modalDismissed = false;
  let soundOn = localStorage.getItem('sbc_sound') !== 'off';
  let cardUI = { id: null, revealed: false, raf: 0 };
  let isShakingBoard = false;

  // ---------------- sound (loads custom files from public/sounds/<name>.mp3/.wav, falls back to synth) ----------------
  let actx = null;
  function tone(freq, dur, type = 'sine', vol = 0.15, delay = 0) {
    if (!soundOn) return;
    try {
      actx = actx || new (window.AudioContext || window.webkitAudioContext)();
      const t = actx.currentTime + delay;
      const o = actx.createOscillator();
      const g = actx.createGain();
      o.type = type;
      o.frequency.setValueAtTime(freq, t);
      g.gain.setValueAtTime(vol, t);
      g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
      o.connect(g).connect(actx.destination);
      o.start(t);
      o.stop(t + dur + 0.02);
    } catch { /* ignore */ }
  }
  function noise(dur, vol = 0.3) {
    if (!soundOn) return;
    try {
      actx = actx || new (window.AudioContext || window.webkitAudioContext)();
      const buf = actx.createBuffer(1, actx.sampleRate * dur, actx.sampleRate);
      const d = buf.getChannelData(0);
      for (let i = 0; i < d.length; i++) d[i] = (Math.random() * 2 - 1) * (1 - i / d.length) ** 2;
      const src = actx.createBufferSource();
      const g = actx.createGain();
      g.gain.value = vol;
      src.buffer = buf;
      src.connect(g).connect(actx.destination);
      src.start();
    } catch { /* ignore */ }
  }

  // If you drop a file like `public/sounds/move.mp3` (or `.wav` / `.ogg`), it plays your file automatically!
  const audioCache = {};
  const audioBuffers = {};
  let soundsReadyPromise = null;

  function ensureAudioContext() {
    try {
      actx = actx || new (window.AudioContext || window.webkitAudioContext)();
      if (actx.state === 'suspended') actx.resume().catch(() => {});
    } catch { /* ignore */ }
    return actx;
  }
  window.addEventListener('pointerdown', ensureAudioContext, { passive: true });
  window.addEventListener('keydown', ensureAudioContext, { passive: true });

  async function preloadAllSounds() {
    if (soundsReadyPromise) return soundsReadyPromise;
    soundsReadyPromise = (async () => {
      const preloadBox = $('soundPreloadBox');
      const preloadText = $('soundPreloadText');
      const preloadFill = $('soundPreloadFill');
      const createBtn = $('createBtn');
      const joinBtn = $('joinBtn');
      const quickMatchBtn = $('quickMatchBtn');

      let files = [];
      try {
        const res = await fetch('/api/sounds');
        const data = await res.json();
        if (Array.isArray(data.files)) files = data.files;
      } catch { /* ignore */ }

      const total = files.length;
      let loaded = 0;
      const updateProgress = () => {
        const pct = total === 0 ? 100 : Math.round((loaded / total) * 100);
        if (preloadText) preloadText.textContent = `🔊 Preloading sounds (${loaded}/${total})… ${pct}%`;
        if (preloadFill) preloadFill.style.width = `${pct}%`;
      };
      updateProgress();

      // Mark any SFX keys not present in public/sounds as false so they immediately use synth fallback without network delay
      const presentNames = new Set(files.map((f) => f.replace(/\.(mp3|wav|ogg)$/i, '')));
      Object.keys(SYNTH_SFX).forEach((k) => {
        if (!presentNames.has(k) && !(k === 'cardsIn' && presentNames.has('cardIn'))) {
          audioCache[k] = false;
        }
      });

      await Promise.all(
        files.map(async (file) => {
          const name = file.replace(/\.(mp3|wav|ogg)$/i, '');
          const url = `sounds/${file}`;
          try {
            const resp = await fetch(url);
            const arrayBuf = await resp.arrayBuffer();
            const blob = new Blob([arrayBuf], { type: resp.headers.get('content-type') || 'audio/mpeg' });
            const blobUrl = URL.createObjectURL(blob);

            const a = new Audio();
            a.preload = 'auto';
            a.src = blobUrl;
            await new Promise((resolve) => {
              const done = () => resolve();
              a.addEventListener('canplaythrough', done, { once: true });
              a.addEventListener('loadeddata', done, { once: true });
              a.addEventListener('error', done, { once: true });
              setTimeout(done, 4000);
              a.load();
            });
            audioCache[name] = a;
            if (name === 'cardIn') audioCache.cardsIn = a;

            // For short SFX (< 1 MB), also pre-decode into Web Audio API AudioBuffer for 0ms latency playback!
            if (arrayBuf.byteLength < 1000000) {
              try {
                const ctx = ensureAudioContext();
                if (ctx) {
                  const decoded = await ctx.decodeAudioData(arrayBuf.slice(0));
                  audioBuffers[name] = decoded;
                  if (name === 'cardIn') audioBuffers.cardsIn = decoded;
                }
              } catch { /* ignore */ }
            }
          } catch {
            audioCache[name] = false;
          } finally {
            loaded++;
            updateProgress();
          }
        })
      );

      if (preloadText) preloadText.textContent = `✅ All ${total} sounds ready!`;
      if (preloadFill) preloadFill.style.width = '100%';
      setTimeout(() => {
        if (preloadBox) preloadBox.classList.add('hidden');
      }, 600);
      if (createBtn) {
        createBtn.disabled = false;
        createBtn.textContent = '♟ Create Room';
      }
      if (joinBtn) {
        joinBtn.disabled = false;
      }
      if (quickMatchBtn) {
        quickMatchBtn.disabled = false;
      }
    })();
    return soundsReadyPromise;
  }

  function playCustomOrFallback(name, fallbackFn) {
    if (!soundOn) return;
    if (audioBuffers[name]) {
      try {
        const ctx = ensureAudioContext();
        if (ctx) {
          if (ctx.state === 'suspended') ctx.resume().catch(() => {});
          const src = ctx.createBufferSource();
          const gain = ctx.createGain();
          src.buffer = audioBuffers[name];
          gain.gain.value = 0.8;
          src.connect(gain).connect(ctx.destination);
          src.start(0);
          return;
        }
      } catch { /* fall through to HTMLAudioElement */ }
    }
    if (audioCache[name] === false) return fallbackFn();
    if (audioCache[name]) {
      const clone = audioCache[name].cloneNode();
      clone.volume = 0.8;
      clone.play().catch(() => {});
      return;
    }
    const exts = ['mp3', 'wav', 'ogg'];
    const tryExt = (i) => {
      if (i >= exts.length) {
        audioCache[name] = false;
        fallbackFn();
        return;
      }
      const a = new Audio(`sounds/${name}.${exts[i]}`);
      a.addEventListener(
        'canplaythrough',
        () => {
          audioCache[name] = a;
          a.volume = 0.8;
          a.play().catch(() => {});
        },
        { once: true }
      );
      a.addEventListener('error', () => tryExt(i + 1), { once: true });
      a.load();
    };
    tryExt(0);
  }

  const SYNTH_SFX = {
    move: () => { tone(520, 0.07, 'triangle', 0.2); tone(260, 0.06, 'sine', 0.12, 0.01); },
    capture: () => { tone(330, 0.09, 'square', 0.1); tone(180, 0.12, 'triangle', 0.2, 0.03); },
    check: () => { tone(880, 0.12, 'square', 0.08); tone(660, 0.15, 'square', 0.08, 0.1); },
    castle: () => { SYNTH_SFX.move(); setTimeout(SYNTH_SFX.move, 110); },
    boom: () => { noise(0.6, 0.5); tone(80, 0.5, 'sawtooth', 0.15); },
    cardsIn: () => [523, 659, 784, 1047].forEach((f, i) => tone(f, 0.25, 'sine', 0.1, i * 0.07)),
    pick: () => { tone(988, 0.12, 'triangle', 0.15); tone(1319, 0.2, 'triangle', 0.12, 0.08); },
    magic: () => [784, 988, 1175, 1568, 1976].forEach((f, i) => tone(f, 0.3, 'sine', 0.07, i * 0.05)),
    legendary: () => [392, 523, 659, 784, 1047, 1319].forEach((f, i) => tone(f, 0.5, 'sawtooth', 0.05, i * 0.08)),
    win: () => [523, 659, 784, 1047].forEach((f, i) => tone(f, 0.35, 'triangle', 0.15, i * 0.12)),
    lose: () => [392, 330, 262].forEach((f, i) => tone(f, 0.4, 'triangle', 0.15, i * 0.15)),
    tick: () => tone(1200, 0.04, 'square', 0.05),
    charge: () => {
      for (let i = 0; i < 8; i++) tone(260 + i * 70, 0.09, 'sawtooth', 0.04 + i * 0.01, i * 0.11);
    },
    dash: () => {
      noise(0.18, 0.25);
      tone(680, 0.16, 'triangle', 0.18);
      tone(320, 0.18, 'sine', 0.15, 0.04);
    },
    slam: () => {
      noise(0.35, 0.45);
      tone(95, 0.4, 'sawtooth', 0.22);
      tone(58, 0.55, 'sine', 0.28);
    },
    thunder: () => {
      noise(1.1, 0.65);
      tone(140, 0.45, 'sawtooth', 0.25);
      tone(62, 0.95, 'sawtooth', 0.28, 0.06);
      tone(44, 1.4, 'sine', 0.3, 0.15);
    },
    slice: () => {
      noise(0.22, 0.55);
      tone(1400, 0.12, 'sawtooth', 0.25);
      tone(420, 0.22, 'triangle', 0.22, 0.04);
    },
    shot: () => {
      noise(0.45, 0.75);
      tone(110, 0.32, 'sawtooth', 0.35);
      tone(55, 0.48, 'sine', 0.4, 0.02);
    },
    shotgun_reload: () => {
      noise(0.08, 0.35);
      tone(420, 0.07, 'square', 0.18);
      setTimeout(() => {
        noise(0.09, 0.4);
        tone(580, 0.08, 'square', 0.22);
      }, 170);
    },
    shotgun_shoot: () => {
      noise(0.45, 0.75);
      tone(110, 0.32, 'sawtooth', 0.35);
      tone(55, 0.48, 'sine', 0.4, 0.02);
    },
  };
  const SFX = Object.fromEntries(
    Object.entries(SYNTH_SFX).map(([k, fn]) => [k, () => playCustomOrFallback(k, fn)])
  );

  // ---------------- Last King Standing Music (lms.mp3 -> lms_loop.mp3) + Music-Reactive Board Shake ----------------
  const LMS = {
    active: false,
    audio: null,
    analyser: null,
    dataArr: null,
    raf: 0,
    synthTimer: null,
    start() {
      if (this.active) return;
      this.active = true;
      try {
        actx = actx || new (window.AudioContext || window.webkitAudioContext)();
        if (actx.state === 'suspended') actx.resume().catch(() => {});
        this.analyser = actx.createAnalyser();
        this.analyser.fftSize = 256;
        this.dataArr = new Uint8Array(this.analyser.frequencyBinCount);
        this.analyser.connect(actx.destination);
      } catch { /* ignore */ }

      this.playIntro();
      this.loopShake();
    },
    connectTrack(srcUrl, loop, onEnded, onError) {
      if (this.audio) {
        this.audio.pause();
        this.audio = null;
      }
      const key = srcUrl.replace(/^sounds\//, '').replace(/\.(mp3|wav|ogg)$/i, '');
      const cachedSrc = audioCache[key] && audioCache[key].src ? audioCache[key].src : srcUrl;
      const a = new Audio(cachedSrc);
      a.loop = !!loop;
      a.volume = soundOn ? 0.75 : 0;
      this.audio = a;
      try {
        if (actx && this.analyser) {
          const mediaSrc = actx.createMediaElementSource(a);
          mediaSrc.connect(this.analyser);
        }
      } catch { /* ignore */ }
      if (onEnded) a.addEventListener('ended', onEnded, { once: true });
      if (onError) a.addEventListener('error', onError, { once: true });
      a.play().catch(() => {});
    },
    playIntro() {
      if (!this.active) return;
      this.connectTrack(
        'sounds/lms.mp3',
        false,
        () => {
          if (this.active) this.playLoop();
        },
        () => {
          // If lms.mp3 is missing, try lms_loop.mp3 directly, or fall back to synth pulse
          if (this.active) this.playLoop();
        }
      );
    },
    playLoop() {
      if (!this.active) return;
      this.connectTrack('sounds/lms_loop.mp3', true, null, () => {
        if (this.active) this.startSynthFallback();
      });
    },
    startSynthFallback() {
      clearInterval(this.synthTimer);
      let step = 0;
      const notes = [65.4, 65.4, 77.8, 65.4, 87.3, 82.4, 65.4, 58.3];
      this.synthTimer = setInterval(() => {
        if (!this.active || !soundOn || !actx || !this.analyser) return;
        try {
          const t = actx.currentTime;
          const o = actx.createOscillator();
          const g = actx.createGain();
          o.type = 'sawtooth';
          o.frequency.setValueAtTime(notes[step % notes.length], t);
          g.gain.setValueAtTime(0.14, t);
          g.gain.exponentialRampToValueAtTime(0.001, t + 0.22);
          o.connect(g).connect(this.analyser);
          o.start(t);
          o.stop(t + 0.24);
          step++;
        } catch { /* ignore */ }
      }, 260);
    },
    loopShake() {
      if (!this.active) return;
      const bw = $('boardWrap');
      if (bw && !isShakingBoard && soundOn && this.analyser && this.dataArr) {
        this.analyser.getByteTimeDomainData(this.dataArr);
        let sum = 0;
        for (let i = 0; i < this.dataArr.length; i++) {
          const v = (this.dataArr[i] - 128) / 128;
          sum += v * v;
        }
        const rms = Math.sqrt(sum / this.dataArr.length);
        // Subtle shake scaled to music volume (so little but can still be noticed)
        const amp = Math.min(2.8, rms * 11);
        if (amp > 0.18) {
          const dx = (Math.random() * 2 - 1) * amp;
          const dy = (Math.random() * 2 - 1) * amp;
          const rot = (Math.random() * 2 - 1) * (amp * 0.12);
          bw.style.transform = `translate(${dx.toFixed(2)}px, ${dy.toFixed(2)}px) rotate(${rot.toFixed(2)}deg)`;
        } else {
          bw.style.transform = '';
        }
      }
      this.raf = requestAnimationFrame(() => this.loopShake());
    },
    syncVolume() {
      if (this.audio) this.audio.volume = soundOn ? 0.75 : 0;
    },
    stop() {
      if (!this.active) return;
      this.active = false;
      cancelAnimationFrame(this.raf);
      clearInterval(this.synthTimer);
      this.synthTimer = null;
      if (this.audio) {
        this.audio.pause();
        this.audio = null;
      }
      const bw = $('boardWrap');
      if (bw && !isShakingBoard) bw.style.transform = '';
    },
  };

  // ---------------- lobby ----------------
  $('nameInput').value = localStorage.getItem('sbc_name') || '';
  $('cardIntervalInput').value = localStorage.getItem('sbc_interval') || '5';
  const params = new URLSearchParams(location.search);
  if (params.get('room')) $('codeInput').value = params.get('room').toUpperCase();

  const RARITY_PRESETS = {
    default: { common: 60, rare: 40, epic: 20, legendary: 10, event: 1, label: 'Default' },
    chaos: { common: 20, rare: 20, epic: 20, legendary: 20, event: 20, label: 'Chaos' },
    superop: { common: 0, rare: 0, epic: 0, legendary: 100, event: 0, label: '100% Legendary' },
    allevent: { common: 0, rare: 0, epic: 0, legendary: 0, event: 100, label: '100% Event' },
  };

  function getRarityWeights() {
    const c = Math.max(0, parseInt($('rwCommon').value, 10) || 0);
    const r = Math.max(0, parseInt($('rwRare').value, 10) || 0);
    const e = Math.max(0, parseInt($('rwEpic').value, 10) || 0);
    const l = Math.max(0, parseInt($('rwLegendary').value, 10) || 0);
    const v = Math.max(0, parseInt($('rwEvent').value, 10) || 0);
    if (c + r + e + l + v === 0) return { common: 60, rare: 40, epic: 20, legendary: 10, event: 1 };
    return { common: c, rare: r, epic: e, legendary: l, event: v };
  }

  function updateRarityUI() {
    let c = Math.max(0, parseInt($('rwCommon').value, 10) || 0);
    let r = Math.max(0, parseInt($('rwRare').value, 10) || 0);
    let e = Math.max(0, parseInt($('rwEpic').value, 10) || 0);
    let l = Math.max(0, parseInt($('rwLegendary').value, 10) || 0);
    let v = Math.max(0, parseInt($('rwEvent').value, 10) || 0);
    let sum = c + r + e + l + v;
    if (sum === 0) {
      c = 60; r = 40; e = 20; l = 10; v = 1; sum = 131;
    }
    const pct = (val) => Math.round((val / sum) * 100) + '%';
    $('rwCommonVal').textContent = pct(c);
    $('rwRareVal').textContent = pct(r);
    $('rwEpicVal').textContent = pct(e);
    $('rwLegendaryVal').textContent = pct(l);
    $('rwEventVal').textContent = pct(v);

    const badge = $('raritySummaryBadge');
    if (badge) {
      if (c === 60 && r === 40 && e === 20 && l === 10 && v === 1) badge.textContent = 'Default';
      else if (l > 0 && c === 0 && r === 0 && e === 0 && v === 0) badge.textContent = '👑 100% Legendary';
      else if (v > 0 && c === 0 && r === 0 && e === 0 && l === 0) badge.textContent = '🌀 100% Event';
      else badge.textContent = `${pct(c)}/${pct(r)}/${pct(e)}/${pct(l)}/${pct(v)}`;
    }
    localStorage.setItem('sbc_rarity', JSON.stringify({ common: c, rare: r, epic: e, legendary: l, event: v }));
  }

  try {
    const savedRw = JSON.parse(localStorage.getItem('sbc_rarity') || 'null');
    if (savedRw && typeof savedRw === 'object') {
      if (savedRw.common != null) $('rwCommon').value = savedRw.common;
      if (savedRw.rare != null) $('rwRare').value = savedRw.rare;
      if (savedRw.epic != null) $('rwEpic').value = savedRw.epic;
      if (savedRw.legendary != null) $('rwLegendary').value = savedRw.legendary;
      if (savedRw.event != null) $('rwEvent').value = savedRw.event;
    }
  } catch { /* ignore */ }
  ['rwCommon', 'rwRare', 'rwEpic', 'rwLegendary', 'rwEvent'].forEach((id) => {
    const el = $(id);
    if (el) el.addEventListener('input', updateRarityUI);
  });
  document.querySelectorAll('.preset-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      const p = RARITY_PRESETS[btn.dataset.preset];
      if (!p) return;
      $('rwCommon').value = p.common;
      $('rwRare').value = p.rare;
      $('rwEpic').value = p.epic;
      $('rwLegendary').value = p.legendary;
      $('rwEvent').value = p.event;
      updateRarityUI();
    });
  });
  updateRarityUI();

  function getName() {
    const n = $('nameInput').value.trim() || 'Player' + Math.floor(Math.random() * 900 + 100);
    localStorage.setItem('sbc_name', n);
    return n;
  }
  function getCardInterval() {
    const cardInterval = Math.min(20, Math.max(1, parseInt($('cardIntervalInput').value, 10) || 5));
    $('cardIntervalInput').value = cardInterval;
    localStorage.setItem('sbc_interval', String(cardInterval));
    return cardInterval;
  }
  $('createBtn').onclick = async () => {
    await preloadAllSounds();
    $('lobbyError').textContent = '';
    $('quickMatchBox').classList.add('hidden');
    socket.emit('create', {
      name: getName(),
      token,
      cardInterval: getCardInterval(),
      rarityWeights: getRarityWeights(),
    });
  };
  $('quickMatchBtn').onclick = async () => {
    await preloadAllSounds();
    $('lobbyError').textContent = '';
    socket.emit('quickMatch', {
      name: getName(),
      token,
      cardInterval: getCardInterval(),
      rarityWeights: getRarityWeights(),
    });
  };
  $('cancelQmBtn').onclick = () => {
    socket.emit('cancelQuickMatch');
    $('quickMatchBox').classList.add('hidden');
    $('quickMatchBtn').disabled = false;
  };
  socket.on('quickMatchStatus', ({ waiting } = {}) => {
    $('quickMatchBox').classList.toggle('hidden', !waiting);
    $('quickMatchBtn').disabled = !!waiting;
  });
  async function join() {
    await preloadAllSounds();
    const code = $('codeInput').value.trim().toUpperCase();
    if (code.length < 6) return ($('lobbyError').textContent = 'Enter a 6-character Room ID.');
    $('lobbyError').textContent = '';
    $('quickMatchBox').classList.add('hidden');
    socket.emit('join', { code, name: getName(), token });
  }
  $('joinBtn').onclick = join;
  $('codeInput').addEventListener('keydown', (e) => e.key === 'Enter' && join());
  $('codeInput').addEventListener('input', (e) => (e.target.value = e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, '')));

  preloadAllSounds();

  socket.on('connect', async () => {
    await preloadAllSounds();
    const code = sessionStorage.getItem('sbc_room');
    if (code) socket.emit('join', { code, name: localStorage.getItem('sbc_name') || 'Player', token });
  });
  socket.on('errorMsg', (msg) => {
    $('lobbyError').textContent = msg;
    if (!S || msg.includes('not found')) {
      sessionStorage.removeItem('sbc_room');
      showLobby();
    }
  });

  function showLobby() {
    LMS.stop();
    S = null;
    $('quickMatchBox').classList.add('hidden');
    if ($('quickMatchBtn')) $('quickMatchBtn').disabled = false;
    $('game').classList.add('hidden');
    $('lobby').classList.remove('hidden');
    $('cardOverlay').classList.add('hidden');
    $('modal').classList.add('hidden');
  }

  let displayBoard = null; // temporary board override during card choreography
  let isAnimatingCards = false;
  let currentEffectFourDim = false;
  let currentEffectEventHorizon = 0;
  let pendingSlide = null; // {from, to} for normal move slide

  // ---------------- state handling ----------------
  socket.on('state', (s) => {
    const prev = S;
    const newGame = !prev || prev.code !== s.code || (prev.phase === 'over' && s.phase !== 'over');
    // Detect opponent normal move so we can slide their piece cleanly with expo-out
    if (
      prev &&
      !newGame &&
      !isAnimatingCards &&
      s.moves.length === prev.moves.length + 1 &&
      s.lastMove &&
      (!prev.lastMove || prev.lastMove.from !== s.lastMove.from || prev.lastMove.to !== s.lastMove.to) &&
      (!s.effects || s.effects.id === lastEffectsId) &&
      (!s.shotgunFire || s.shotgunFire.id === lastShotgunId) &&
      (!s.fourDimUnmerge || s.fourDimUnmerge.id === lastFourDimUnmergeId)
    ) {
      pendingSlide = { from: s.lastMove.from, to: s.lastMove.to };
    }
    S = s;
    sessionStorage.setItem('sbc_room', s.code);
    $('lobby').classList.add('hidden');
    $('game').classList.remove('hidden');
    if (newGame) {
      lastMoveCount = s.moves.length;
      lastEffectsId = s.effects ? s.effects.id : null;
      lastShotgunId = s.shotgunFire ? s.shotgunFire.id : null;
      lastFourDimUnmergeId = s.fourDimUnmerge ? s.fourDimUnmerge.id : null;
      eventHorizonPendingCut = false;
      currentEffectFourDim = false;
      currentEffectEventHorizon = 0;
      lastNoticeId = prev && prev.code === s.code ? lastNoticeId : null;
      lastResultKey = null;
      modalDismissed = false;
      selected = null;
      displayBoard = null;
      isAnimatingCards = false;
      if (prev && prev.code === s.code) { $('modal').classList.add('hidden'); }
    }
    if (prev && prev.you !== s.you) userFlip = false;
    if (s.legal.length === 0) selected = null;

    if (s.lmsActive) LMS.start();

    playMoveSounds(s);
    handleCards(s);
    const animStarted = handleShotgun(s) || handleEffects(s) || handleFourDimUnmerge(s);
    if (!animStarted) {
      if (!s.lmsActive) LMS.stop();
      render();
      if (pendingSlide) {
        slidePieceOnBoard(pendingSlide.from, pendingSlide.to, 260);
        pendingSlide = null;
      }
      handleGameOver(s);
    }
    handleNotice(s);
  });

  function playMoveSounds(s) {
    if (s.moves.length > lastMoveCount) {
      const m = s.moves[s.moves.length - 1];
      if (m.shotgun) {
        // Shotgun move + reload + shoot sounds are handled by handleShotgun()
        SFX.move();
      } else if (m.exploded) {
        SFX.boom();
        shakeElement($('boardWrap'), 900, 14, 'hard-to-soft');
      } else if (m.check) {
        SFX.check();
        shakeElement($('boardWrap'), 450, 7, 'hard-to-soft');
      } else if (m.capture) {
        SFX.capture();
        shakeElement($('boardWrap'), 280, 5, 'hard-to-soft');
      } else if (m.castle) SFX.castle();
      else if (!m.skipped) SFX.move();
    }
    lastMoveCount = s.moves.length;
  }

  const flipped = () => (S && S.you === 'b') !== userFlip;

  // ---------------- rendering ----------------
  function pieceSrc(p) {
    return `pieces/${p.c}${p.t.toUpperCase()}${p.t === 'k' && p.pink ? '_pink.svg?v=3' : '.svg'}`;
  }

  function render() {
    if (!S) return;
    renderBoard();
    renderBars();
    renderSide();
    $('waitOverlay').classList.toggle('hidden', S.phase !== 'waiting');
    $('waitCode').textContent = S.code;
    $('fogBanner').classList.toggle('hidden', !S.fogged);
  }

  function targetsOf(sq) {
    if (isAnimatingCards) return [];
    return S.legal.filter((m) => m.from === sq);
  }

  let isAnimatingEventHorizon = false;
  let isAnimatingFourDim = false;

  function renderPieceImgsHtml(p) {
    const layers = Array.isArray(p.layers) && p.layers.length > 1 ? p.layers : [p.t];
    return layers
      .map((lt, idx) => {
        const fakeP = { ...p, t: lt };
        const off = layers.length > 1 ? (idx - (layers.length - 1) / 2) * 4 : 0;
        const style = off ? ` style="transform: translate(${off.toFixed(1)}px, ${(-off).toFixed(1)}px)"` : '';
        return `<img class="layer-img" src="${pieceSrc(fakeP)}" alt="" draggable="false"${style}>`;
      })
      .join('');
  }

  function renderLayerBadgeHtml(p) {
    if (!Array.isArray(p.layers) || p.layers.length <= 1) return '';
    return `<span class="layer-badge" title="Merged 4D Piece: ${p.layers.map((t) => t.toUpperCase()).join(' + ')}">${p.layers
      .map((t) => t.toUpperCase())
      .join('+')}</span>`;
  }

  function syncEventHorizonBarrier() {
    const wrap = $('boardWrap');
    const layer = $('vfxLayer');
    if (isAnimatingEventHorizon || eventHorizonPendingCut) {
      if (wrap) wrap.classList.remove('eh-active');
      const bar = layer ? layer.querySelector('.eh-barrier') : null;
      if (bar) bar.remove();
      return;
    }
    const turns = isAnimatingCards
      ? currentEffectEventHorizon
      : (S && S.status && S.status.eventHorizon ? S.status.eventHorizon : 0);
    if (wrap) wrap.classList.toggle('eh-active', turns > 0);
    if (!layer) return;
    let bar = layer.querySelector('.eh-barrier');
    if (turns > 0) {
      if (!bar) {
        bar = document.createElement('div');
        bar.className = 'eh-barrier';
        layer.appendChild(bar);
      }
      bar.innerHTML = `
        <div class="eh-space-bg"></div>
        <div class="eh-glitch-layer"></div>
        <span class="eh-turns" title="Event Horizon: ${turns} turn${turns === 1 ? '' : 's'} remaining">${turns}</span>
      `;
    } else if (bar) {
      bar.remove();
    }
  }

  function renderBoard(boardOverride, forceFull8x8) {
    const bArr = boardOverride || displayBoard || S.board;
    const board = $('board');
    const wrap = $('boardWrap');
    board.innerHTML = '';
    const fl = flipped();
    const activeFourDim = isAnimatingCards ? currentEffectFourDim : !!(S && S.status && S.status.fourDim);
    const fourDim = !forceFull8x8 && !isAnimatingFourDim && activeFourDim;
    board.classList.toggle('four-dim-grid', fourDim);
    if (wrap) wrap.classList.toggle('four-dim-active', fourDim);
    const targets = selected != null ? targetsOf(selected).map((m) => m.to) : [];
    const dim = fourDim ? 4 : 8;
    const offset = fourDim ? 2 : 0;
    const totalCells = dim * dim;
    for (let i = 0; i < totalCells; i++) {
      const gr = Math.floor(i / dim);
      const gc = i % dim;
      const r = (fl ? gr : dim - 1 - gr) + offset;
      const f = (fl ? dim - 1 - gc : gc) + offset;
      const sq = r * 8 + f;
      const el = document.createElement('div');
      el.className = 'sq ' + ((r + f) % 2 === 0 ? 'dark' : 'light') + (gr < dim / 2 ? ' eh-top' : ' eh-bot');
      el.dataset.sq = sq;
      if (!isAnimatingCards && S.lastMove && (S.lastMove.from === sq || S.lastMove.to === sq)) el.classList.add('hl');
      if (selected === sq) el.classList.add('sel');
      if (!isAnimatingCards && S.checkSq === sq) el.classList.add('check');
      if (gc === 0) el.insertAdjacentHTML('beforeend', `<span class="coord rank">${r + 1}</span>`);
      if (gr === dim - 1) el.insertAdjacentHTML('beforeend', `<span class="coord file">${FILES[f]}</span>`);
      if (S.mines.includes(sq)) el.insertAdjacentHTML('beforeend', '<span class="mine">💣</span>');
      const p = bArr[sq];
      if (p) {
        const pe = document.createElement('div');
        pe.className = 'piece';
        if (p.frozen) pe.classList.add('frozen');
        if (p.shield) pe.classList.add('shield');
        if (p.pink) pe.classList.add('pink');
        if (p.shotgun) pe.classList.add('shotgun');
        if (p.t === 'k' && p.shotgun && S.lmsActive && S.lmsColor === p.c) pe.classList.add('lms-king');
        if (drag && drag.from === sq) pe.classList.add('dragging');
        let extraHtml = '';
        if (p.shotgun) extraHtml += '<span class="sg-badge" title="King with a Shotgun">🔫</span>';
        extraHtml += renderLayerBadgeHtml(p);
        extraHtml += renderHpBarHtml(p);
        pe.innerHTML = `${renderPieceImgsHtml(p)}${extraHtml}`;
        el.appendChild(pe);
      }
      if (targets.includes(sq)) {
        el.insertAdjacentHTML('beforeend', p ? '<span class="ring"></span>' : '<span class="dot"></span>');
      }
      board.appendChild(el);
    }
    syncEventHorizonBarrier();
  }

  function renderBars() {
    const bottom = flipped() ? 'b' : 'w';
    renderBar($('bottomBar'), bottom);
    renderBar($('topBar'), opp(bottom));
  }

  function material(c) {
    let m = 0;
    for (const p of S.board) if (p && p.c === c) m += VAL[p.t];
    return m;
  }

  function renderBar(el, c) {
    el.dataset.color = c;
    const info = S.players[c];
    const isYou = S.you === c;
    const captured = (S.lost[opp(c)] || []).filter((t) => t !== 'k').slice().sort((a, b) => VAL[a] - VAL[b]);
    const diff = S.fogged ? 0 : material(c) - material(opp(c));
    const tags = [];
    if (isYou) tags.push('<span class="tag">You</span>');
    if (info && !info.connected) tags.push('<span class="tag off">disconnected</span>');
    if (S.status.extra[c]) tags.push('<span class="tag buff">⏩ Double move</span>');
    if (S.status.skip[c]) tags.push('<span class="tag buff">⏸️ Skips next turn</span>');
    if (S.status.fog[c]) tags.push('<span class="tag buff">🌫️ Hidden</span>');
    if (S.status.nextCardPicks && S.status.nextCardPicks[c] > 1) {
      tags.push(`<span class="tag buff">🃏 Pick ${S.status.nextCardPicks[c]} cards next</span>`);
    }
    const kingPiece = S.board.find((p) => p && p.c === c && p.t === 'k');
    if (kingPiece && kingPiece.shotgun) {
      const isLMS = S.lmsActive && S.lmsColor === c;
      tags.push(`<span class="tag buff">${isLMS ? '🔥🔫 LAST KING STANDING' : '🔫 Shotgun (Last Piece)'}</span>`);
    }
    const active = S.phase === 'play' && S.turn === c;
    const avatarSrc = kingPiece && kingPiece.pink ? `pieces/${c}K_pink.svg?v=3` : `pieces/${c}K.svg`;
    el.classList.toggle('active', active);
    el.innerHTML = `
      <div class="avatar"><img src="${avatarSrc}" alt=""></div>
      <div class="pinfo">
        <div class="pname">${info ? esc(info.name) : '<span class="muted">Waiting…</span>'} ${tags.join('')}</div>
        <div class="captured">${captured.map((t) => `<img src="pieces/${opp(c)}${t.toUpperCase()}.svg" alt="">`).join('')}
          ${diff > 0 ? `<span class="adv">+${diff}</span>` : ''}</div>
      </div>
      <div class="turn-flag">${active ? (isYou ? 'YOUR MOVE' : 'THINKING…') : c === 'w' ? 'WHITE' : 'BLACK'}</div>`;
  }

  function renderSide() {
    $('roomCode').textContent = S.code;
    let status;
    if (S.phase === 'waiting') status = '⏳ Waiting for opponent';
    else if (S.phase === 'cards' || S.phase === 'reveal') status = '🃏 Card selection!';
    else if (isAnimatingCards) status = '⚡ Action in progress…';
    else if (S.phase === 'over') status = resultText(S.result).title;
    else status = S.turn === S.you ? '🟢 Your turn' : "⚪ Opponent's turn";
    $('turnStatus').textContent = status;

    const total = S.cardInterval || 5;
    const left = S.fullMovesUntilCards;
    if (total <= 10) {
      $('pips').innerHTML = Array.from({ length: total }, (_, i) => `<div class="pip ${i < total - left ? 'on' : ''}"></div>`).join('');
    } else {
      $('pips').innerHTML = '';
    }
    $('cardTurns').textContent = `${left} / ${total} turn${total === 1 ? '' : 's'}`;

    // move list
    const rows = [];
    let n = 0;
    S.moves.forEach((m, idx) => {
      const cls = `mv ${idx === S.moves.length - 1 ? 'last' : ''} ${m.exploded ? 'boom' : ''}`;
      const txt = esc(m.san) + (m.exploded ? '💥' : '');
      const last = rows[rows.length - 1];
      if (m.color === 'w' || !last || last.b) {
        n++;
        rows.push({ n, w: m.color === 'w' ? `<span class="${cls}">${txt}</span>` : '…', b: m.color === 'b' ? `<span class="${cls}">${txt}</span>` : '' });
      } else last.b = `<span class="${cls}">${txt}</span>`;
    });
    const ml = $('moveList');
    const atBottom = ml.scrollTop + ml.clientHeight >= ml.scrollHeight - 30;
    ml.innerHTML = rows.map((r) => `<div class="move-row"><span class="num">${r.n}.</span><span>${r.w}</span><span>${r.b}</span></div>`).join('');
    if (atBottom) ml.scrollTop = ml.scrollHeight;

    // draw offer
    const db = $('drawBox');
    if (S.phase !== 'over' && S.drawOffer === opp(S.you)) {
      db.classList.remove('hidden');
      db.innerHTML = `<span style="flex:1">½ Opponent offers a draw</span>
        <button class="btn btn-green" id="acceptDraw">Accept</button><button class="btn btn-gray" id="declineDraw">Decline</button>`;
      $('acceptDraw').onclick = () => socket.emit('respondDraw', true);
      $('declineDraw').onclick = () => socket.emit('respondDraw', false);
    } else if (S.phase !== 'over' && S.drawOffer === S.you) {
      db.classList.remove('hidden');
      db.innerHTML = '<span>½ Draw offered… waiting for opponent</span>';
    } else db.classList.add('hidden');

    const playing = S.phase !== 'over' && S.phase !== 'waiting';
    $('drawBtn').disabled = !playing || S.drawOffer === S.you;
    $('resignBtn').disabled = !playing;
    $('claimBtn').classList.toggle('hidden', !S.canClaim);
    $('rematchBtn').classList.toggle('hidden', S.phase !== 'over');
    $('rematchBtn').textContent = S.rematch[S.you] ? '⏳ Rematch requested' : S.rematch[opp(S.you)] ? '↻ Accept rematch' : '↻ Rematch';
    $('soundBtn').textContent = soundOn ? '🔊' : '🔇';

    // chat
    const log = $('chatLog');
    log.innerHTML = S.chat.map((m) => `<div><b class="${m.color === S.you ? '' : 'opp'}">${esc(m.name)}:</b> ${esc(m.text)}</div>`).join('');
    log.scrollTop = log.scrollHeight;
  }

  function esc(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  // ---------------- input: click + drag ----------------
  const boardEl = $('board');
  function sqFromPoint(x, y) {
    const el = document.elementFromPoint(x, y);
    const sqEl = el && el.closest && el.closest('.sq');
    return sqEl ? Number(sqEl.dataset.sq) : null;
  }
  function canMoveFrom(sq) {
    return S && S.phase === 'play' && S.turn === S.you && targetsOf(sq).length > 0;
  }

  boardEl.addEventListener('pointerdown', (e) => {
    if (!S || e.button > 0) return;
    hidePromo();
    const sq = sqFromPoint(e.clientX, e.clientY);
    if (sq == null) return;
    if (selected != null && targetsOf(selected).some((m) => m.to === sq)) {
      tryMove(selected, sq);
      return;
    }
    if (canMoveFrom(sq)) {
      selected = sq;
      const sqEl = boardEl.querySelector(`[data-sq="${sq}"]`);
      const size = sqEl.getBoundingClientRect().width;
      const ghost = document.createElement('div');
      ghost.className = 'ghost' + (S.status && S.status.fourDim ? ' four-dim-ghost' : '');
      ghost.style.width = ghost.style.height = size + 'px';
      ghost.innerHTML = renderPieceImgsHtml(S.board[sq]);
      ghost.style.left = e.clientX + 'px';
      ghost.style.top = e.clientY + 'px';
      document.body.appendChild(ghost);
      drag = { from: sq, ghost, hover: null };
      boardEl.setPointerCapture(e.pointerId);
      renderBoard();
    } else {
      selected = null;
      renderBoard();
    }
  });
  boardEl.addEventListener('pointermove', (e) => {
    if (!drag) return;
    drag.ghost.style.left = e.clientX + 'px';
    drag.ghost.style.top = e.clientY + 'px';
    const sq = sqFromPoint(e.clientX, e.clientY);
    if (sq !== drag.hover) {
      boardEl.querySelectorAll('.sq.hover').forEach((x) => x.classList.remove('hover'));
      if (sq != null) boardEl.querySelector(`[data-sq="${sq}"]`).classList.add('hover');
      drag.hover = sq;
    }
  });
  function endDrag(e, cancel) {
    if (!drag) return;
    const d = drag;
    drag = null;
    d.ghost.remove();
    const sq = cancel ? null : sqFromPoint(e.clientX, e.clientY);
    if (sq != null && sq !== d.from && targetsOf(d.from).some((m) => m.to === sq)) tryMove(d.from, sq);
    else renderBoard();
  }
  boardEl.addEventListener('pointerup', (e) => endDrag(e, false));
  boardEl.addEventListener('pointercancel', (e) => endDrag(e, true));

  function tryMove(from, to) {
    const ms = S.legal.filter((m) => m.from === from && m.to === to);
    if (!ms.length) return;
    if (ms.some((m) => m.promo)) return showPromo(from, to);
    sendMove(from, to, null);
  }
  function sendMove(from, to, promo) {
    socket.emit('move', { from, to, promo });
    // If we are in Last King Standing shotgun mode, let handleShotgun() run the full Move -> Reload -> Aim -> Shoot choreography!
    if (S.lmsActive && S.lmsColor === S.you) {
      S.legal = [];
      selected = null;
      renderBoard();
      return;
    }
    // optimistic display with smooth expo-out slide
    S.board[to] = S.board[from];
    if (promo) S.board[to] = { ...S.board[to], t: promo };
    S.board[from] = null;
    S.lastMove = { from, to };
    S.legal = [];
    S.checkSq = null;
    selected = null;
    renderBoard();
    slidePieceOnBoard(from, to, 240);
  }

  function showPromo(from, to) {
    const pr = $('promo');
    const c = S.you;
    const fl = flipped();
    const f = to & 7;
    const r = to >> 3;
    const colIdx = fl ? 7 - f : f;
    const rowIdx = fl ? r : 7 - r;
    const bs = $('boardWrap').clientWidth / 8;
    pr.style.left = colIdx * bs + 'px';
    const fromTop = rowIdx === 0;
    pr.style.top = fromTop ? '0px' : 'auto';
    pr.style.bottom = fromTop ? 'auto' : '0px';
    const order = fromTop ? ['q', 'n', 'r', 'b'] : ['b', 'r', 'n', 'q'];
    pr.innerHTML = order.map((t) => `<button data-t="${t}"><img src="pieces/${c}${t.toUpperCase()}.svg" alt=""></button>`).join('');
    pr.classList.remove('hidden');
    pr.querySelectorAll('button').forEach((b) => {
      b.onpointerdown = (e) => {
        e.stopPropagation();
        hidePromo();
        sendMove(from, to, b.dataset.t);
      };
    });
  }
  function hidePromo() {
    $('promo').classList.add('hidden');
  }

  // ---------------- cards ----------------
  function normalizePicked(picked) {
    if (Array.isArray(picked)) return picked;
    if (typeof picked === 'number') return [picked];
    return [];
  }

  function handleCards(s) {
    const c = s.cards;
    const ov = $('cardOverlay');
    if (!c) {
      if (cardUI.id != null && !cardUI.revealed) closeOverlay();
      return;
    }
    if (cardUI.id !== c.id) {
      if (c.revealed) return; // joined mid-reveal, skip
      buildCardOverlay(c);
      return;
    }
    // same phase: update picked/opponent status
    const pickedArr = normalizePicked(c.picked);
    const maxPicks = c.maxPicks ?? 1;
    if (pickedArr.length) markChosen(pickedArr, maxPicks, false);
    const foot = ov.querySelector('.co-foot');
    if (foot && !c.revealed) {
      if (maxPicks === 0) {
        foot.textContent = c.oppPicked
          ? 'Opponent has chosen!'
          : '🔫 Last King Standing — You can no longer pick cards! Waiting for opponent…';
      } else {
        const done = pickedArr.length >= maxPicks;
        if (!done) {
          if (maxPicks > 1 && pickedArr.length > 0) {
            foot.textContent = `🃏 Picked ${pickedArr.length} / ${maxPicks} — choose ${maxPicks - pickedArr.length} more card!`;
          } else {
            foot.textContent = c.oppPicked
              ? `✅ Opponent has chosen — pick ${maxPicks > 1 ? maxPicks + ' cards' : 'a card'}!`
              : `Pick ${maxPicks > 1 ? maxPicks + ' cards' : 'a card'}! Opponent is choosing…`;
          }
        } else {
          foot.textContent = c.oppPicked ? 'Both chosen!' : '⏳ Waiting for opponent to choose…';
        }
      }
    }
    if (c.revealed && !cardUI.revealed) {
      cardUI.revealed = true;
      playExit(c);
    }
  }

  function buildCardOverlay(c) {
    const maxPicks = c.maxPicks ?? 1;
    cardUI = { id: c.id, revealed: false, raf: 0, picked: normalizePicked(c.picked), maxPicks };
    const ov = $('cardOverlay');
    ov.className = 'card-overlay';
    const titleTxt =
      maxPicks === 0
        ? '🔫 Last King Standing 🔫'
        : maxPicks > 1
        ? `✨ Choose ${maxPicks} cards! (Pot of Greed) ✨`
        : '✨ Choose your card ✨';
    const footTxt =
      maxPicks === 0
        ? 'Your King stands alone with a shotgun — you cannot choose more cards! Waiting for opponent…'
        : maxPicks > 1
        ? `Click ${maxPicks} of the 3 cards above!`
        : 'Click one of the 3 cards above!';
    const debugHtml = '';
    ov.innerHTML = `
      <div class="co-title">${titleTxt}</div>
      <div class="co-timer ${c.remaining == null ? 'hidden' : ''}"><div class="bar"><div class="fill"></div></div><div class="secs">15</div></div>
      <div class="co-cards"></div>
      ${debugHtml}
      <div class="co-foot">${footTxt}</div>`;
    const wrap = ov.querySelector('.co-cards');
    c.hand.forEach((card, i) => {
      const slot = document.createElement('div');
      slot.className = 'slot';
      slot.style.setProperty('--d', `${i * 130}ms`);
      slot.style.setProperty('--rot', `${(i - 1) * 10 + 4}deg`);
      slot.innerHTML = `
        <div class="gcard ${card.rarity}" data-i="${i}">
          <div class="rarity">${card.rarity}</div>
          <div class="icon">${card.icon}</div>
          <div class="name">${esc(card.name)}</div>
          <div class="desc">${esc(card.desc)}</div>
        </div>`;
      slot.querySelector('.gcard').onclick = () => {
        if (cardUI.revealed) return;
        if (cardUI.picked.includes(i) || cardUI.picked.length >= cardUI.maxPicks) return;
        cardUI.picked.push(i);
        markChosen(cardUI.picked, cardUI.maxPicks, true);
        socket.emit('pickCard', i);
      };
      wrap.appendChild(slot);
    });

    const dbgBtn = ov.querySelector('#coDebugBtn');
    const dbgSel = ov.querySelector('#coDebugSelect');
    if (dbgBtn && dbgSel) {
      dbgBtn.onclick = () => {
        if (cardUI.revealed || cardUI.picked.length >= cardUI.maxPicks) return;
        const chosenId = dbgSel.value;
        const chosenCard = allCards.find((ac) => ac.id === chosenId);
        const slotIdx = cardUI.picked.length < c.hand.length ? cardUI.picked.length : 0;
        if (chosenCard) {
          c.hand[slotIdx] = chosenCard;
          const g = wrap.querySelectorAll('.gcard')[slotIdx];
          if (g) {
            g.className = `gcard ${chosenCard.rarity}`;
            g.querySelector('.rarity').textContent = chosenCard.rarity;
            g.querySelector('.icon').textContent = chosenCard.icon;
            g.querySelector('.name').textContent = chosenCard.name;
            g.querySelector('.desc').textContent = chosenCard.desc;
          }
        }
        cardUI.picked.push(slotIdx);
        markChosen(cardUI.picked, cardUI.maxPicks, true);
        socket.emit('pickCard', chosenId);
      };
    }

    if (cardUI.picked.length) markChosen(cardUI.picked, cardUI.maxPicks, false);

    SFX.cardsIn();
    if (c.hand.some((x) => x.rarity === 'legendary')) setTimeout(SFX.legendary, 400);

    if (c.remaining != null) {
      const total = 15000;
      const deadline = performance.now() + c.remaining;
      const fill = ov.querySelector('.fill');
      const secs = ov.querySelector('.secs');
      let lastSec = null;
      const loop = () => {
        const left = Math.max(0, deadline - performance.now());
        fill.style.width = (left / total) * 100 + '%';
        const sec = Math.ceil(left / 1000);
        secs.textContent = sec;
        const urgent = left <= 5000;
        fill.classList.toggle('urgent', urgent);
        secs.classList.toggle('urgent', urgent);
        if (urgent && sec !== lastSec && sec > 0 && !wrap.classList.contains('locked')) SFX.tick();
        lastSec = sec;
        if (left > 0 && !cardUI.revealed) cardUI.raf = requestAnimationFrame(loop);
      };
      loop();
    }
  }

  function markChosen(pickedArr, maxPicks, sound) {
    const wrap = $('cardOverlay').querySelector('.co-cards');
    if (!wrap) return;
    const arr = normalizePicked(pickedArr);
    cardUI.picked = arr;
    wrap.classList.toggle('locked', arr.length >= (maxPicks ?? 1));
    wrap.querySelectorAll('.gcard').forEach((g) => g.classList.toggle('chosen', arr.includes(Number(g.dataset.i))));
    if (sound) SFX.pick();
  }

  function playExit(c) {
    cancelAnimationFrame(cardUI.raf);
    const ov = $('cardOverlay');
    const wrap = ov.querySelector('.co-cards');
    if (!wrap) return;
    const pickedArr = normalizePicked(c.picked);
    const maxPicks = c.maxPicks ?? 1;
    markChosen(pickedArr, maxPicks, false);
    if (c.auto && pickedArr.length) {
      const g = wrap.querySelector(`.gcard[data-i="${pickedArr[pickedArr.length - 1]}"]`);
      if (g) g.insertAdjacentHTML('beforeend', '<div class="stamp">⏱ RANDOM PICK</div>');
      SFX.pick();
    }
    ov.querySelector('.co-foot').textContent = c.auto ? "Time's up! A card was picked for you." : 'Casting…';
    const slots = [...wrap.querySelectorAll('.slot')];
    // others leave immediately (expo-in), the chosen one(s) wait 1 second
    slots.forEach((slot, i) => {
      if (pickedArr.includes(i)) return;
      slot.style.setProperty('--d', '0ms');
      slot.classList.add('exit');
    });
    setTimeout(() => {
      pickedArr.forEach((idx) => {
        const chosen = slots[idx];
        if (chosen) chosen.classList.add('exit');
      });
      ov.querySelector('.co-title').style.opacity = '0';
      ov.querySelector('.co-timer').style.opacity = '0';
    }, 1000);

    if (c.wheel) {
      setTimeout(() => showShotgunWheel(c.wheel), 1500);
      setTimeout(closeOverlay, 5800);
    } else {
      setTimeout(closeOverlay, 1650);
    }
  }

  function showShotgunWheel(wheel) {
    const ov = $('cardOverlay');
    if (!ov) return;
    const wLabel = esc(wheel.wName || 'White');
    const bLabel = esc(wheel.bName || 'Black');
    ov.innerHTML = `
      <div class="wheel-wrap">
        <div class="co-title">🔫 Both players chose King with a Shotgun! 🔫</div>
        <div class="co-foot">Only ONE King can wield the Shotgun — spinning the Wheel of Fate!</div>
        <div class="wheel-stage">
          <div class="wheel-pointer">🔻</div>
          <div class="wheel-disc" id="wheelDisc">
            <span class="wheel-slice-label w1">⚪ ${wLabel}</span>
            <span class="wheel-slice-label b1">⚫ ${bLabel}</span>
            <span class="wheel-slice-label w2">⚪ ${wLabel}</span>
            <span class="wheel-slice-label b2">⚫ ${bLabel}</span>
          </div>
        </div>
        <div class="wheel-winner-banner" id="wheelWinnerBanner">Spinning…</div>
      </div>`;
    const disc = $('wheelDisc');
    if (!disc) return;
    // w1 center is at 45deg -> rotate 2115deg (5*360 + 315) brings w1 to 0deg top pointer
    // b1 center is at 135deg -> rotate 2025deg (5*360 + 225) brings b1 to 0deg top pointer
    const targetDeg = wheel.winner === 'w' ? 2115 : 2025;
    void disc.offsetWidth;
    disc.style.transform = `rotate(${targetDeg}deg)`;
    for (let i = 0; i < 14; i++) {
      setTimeout(() => SFX.tick(), i * 160);
    }
    setTimeout(() => {
      SFX.legendary();
      const banner = $('wheelWinnerBanner');
      const winName = wheel.winner === 'w' ? wheel.wName || 'White' : wheel.bName || 'Black';
      if (banner) banner.textContent = `🎯 ${winName} won King with a Shotgun!`;
    }, 2850);
  }

  function closeOverlay() {
    const ov = $('cardOverlay');
    if (ov.classList.contains('hidden')) return;
    ov.classList.add('leaving');
    setTimeout(() => {
      ov.classList.add('hidden');
      ov.classList.remove('leaving');
      ov.innerHTML = '';
    }, 420);
    cardUI.revealed = true;
  }

  // ---------------- VFX & Choreography ----------------
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const sqEl = (sq) => boardEl.querySelector(`[data-sq="${sq}"]`);
  const pieceEl = (sq) => {
    const s = sqEl(sq);
    return s ? s.querySelector('.piece') : null;
  };

  // Envelope shake using requestAnimationFrame:
  // mode = 'hard-to-soft' (starts strong and decays to 0)
  // mode = 'soft-to-hard' (starts tiny and ramps up to max intensity)
  function shakeElement(el, durationMs, maxPx, mode = 'hard-to-soft') {
    if (!el) return Promise.resolve();
    const isBW = el.id === 'boardWrap';
    if (isBW) isShakingBoard = true;
    return new Promise((resolve) => {
      const start = performance.now();
      const step = (now) => {
        const t = Math.min(1, (now - start) / durationMs);
        if (t >= 1) {
          el.style.transform = '';
          if (isBW) isShakingBoard = false;
          resolve();
          return;
        }
        const env = mode === 'soft-to-hard' ? t * t : (1 - t) * (1 - t);
        const amp = maxPx * env;
        const dx = (Math.random() * 2 - 1) * amp;
        const dy = (Math.random() * 2 - 1) * amp;
        const rot = (Math.random() * 2 - 1) * (amp * 0.18);
        el.style.transform = `translate(${dx.toFixed(1)}px, ${dy.toFixed(1)}px) rotate(${rot.toFixed(2)}deg)`;
        requestAnimationFrame(step);
      };
      requestAnimationFrame(step);
    });
  }

  function spawnImpactRing(sq, color = 'rgba(255, 230, 150, .95)') {
    const s = sqEl(sq);
    if (!s) return;
    const ring = document.createElement('div');
    ring.className = 'impact-ring';
    ring.style.borderColor = color;
    ring.style.boxShadow = `0 0 18px ${color}`;
    s.appendChild(ring);
    setTimeout(() => ring.remove(), 600);
  }

  // Smoothly slides a piece currently rendered at `toSq` from `fromSq` using expo-out
  function slidePieceOnBoard(fromSq, toSq, durationMs = 450) {
    const fromNode = sqEl(fromSq);
    const toNode = sqEl(toSq);
    const pNode = pieceEl(toSq);
    if (!fromNode || !toNode || !pNode) return Promise.resolve();
    const r1 = fromNode.getBoundingClientRect();
    const r2 = toNode.getBoundingClientRect();
    const dx = r1.left - r2.left;
    const dy = r1.top - r2.top;
    pNode.style.transition = 'none';
    pNode.style.zIndex = '20';
    pNode.style.transform = `translate(${dx}px, ${dy}px) scale(1.08)`;
    // force reflow
    void pNode.offsetWidth;
    pNode.style.transition = `transform ${durationMs}ms cubic-bezier(0.16, 1, 0.3, 1)`;
    pNode.style.transform = 'translate(0px, 0px) scale(1)';
    setTimeout(() => spawnImpactRing(toSq, 'rgba(255,255,255,.55)'), Math.max(80, durationMs * 0.55));
    return new Promise((resolve) => {
      setTimeout(() => {
        if (pNode) {
          pNode.style.transition = '';
          pNode.style.transform = '';
          pNode.style.zIndex = '';
        }
        resolve();
      }, durationMs + 30);
    });
  }

  // Generates a randomized 2-to-5 segment lightning bolt with random left/right zig-zags and tilt
  function spawnLightningBolt(sq) {
    const s = sqEl(sq);
    const layer = $('vfxLayer');
    if (!s || !layer) return;
    const bRect = layer.getBoundingClientRect();
    const sRect = s.getBoundingClientRect();
    const cx = sRect.left - bRect.left + sRect.width / 2;
    const cy = sRect.top - bRect.top + sRect.height * 0.74;

    // Random number of segments: 2 to 5
    const segs = 2 + Math.floor(Math.random() * 4); // 2, 3, 4, or 5
    const W = 90;
    const H = 320;
    const midX = W / 2;
    let dir = Math.random() < 0.5 ? -1 : 1; // initial random facing direction
    const pts = [[midX + (Math.random() * 18 - 9), 0]];
    for (let i = 1; i < segs; i++) {
      const y = (H / segs) * i + (Math.random() * 18 - 9);
      const offset = (12 + Math.random() * 24) * dir;
      pts.push([midX + offset, Math.max(10, Math.min(H - 15, y))]);
      // alternate or randomly flip facing for next segment
      dir = Math.random() < 0.8 ? -dir : dir;
    }
    pts.push([midX, H]); // strike right onto the target square center

    const polyPoints = pts.map(([x, y]) => `${x.toFixed(1)},${y.toFixed(1)}`).join(' ');
    const tiltDeg = (Math.random() * 22 - 11).toFixed(1);

    const bolt = document.createElement('div');
    bolt.className = 'smite-bolt';
    bolt.style.left = `${cx}px`;
    bolt.style.top = `${cy}px`;
    bolt.innerHTML = `<svg viewBox="0 0 ${W} ${H}" width="100%" height="100%" preserveAspectRatio="none" style="transform:rotate(${tiltDeg}deg);overflow:visible">
      <polyline points="${polyPoints}" fill="none" stroke="#facc15" stroke-width="8" stroke-linecap="round" stroke-linejoin="round" />
    </svg>`;
    layer.appendChild(bolt);
    setTimeout(() => bolt.remove(), 1000);
  }

  function diffBoard(before, after) {
    const moved = [];
    const replaced = []; // any square where a piece changed type, color, pink status, or swapped with another piece!
    const removed = [];
    const spawned = [];
    if (!before || !after) return { moved, replaced, removed, spawned };

    // Detect squares where a piece was replaced/transformed in-place (including Castle Swap, Suit Up, Rust, Backstab, Royal Decree, Gender Bend, Conscription, Mutiny)
    for (let sq = 0; sq < 64; sq++) {
      const b = before[sq];
      const a = after[sq];
      if (b && a && (b.t !== a.t || b.c !== a.c || b.pink !== a.pink)) {
        replaced.push({ sq, beforeP: b, afterP: a });
      }
    }

    const beforeById = new Map();
    const afterById = new Map();
    before.forEach((p, sq) => p && p.id && beforeById.set(p.id, { p, sq }));
    after.forEach((p, sq) => p && p.id && afterById.set(p.id, { p, sq }));

    for (const [id, bInfo] of beforeById.entries()) {
      const aInfo = afterById.get(id);
      if (!aInfo) {
        removed.push({ sq: bInfo.sq, p: bInfo.p });
      } else if (bInfo.sq !== aInfo.sq) {
        moved.push({ from: bInfo.sq, to: aInfo.sq, beforeP: bInfo.p, afterP: aInfo.p });
      }
    }
    for (const [id, aInfo] of afterById.entries()) {
      if (!beforeById.has(id)) spawned.push({ sq: aInfo.sq, p: aInfo.p });
    }
    return { moved, replaced, removed, spawned };
  }

  function get4DTransform(r, f, fl, bs) {
    const lr = r & 3;
    const lf = f & 3;
    const cell8 = bs / 8;
    const gr = fl ? r : 7 - r;
    const gc = fl ? 7 - f : f;
    const gr4D = fl ? lr : 3 - lr;
    const gc4D = fl ? 3 - lf : lf;
    const dx = (2 * gc4D - gc + 0.5) * cell8;
    const dy = (2 * gr4D - gr + 0.5) * cell8;
    return { dx, dy };
  }

  async function playSingleCardVFX(e) {
    const id = e.card.id;
    const { moved, replaced, removed, spawned } = diffBoard(e.before, e.after);

    // 0a) DISTORTED VIEW (Event Card):
    //     Cuts the chessboard into 4 quadrants (4×4) with a glowing void cross-rift, pulls the 4 board chunks apart, and slides the entire sliced board chunks (squares + pieces) to their shuffled positions!
    if (id === 'distortedView') {
      displayBoard = e.before ? e.before.map((p) => (p ? { ...p } : null)) : null;
      renderBoard();
      const wrap = $('boardWrap');
      if (wrap) wrap.classList.add('slicing');
      const layer = $('vfxLayer');
      if (layer) {
        const hLine = document.createElement('div');
        hLine.className = 'distort-slice-line horiz';
        const vLine = document.createElement('div');
        vLine.className = 'distort-slice-line vert';
        layer.appendChild(hLine);
        layer.appendChild(vLine);
        setTimeout(() => {
          hLine.remove();
          vLine.remove();
        }, 1200);
      }

      // Play slice.mp3 right when the board gets sliced!
      SFX.slice();

      const fl = flipped();
      const bs = boardEl.getBoundingClientRect().width || 640;
      const halfBs = bs / 2;

      // Determine where each old quadrant (0=BL, 1=BR, 2=TL, 3=TR in board coords) moves to:
      // perm[newQ] = oldQ -> so oldQ moves to newQ = perm.indexOf(oldQ)
      let perm = Array.isArray(e.quadPerm) && e.quadPerm.length === 4 ? e.quadPerm : null;
      if (!perm && e.before && e.after) {
        const ALL_PERMS = [
          [3, 2, 1, 0], [2, 3, 1, 0], [3, 2, 0, 1], [1, 2, 3, 0], [3, 0, 1, 2],
          [3, 1, 2, 0], [0, 2, 1, 3], [2, 0, 3, 1], [1, 3, 0, 2], [2, 3, 0, 1], [1, 0, 3, 2],
        ];
        let bestScore = -1;
        for (const cand of ALL_PERMS) {
          let score = 0;
          for (let sq = 0; sq < 64; sq++) {
            const p = e.before[sq];
            if (!p) continue;
            const r = sq >> 3, f = sq & 7;
            const oldQ = (r >= 4 ? 2 : 0) + (f >= 4 ? 1 : 0);
            const newQ = cand.indexOf(oldQ);
            const nsq = ((newQ >> 1) * 4 + (r & 3)) * 8 + ((newQ & 1) * 4 + (f & 3));
            const ap = e.after[nsq];
            if (ap && ap.c === p.c && (ap.t === p.t || (p.t === 'p' && ap.t === 'q'))) score++;
          }
          if (score > bestScore) {
            bestScore = score;
            perm = cand;
          }
        }
      }
      if (!perm) perm = [3, 2, 1, 0];

      // Commit baseline layout before applying transitions to prevent sudden jumping
      boardEl.querySelectorAll('.sq').forEach((cell) => {
        cell.style.transform = 'translate(0px, 0px)';
        cell.style.transition = 'transform 320ms cubic-bezier(0.16, 1, 0.3, 1)';
      });
      void boardEl.offsetHeight;

      // Allow slice beam ~120ms to extend across the board before quadrants part
      await wait(120);

      // Step 1: Slice and push the 4 solid 4×4 board quadrants outward from the center cut lines
      boardEl.querySelectorAll('.sq').forEach((cell) => {
        const sq = Number(cell.dataset.sq);
        const r = sq >> 3;
        const f = sq & 7;
        const qr = r >= 4 ? 1 : 0;
        const qf = f >= 4 ? 1 : 0;
        const oldQ = qr * 2 + qf;
        const newQ = perm.indexOf(oldQ);
        const isDiag = newQ >= 0 && (newQ >> 1) !== qr && (newQ & 1) !== qf;
        const screenRight = fl ? f < 4 : f >= 4;
        const screenBottom = fl ? r >= 4 : r < 4;
        const pushX = screenRight ? 16 : -16;
        const pushY = screenBottom ? 16 : -16;
        cell.classList.add('quad-cut');
        cell.style.zIndex = String((isDiag ? 20 : 15) + oldQ);
        cell.style.transform = `translate(${pushX}px, ${pushY}px)`;
      });
      await wait(360);

      // Step 2: Slide the 4 sliced 4×4 board chunks (every square + its piece together!) across the board to their new quadrant slots
      SFX.dash();
      boardEl.querySelectorAll('.sq').forEach((cell) => {
        const sq = Number(cell.dataset.sq);
        const r = sq >> 3;
        const f = sq & 7;
        const qr = r >= 4 ? 1 : 0;
        const qf = f >= 4 ? 1 : 0;
        const oldQ = qr * 2 + qf;
        const newQ = perm.indexOf(oldQ);
        const nqr = newQ >= 0 ? newQ >> 1 : qr;
        const nqf = newQ >= 0 ? newQ & 1 : qf;

        const dqf = nqf - qf;
        const dqr = nqr - qr;
        const screenDx = (fl ? -dqf : dqf) * halfBs;
        const screenDy = (fl ? dqr : -dqr) * halfBs;

        // Keep them slightly separated while sliding to their new quadrant slot
        const targetScreenRight = fl ? nqf === 0 : nqf === 1;
        const targetScreenBottom = fl ? nqr === 1 : nqr === 0;
        const pushX = targetScreenRight ? 12 : -12;
        const pushY = targetScreenBottom ? 12 : -12;

        cell.style.transition = 'transform 640ms cubic-bezier(0.16, 1, 0.3, 1)';
        cell.style.transform = `translate(${(screenDx + pushX).toFixed(1)}px, ${(screenDy + pushY).toFixed(1)}px)`;
      });
      await wait(650);

      // Step 3: Snap the 4 board quadrants back together into a seamless 8×8 board
      boardEl.querySelectorAll('.sq').forEach((cell) => {
        const sq = Number(cell.dataset.sq);
        const r = sq >> 3;
        const f = sq & 7;
        const qr = r >= 4 ? 1 : 0;
        const qf = f >= 4 ? 1 : 0;
        const oldQ = qr * 2 + qf;
        const newQ = perm.indexOf(oldQ);
        const nqr = newQ >= 0 ? newQ >> 1 : qr;
        const nqf = newQ >= 0 ? newQ & 1 : qf;

        const dqf = nqf - qf;
        const dqr = nqr - qr;
        const screenDx = (fl ? -dqf : dqf) * halfBs;
        const screenDy = (fl ? dqr : -dqr) * halfBs;

        cell.style.transition = 'transform 200ms cubic-bezier(0.34, 1.56, 0.64, 1)';
        cell.style.transform = `translate(${screenDx.toFixed(1)}px, ${screenDy.toFixed(1)}px)`;
      });
      await wait(190);
      SFX.slam();

      // Step 4: Commit the `after` board state cleanly in-place and impact shake!
      if (wrap) wrap.classList.remove('slicing');
      displayBoard = e.after ? e.after.map((p) => (p ? { ...p } : null)) : null;
      renderBoard();
      await shakeElement(wrap, 750, 15, 'hard-to-soft');
      return;
    }

    // 0b) EVENT HORIZON (Event Card):
    //     Slices the chessboard horizontally into 2 halves for 10 turns (or collapses the rift if activated again!)
    if (id === 'eventHorizon') {
      isAnimatingEventHorizon = true;
      const wrap = $('boardWrap');
      const layer = $('vfxLayer');
      const cleared = e.eventHorizonAction === 'cleared';

      if (cleared) {
        eventHorizonPendingCut = false;
        // Rift is collapsing: play sound immediately, fade out barrier, and slam the 2 halves back together!
        SFX.dash();
        displayBoard = e.before ? e.before.map((p) => (p ? { ...p } : null)) : null;
        renderBoard();
        if (wrap) wrap.classList.add('slicing');
        const bar = layer ? layer.querySelector('.eh-barrier') : null;
        if (bar) {
          bar.style.transition = 'opacity 200ms ease, transform 200ms ease';
          bar.style.opacity = '0';
          bar.style.transform = 'scaleY(0.1)';
          setTimeout(() => bar.remove(), 210);
        }

        boardEl.querySelectorAll('.sq').forEach((cell) => {
          const isTop = cell.classList.contains('eh-top');
          cell.style.transform = `translateY(${isTop ? -14 : 14}px)`;
        });
        void boardEl.offsetHeight;
        await wait(150);

        boardEl.querySelectorAll('.sq').forEach((cell) => {
          cell.style.transition = 'transform 320ms cubic-bezier(0.34, 1.56, 0.64, 1)';
          cell.style.transform = 'translateY(0px)';
        });
        await wait(300);
        SFX.slam();

        if (wrap) {
          wrap.classList.remove('slicing');
          wrap.classList.remove('eh-active');
        }
        isAnimatingEventHorizon = false;
        currentEffectEventHorizon = 0;
        displayBoard = e.after ? e.after.map((p) => (p ? { ...p } : null)) : null;
        renderBoard();
        await shakeElement(wrap, 680, 14, 'hard-to-soft');
        return;
      }

      // Slicing the board in 2!
      // Ensure no barrier or turns number is displayed before the cut animation finishes
      eventHorizonPendingCut = true;
      displayBoard = e.before ? e.before.map((p) => (p ? { ...p } : null)) : null;
      renderBoard();
      const existingBar = layer ? layer.querySelector('.eh-barrier') : null;
      if (existingBar) existingBar.remove();

      if (layer) {
        const hLine = document.createElement('div');
        hLine.className = 'distort-slice-line horiz';
        layer.appendChild(hLine);
        setTimeout(() => hLine.remove(), 1150);
      }

      SFX.slice();

      boardEl.querySelectorAll('.sq').forEach((cell) => {
        cell.style.transform = 'translateY(0px)';
        cell.style.transition = 'transform 300ms cubic-bezier(0.16, 1, 0.3, 1)';
      });
      void boardEl.offsetHeight;

      await wait(120);

      if (wrap) {
        wrap.classList.remove('eh-active');
        wrap.classList.add('slicing');
      }
      boardEl.querySelectorAll('.sq').forEach((cell) => {
        const isTop = cell.classList.contains('eh-top');
        cell.classList.add('quad-cut');
        cell.style.transform = `translateY(${isTop ? -18 : 18}px)`;
      });
      await wait(420);

      // Settle into the 10-turn Event Horizon separation with the glowing void barrier!
      boardEl.querySelectorAll('.sq').forEach((cell) => {
        const isTop = cell.classList.contains('eh-top');
        cell.style.transition = 'transform 280ms cubic-bezier(0.16, 1, 0.3, 1)';
        cell.style.transform = `translateY(${isTop ? -9 : 9}px)`;
      });
      await wait(290);
      SFX.slam();

      // NOW the cut animation has finished: unlock barrier rendering so the glitchy space rift and low-opacity number appear
      if (wrap) wrap.classList.remove('slicing');
      isAnimatingEventHorizon = false;
      eventHorizonPendingCut = false;
      currentEffectEventHorizon = 10;
      displayBoard = e.after ? e.after.map((p) => (p ? { ...p } : null)) : null;
      renderBoard();
      await shakeElement(wrap, 700, 14, 'hard-to-soft');
      return;
    }

    // 0c) 4 DIMENSIONAL LAYER (Event Card):
    //     Cuts the board into 4 quadrants, turns pieces to 25% opacity, and stacks all 4 quadrants on top of each other in the center!
    if (id === 'fourDimLayer') {
      isAnimatingFourDim = true;
      displayBoard = e.before ? e.before.map((p) => (p ? { ...p } : null)) : null;
      renderBoard(displayBoard, true);
      const wrap = $('boardWrap');
      if (wrap) wrap.classList.add('slicing');
      const layer = $('vfxLayer');
      if (layer) {
        const hLine = document.createElement('div');
        hLine.className = 'distort-slice-line horiz';
        const vLine = document.createElement('div');
        vLine.className = 'distort-slice-line vert';
        layer.appendChild(hLine);
        layer.appendChild(vLine);
        setTimeout(() => {
          hLine.remove();
          vLine.remove();
        }, 1200);
      }

      // Step 1: Slice the board into 4 quadrants with slice.mp3 and fade pieces to 25% opacity
      SFX.slice();
      const fl = flipped();
      const bs = boardEl.getBoundingClientRect().width || 640;

      // Register baseline layout
      boardEl.querySelectorAll('.sq').forEach((cell) => {
        cell.style.transform = 'translate(0px, 0px)';
        cell.style.transition = 'transform 320ms cubic-bezier(0.16, 1, 0.3, 1)';
      });
      void boardEl.offsetHeight;

      await wait(120);

      boardEl.querySelectorAll('.sq').forEach((cell) => {
        const sq = Number(cell.dataset.sq);
        const r = sq >> 3;
        const f = sq & 7;
        const screenRight = fl ? f < 4 : f >= 4;
        const screenBottom = fl ? r >= 4 : r < 4;
        const pushX = screenRight ? 16 : -16;
        const pushY = screenBottom ? 16 : -16;
        cell.classList.add('quad-cut');
        cell.style.transform = `translate(${pushX}px, ${pushY}px)`;
      });
      boardEl.querySelectorAll('.piece img').forEach((img) => {
        img.style.transition = 'opacity 360ms ease';
        img.style.opacity = '0.25';
      });
      await wait(360);

      // Step 2: Scale and slide all 4 quadrants into the 4×4 board layout so they stack directly on top of each other at 25% opacity!
      SFX.dash();
      boardEl.querySelectorAll('.sq').forEach((cell) => {
        const sq = Number(cell.dataset.sq);
        const r = sq >> 3;
        const f = sq & 7;
        const qr = r >= 4 ? 1 : 0;
        const qf = f >= 4 ? 1 : 0;
        const oldQ = qr * 2 + qf;
        const tf = get4DTransform(r, f, fl, bs);
        cell.style.zIndex = String(10 + oldQ);
        cell.style.transition = 'transform 640ms cubic-bezier(0.16, 1, 0.3, 1), opacity 640ms ease';
        cell.style.transform = `translate(${tf.dx.toFixed(1)}px, ${tf.dy.toFixed(1)}px) scale(2)`;
      });
      await wait(650);

      // Step 3: Commit the merged 4D stacked board (`e.after`) and impact shake!
      if (wrap) wrap.classList.remove('slicing');
      currentEffectFourDim = true;
      isAnimatingFourDim = false;
      displayBoard = e.after ? e.after.map((p) => (p ? { ...p } : null)) : null;
      renderBoard();
      SFX.slam();
      await shakeElement(wrap, 750, 15, 'hard-to-soft');
      return;
    }

    // 1) SMITE ("I Cast Death Upon Your Soldiers") or EARTHQUAKE:
    //    Single-color yellow 2–5 segment lightning strikes all of them and scales down for 1s while the board shakes hard-to-soft for 3s!
    if (id === 'smite' || (id === 'earthquake' && removed.length)) {
      displayBoard = e.before.map((p) => (p ? { ...p } : null));
      renderBoard();
      if (removed.length) {
        SFX.thunder();
        const flash = document.createElement('div');
        flash.className = 'smite-flash';
        $('boardWrap').appendChild(flash);
        setTimeout(() => flash.remove(), 400);

        removed.forEach(({ sq }) => {
          spawnLightningBolt(sq);
          spawnImpactRing(sq, '#facc15');
          const pe = pieceEl(sq);
          if (pe) pe.classList.add('smite-die');
        });
        // 3-second hard-to-soft shake on #boardWrap
        shakeElement($('boardWrap'), 3000, 20, 'hard-to-soft');
        await wait(1000);
      }
      displayBoard = e.after.map((p) => (p ? { ...p } : null));
      renderBoard();
      return;
    }

    // 2) ANY CARD THAT REPLACES / TRANSFORMS / SWAPS A PIECE
    //    (Suit Up, Queen's Gambit, Knighthood, Holy Orders, Rook Lift, Gender Bend, Rust, Backstab, Royal Decree, Conscription, Mutiny, Castle Swap):
    //    Old piece jumps up & spins 720° (600ms) -> right as it hits the ground, swaps to the new piece and shakes hard-to-soft for 1 second!
    if (replaced.length) {
      displayBoard = e.before.map((p) => (p ? { ...p } : null));
      renderBoard();
      SFX.magic();
      replaced.forEach(({ sq }) => {
        const pe = pieceEl(sq);
        if (pe) pe.classList.add('jump-spin');
      });
      // Wait for jump + spin to hit the ground (600ms)
      await wait(600);
      // Swap to the new piece right on ground impact!
      displayBoard = e.after.map((p) => (p ? { ...p } : null));
      renderBoard();
      SFX.slam();
      const ringColor = e.card.rarity === 'legendary' ? '#fbbf24' : '#c084fc';
      const pieceShakes = replaced.map(({ sq }) => {
        spawnImpactRing(sq, ringColor);
        return shakeElement(pieceEl(sq), 1000, 11, 'hard-to-soft');
      });
      await Promise.all([
        ...pieceShakes,
        shakeElement($('boardWrap'), 1000, 14, 'hard-to-soft'),
      ]);
      return;
    }

    // 3) SPRINT / PAWN STORM / SLIPPERY FLOOR / BANANA PEEL:
    //    Piece shakes soft-to-hard for 1 second -> slides to destination in expo-out!
    if (moved.length && ['sprint', 'pawnStorm', 'slippery', 'banana'].includes(id)) {
      displayBoard = e.before.map((p) => (p ? { ...p } : null));
      renderBoard();
      SFX.charge();
      await Promise.all(moved.map((m) => shakeElement(pieceEl(m.from), 1000, 10, 'soft-to-hard')));
      // Switch to `after` board and slide every moved piece from its origin to its destination in expo-out
      displayBoard = e.after.map((p) => (p ? { ...p } : null));
      renderBoard();
      SFX.dash();
      await Promise.all(moved.map((m) => slidePieceOnBoard(m.from, m.to, 520)));
      if (removed.length) {
        SFX.boom();
        shakeElement($('boardWrap'), 900, 15, 'hard-to-soft');
      }
      return;
    }

    // 4) POTHOLE:
    //    A dark hole opens at the bottom of the piece, the piece wobbles and falls straight down,
    //    masked/clipped cleanly by the hole's bottom rim, and then the hole closes!
    if (id === 'pothole' && removed.length) {
      displayBoard = e.before.map((p) => (p ? { ...p } : null));
      renderBoard();
      SFX.charge();
      const pits = removed.map(({ sq }) => {
        const cell = sqEl(sq);
        const pe = pieceEl(sq);
        if (pe) pe.classList.add('pothole-fall');
        if (!cell) return null;
        const pit = document.createElement('div');
        pit.className = 'pothole-pit';
        cell.appendChild(pit);
        return pit;
      });
      setTimeout(() => {
        SFX.slam();
        shakeElement($('boardWrap'), 500, 7, 'hard-to-soft');
      }, 320);
      await wait(1350);
      pits.forEach((p) => p && p.remove());
      displayBoard = e.after.map((p) => (p ? { ...p } : null));
      renderBoard();
      return;
    }

    // 5) THANOS SNAP:
    if (removed.length) {
      displayBoard = e.before.map((p) => (p ? { ...p } : null));
      renderBoard();
      SFX.boom();
      removed.forEach(({ sq }) => {
        const pe = pieceEl(sq);
        if (pe) pe.classList.add('dust-die');
        spawnImpactRing(sq, '#a855f7');
      });
      shakeElement($('boardWrap'), 1000, 12, 'hard-to-soft');
      await wait(800);
      displayBoard = e.after.map((p) => (p ? { ...p } : null));
      renderBoard();
      return;
    }

    // 5) REINFORCEMENTS / CLONE / NECROMANCY / ARMY OF DARKNESS:
    if (spawned.length) {
      displayBoard = e.after.map((p) => (p ? { ...p } : null));
      renderBoard();
      SFX.slam();
      spawned.forEach(({ sq }) => {
        const pe = pieceEl(sq);
        if (pe) pe.classList.add('pop-spawn');
        spawnImpactRing(sq, '#81b64c');
      });
      await shakeElement($('boardWrap'), 850, 10, 'hard-to-soft');
      return;
    }

    // 6) Status cards (Freeze Ray, Ice Age, Bodyguard, Holy Shield, Fog, Time Stop, Double Move, Landmine):
    displayBoard = e.after ? e.after.map((p) => (p ? { ...p } : null)) : null;
    renderBoard();
    SFX.magic();
    boardEl.querySelectorAll('.sq').forEach((el) => el.classList.add('flash'));
    setTimeout(() => boardEl.querySelectorAll('.sq.flash').forEach((el) => el.classList.remove('flash')), 1000);
    await shakeElement($('boardWrap'), 650, 8, 'hard-to-soft');
  }

  function showProfileCardIcon(color, card) {
    const bar = document.querySelector(`.player-bar[data-color="${color}"]`);
    const av = bar && bar.querySelector('.avatar');
    if (!av) return;
    av.querySelectorAll('.card-pop').forEach((x) => x.remove());
    const pop = document.createElement('div');
    pop.className = `card-pop ${card.rarity}`;
    pop.title = `${card.name}: ${card.desc}`;
    pop.textContent = card.icon;
    av.appendChild(pop);
    setTimeout(() => pop.remove(), 1850);
  }

  async function playShotgunSequence(sf) {
    // 1) Move the King first while other pieces remain in their pre-shot state
    const midBoard = sf.before
      ? sf.before.map((p) => (p ? { ...p } : null))
      : S.board.map((p) => (p ? { ...p } : null));
    if (midBoard[sf.from]) {
      midBoard[sf.to] = midBoard[sf.from];
      midBoard[sf.from] = null;
    }
    displayBoard = midBoard;
    renderBoard();
    await slidePieceOnBoard(sf.from, sf.to, 240);

    const fl = flipped();
    const screenDx = fl ? -sf.df : sf.df;
    const screenDy = fl ? sf.dr : -sf.dr;
    const aimRad = Math.atan2(screenDy, screenDx);
    const aimDeg = aimRad * (180 / Math.PI);
    const flipY = screenDx < 0 ? -1 : 1;
    const destCell = sqEl(sf.to);
    const cellSize = destCell ? destCell.getBoundingClientRect().width : 64;

    // 2) Simultaneously animate BOTH the King AND the Shotgun from KING_AND_SHOTGUN_TWEEN!
    // KING_AND_SHOTGUN_TWEEN_V2
    const KING_AND_SHOTGUN_TWEEN = {
      duration: 600,
      followKing: false,
      kingKeyframes: [
        { t: 10,  recoil: 0,  jumpY: 0, offX: 0, rot: 0,   scaleX: 1, scaleY: 1, ease: 'linear',  jumpEase: 'linear' },
        { t: 20,  recoil: 36, jumpY: 0, offX: 0, rot: -30, scaleX: 1, scaleY: 1, ease: 'expoOut', jumpEase: 'linear' },
        { t: 100, recoil: 0,  jumpY: 0, offX: 0, rot: 0,   scaleX: 1, scaleY: 1, ease: 'expoOut', jumpEase: 'sineOut' },
      ],
      gunKeyframes: [
        { t: 10,  pump: 100, recoil: 0,  offY: 11, rot: 31,   scale: 1, muzzle: 0, ease: 'linear',  pumpEase: 'linear' },
        { t: 20,  pump: 0,   recoil: 20, offY: 11, rot: -42,  scale: 1, muzzle: 0, ease: 'expoOut', pumpEase: 'linear' },
        { t: 100, pump: 18,  recoil: 0,  offY: 11, rot: -142, scale: 1, muzzle: 0, ease: 'expoOut', pumpEase: 'linear' },
      ],
    };

    const TWEEN_EASINGS = {
      linear: (t) => t,
      expoOut: (t) => (t === 1 ? 1 : 1 - Math.pow(2, -10 * t)),
      expoIn: (t) => (t === 0 ? 0 : Math.pow(2, 10 * (t - 1))),
      easeInOut: (t) => (t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2),
      sineOut: (t) => Math.sin((t * Math.PI) / 2),
      sineIn: (t) => 1 - Math.cos((t * Math.PI) / 2),
    };
    const lerp = (x, y, u) => x + (y - x) * u;

    const sampleKingTween = (p) => {
      const kfs = KING_AND_SHOTGUN_TWEEN.kingKeyframes;
      if (p <= kfs[0].t) return kfs[0];
      if (p >= kfs[kfs.length - 1].t) return kfs[kfs.length - 1];
      let i = 0;
      while (i < kfs.length - 2 && p > kfs[i + 1].t) i++;
      const a = kfs[i];
      const b = kfs[i + 1];
      const rawT = Math.min(1, Math.max(0, (p - a.t) / Math.max(0.0001, b.t - a.t)));
      const eMain = (TWEEN_EASINGS[b.ease] || TWEEN_EASINGS.linear)(rawT);
      const eJump = (TWEEN_EASINGS[b.jumpEase] || TWEEN_EASINGS.linear)(rawT);
      return {
        recoil: lerp(a.recoil, b.recoil, eMain),
        jumpY: lerp(a.jumpY, b.jumpY, eJump),
        offX: lerp(a.offX, b.offX, eMain),
        rot: lerp(a.rot, b.rot, eMain),
        scaleX: lerp(a.scaleX, b.scaleX, eMain),
        scaleY: lerp(a.scaleY, b.scaleY, eMain),
      };
    };

    const sampleGunTween = (p) => {
      const kfs = KING_AND_SHOTGUN_TWEEN.gunKeyframes;
      if (p <= kfs[0].t) return kfs[0];
      if (p >= kfs[kfs.length - 1].t) return kfs[kfs.length - 1];
      let i = 0;
      while (i < kfs.length - 2 && p > kfs[i + 1].t) i++;
      const a = kfs[i];
      const b = kfs[i + 1];
      const rawT = Math.min(1, Math.max(0, (p - a.t) / Math.max(0.0001, b.t - a.t)));
      const eMain = (TWEEN_EASINGS[b.ease] || TWEEN_EASINGS.linear)(rawT);
      const ePump = (TWEEN_EASINGS[b.pumpEase] || TWEEN_EASINGS.linear)(rawT);
      return {
        pump: lerp(a.pump, b.pump, ePump),
        recoil: lerp(a.recoil, b.recoil, eMain),
        offY: lerp(a.offY, b.offY, eMain),
        rot: lerp(a.rot, b.rot, eMain),
        scale: lerp(a.scale, b.scale, eMain),
        muzzle: lerp(a.muzzle, b.muzzle, eMain),
      };
    };

    const buildRig = () => {
      const cell = sqEl(sf.to);
      if (!cell) return null;
      cell.querySelectorAll('.shotgun-rig').forEach((x) => x.remove());
      const rig = document.createElement('div');
      rig.className = 'shotgun-rig out';
      rig.style.transition = 'none';
      rig.innerHTML = `
        <svg class="sg-gun-svg" viewBox="0 0 84 32" width="100%" height="100%" style="overflow:visible;transform:scaleY(${flipY})">
          <path d="M2,22 L18,14 L22,14 L20,21 L6,26 Z" fill="#92400e" stroke="#1f2937" stroke-width="2" stroke-linejoin="round"/>
          <rect x="18" y="11" width="18" height="7" rx="1.5" fill="#374151" stroke="#111827" stroke-width="2"/>
          <rect x="25" y="12" width="7" height="2.5" rx="0.5" fill="#111827"/>
          <rect x="35" y="11" width="32" height="4" rx="1" fill="#6b7280" stroke="#111827" stroke-width="1.8"/>
          <rect x="35" y="15" width="26" height="3" rx="1" fill="#4b5563" stroke="#111827" stroke-width="1.5"/>
          <g class="sg-pump">
            <rect x="42" y="14" width="14" height="6" rx="2" fill="#f59e0b" stroke="#111827" stroke-width="1.8"/>
            <line x1="46" y1="14" x2="46" y2="20" stroke="#78350f" stroke-width="1.5"/>
            <line x1="50" y1="14" x2="50" y2="20" stroke="#78350f" stroke-width="1.5"/>
          </g>
          <g class="sg-muzzle" style="opacity:0;transform-origin:68px 13px">
            <polygon points="67,13 85,3 79,11 88,13 79,15 85,23" fill="#fde047" stroke="#ef4444" stroke-width="1.5"/>
          </g>
        </svg>`;
      cell.appendChild(rig);
      return rig;
    };

    const fireBulletsNow = () => {
      // Update non-king squares (damage pips / captured pieces) without destroying the animating King + Gun DOM at sf.to!
      if (sf.after) {
        displayBoard = sf.after.map((p) => (p ? { ...p } : null));
        if (Array.isArray(sf.rays)) {
          sf.rays.forEach((ray) => {
            const hitList = Array.isArray(ray.hits) ? ray.hits : ray.hit ? [ray.hit] : [];
            hitList.forEach((hitObj) => {
              const hSq = hitObj.sq;
              const hCell = sqEl(hSq);
              if (!hCell) return;
              hCell.querySelectorAll('.piece').forEach((x) => x.remove());
              const pAfter = displayBoard[hSq];
              if (pAfter) {
                const pe = document.createElement('div');
                pe.className = 'piece';
                if (pAfter.frozen) pe.classList.add('frozen');
                if (pAfter.shield) pe.classList.add('shield');
                if (pAfter.pink) pe.classList.add('pink');
                if (pAfter.shotgun) pe.classList.add('shotgun');
                let extraHtml = '';
                if (pAfter.shotgun) extraHtml += '<span class="sg-badge" title="King with a Shotgun">🔫</span>';
                extraHtml += renderHpBarHtml(pAfter);
                pe.innerHTML = `<img src="${pieceSrc(pAfter)}" alt="" draggable="false">${extraHtml}`;
                hCell.appendChild(pe);
              }
              spawnImpactRing(hSq, hitObj.killed ? '#ef4444' : '#facc15');
              if (!hitObj.killed && !hitObj.blocked) {
                shakeElement(pieceEl(hSq), 420, 8, 'hard-to-soft');
              }
            });
          });
        }
      }

      const layer = $('vfxLayer');
      const fromCell = sqEl(sf.to);
      if (layer && fromCell && Array.isArray(sf.rays)) {
        const bRect = layer.getBoundingClientRect();
        const sRect = fromCell.getBoundingClientRect();
        const x1 = sRect.left - bRect.left + sRect.width / 2;
        const y1 = sRect.top - bRect.top + sRect.height / 2;
        sf.rays.forEach((ray) => {
          const endCell = sqEl(ray.endSq);
          if (!endCell) return;
          const eRect = endCell.getBoundingClientRect();
          let x2 = eRect.left - bRect.left + eRect.width / 2;
          let y2 = eRect.top - bRect.top + eRect.height / 2;
          if (!ray.hit && ray.endSq === sf.to) {
            const rdx = fl ? -ray.bf : ray.bf;
            const rdy = fl ? ray.br : -ray.br;
            x2 += rdx * sRect.width * 0.6;
            y2 += rdy * sRect.height * 0.6;
          }
          const dist = Math.hypot(x2 - x1, y2 - y1);
          const ang = Math.atan2(y2 - y1, x2 - x1) * (180 / Math.PI);
          const tracer = document.createElement('div');
          tracer.className = 'bullet-tracer';
          tracer.style.width = `${Math.max(24, dist)}px`;
          tracer.style.setProperty('--bx', `${x1.toFixed(1)}px`);
          tracer.style.setProperty('--by', `${y1.toFixed(1)}px`);
          tracer.style.setProperty('--bang', `${ang.toFixed(1)}deg`);
          layer.appendChild(tracer);
          setTimeout(() => tracer.remove(), 260);
        });
      }
      shakeElement($('boardWrap'), 580, 14, 'hard-to-soft');
    };

    const rig = buildRig();
    const pumpGrp = rig ? rig.querySelector('.sg-pump') : null;
    const muzzleGrp = rig ? rig.querySelector('.sg-muzzle') : null;
    const kingNode = pieceEl(sf.to);
    const kingImg = kingNode ? kingNode.querySelector('img') : null;
    const totalDuration = KING_AND_SHOTGUN_TWEEN.duration;
    const unitScale = cellSize / 72;
    const spinSign = screenDx < 0 ? -1 : 1;

    SFX.shot();
    let hasFiredShot = false;
    let shotFlashUntil = 0;
    // Find the first gun keyframe with muzzle >= 50 (or default to 18%, right when pump hits 0 and recoil kicks at t=20%)
    const shootKf = KING_AND_SHOTGUN_TWEEN.gunKeyframes.find((k) => k.muzzle >= 50);
    const shootPct = shootKf ? shootKf.t : 18;

    if (kingNode && kingImg) {
      kingNode.style.zIndex = '30';
      kingImg.style.transformOrigin = 'center center';
      await new Promise((resolve) => {
        const start = performance.now();
        const step = (now) => {
          const t = Math.min(1, (now - start) / totalDuration);
          const pct = t * 100;
          if (!hasFiredShot && pct >= shootPct) {
            hasFiredShot = true;
            shotFlashUntil = now + 130;
            fireBulletsNow();
          }
          if (t >= 1) {
            kingNode.style.transform = '';
            kingNode.style.zIndex = '';
            kingImg.style.transform = '';
            spawnImpactRing(sf.to, 'rgba(251, 191, 36, .75)');
            resolve();
            return;
          }
          const k = sampleKingTween(pct);
          const kx = (-Math.cos(aimRad) * k.recoil + k.offX) * unitScale;
          const ky = (-Math.sin(aimRad) * k.recoil + k.jumpY) * unitScale;
          const kRot = k.rot * spinSign;

          kingNode.style.transform = `translate(${kx.toFixed(1)}px, ${ky.toFixed(1)}px)`;
          kingImg.style.transform = `rotate(${kRot.toFixed(1)}deg) scale(${k.scaleX.toFixed(3)}, ${k.scaleY.toFixed(3)})`;

          if (rig) {
            const g = sampleGunTween(pct);
            let gx = -Math.cos(aimRad) * g.recoil * unitScale;
            let gy = (-Math.sin(aimRad) * g.recoil + g.offY) * unitScale;
            if (KING_AND_SHOTGUN_TWEEN.followKing) {
              gx += kx;
              gy += ky;
            }
            const gRot = aimDeg + g.rot * flipY;
            rig.style.opacity = g.scale <= 0.02 ? '0' : '1';
            rig.style.transform = `translate(calc(-18% + ${gx.toFixed(1)}px), calc(-50% + ${gy.toFixed(1)}px)) rotate(${gRot.toFixed(1)}deg) scale(${g.scale.toFixed(3)})`;
            if (pumpGrp) {
              const pumpPx = -(g.pump / 100) * 13;
              pumpGrp.setAttribute('transform', `translate(${pumpPx.toFixed(2)}, 0)`);
            }
            if (muzzleGrp) {
              const flashBoost = now < shotFlashUntil ? (shotFlashUntil - now) / 130 : 0;
              const muzAlpha = Math.max(flashBoost, Math.max(0, Math.min(1, g.muzzle / 100)));
              muzzleGrp.style.opacity = muzAlpha.toFixed(2);
              muzzleGrp.style.transform = `scale(${(0.5 + muzAlpha * 0.7).toFixed(2)})`;
            }
          }
          requestAnimationFrame(step);
        };
        requestAnimationFrame(step);
      });
    } else {
      await wait(totalDuration);
    }

    if (!hasFiredShot) fireBulletsNow();
    await wait(240);
  }

  function handleShotgun(s) {
    if (!s.shotgunFire) return false;
    if (lastShotgunId === s.shotgunFire.id) return false;
    lastShotgunId = s.shotgunFire.id;

    (async () => {
      isAnimatingCards = true;
      await playShotgunSequence(s.shotgunFire);
      displayBoard = null;
      isAnimatingCards = false;
      if (S.lmsActive) LMS.start();
      else LMS.stop();
      render();
      handleGameOver(S);
    })();
    return true;
  }

  function handleEffects(s) {
    if (!s.effects) return false;
    if (lastEffectsId === s.effects.id) return false;
    lastEffectsId = s.effects.id;

    // Track chronological board dimensions & event statuses during card VFX
    const has4D = s.effects.list.some((ef) => ef.card && ef.card.id === 'fourDimLayer');
    currentEffectFourDim = has4D ? false : !!(s.status && s.status.fourDim);

    const ehEffect = s.effects.list.find((ef) => ef.card && ef.card.id === 'eventHorizon');
    if (ehEffect) {
      currentEffectEventHorizon = ehEffect.eventHorizonAction === 'cleared' ? 10 : 0;
    } else {
      currentEffectEventHorizon = s.status && s.status.eventHorizon ? s.status.eventHorizon : 0;
    }

    eventHorizonPendingCut = !!ehEffect && ehEffect.eventHorizonAction !== 'cleared';
    if (eventHorizonPendingCut) {
      const wrap = $('boardWrap');
      if (wrap) wrap.classList.remove('eh-active');
      const layer = $('vfxLayer');
      const bar = layer ? layer.querySelector('.eh-barrier') : null;
      if (bar) bar.remove();
    }

    (async () => {
      isAnimatingCards = true;
      for (let i = 0; i < s.effects.list.length; i++) {
        const e = s.effects.list[i];
        showProfileCardIcon(e.color, e.card);
        if (e.card.rarity === 'legendary') SFX.legendary();
        await playSingleCardVFX(e);
        await wait(250);
      }
      displayBoard = null;
      isAnimatingCards = false;
      currentEffectFourDim = !!(S.status && S.status.fourDim);
      currentEffectEventHorizon = S.status && S.status.eventHorizon ? S.status.eventHorizon : 0;
      if (S.lmsActive) LMS.start();
      else LMS.stop();
      render();
      handleGameOver(S);
    })();
    return true;
  }

  async function playFourDimUnmergeAnimation(u) {
    const wrap = $('boardWrap');
    const boardEl = $('board');
    if (!boardEl) return;

    isAnimatingFourDim = true;
    displayBoard = u.after ? u.after.map((p) => (p ? { ...p } : null)) : null;
    renderBoard(displayBoard, true);

    if (wrap) {
      wrap.classList.add('four-dim-active');
      wrap.classList.add('slicing');
    }

    const fl = flipped();
    const bs = boardEl.getBoundingClientRect().width || 640;

    // Start with the squares placed in the stacked 4D configuration at 25% opacity
    boardEl.querySelectorAll('.sq').forEach((cell) => {
      const sq = Number(cell.dataset.sq);
      const r = sq >> 3;
      const f = sq & 7;
      const qr = r >= 4 ? 1 : 0;
      const qf = f >= 4 ? 1 : 0;
      const oldQ = qr * 2 + qf;
      const tf = get4DTransform(r, f, fl, bs);
      cell.classList.add('quad-cut');
      cell.style.zIndex = String(10 + oldQ);
      cell.style.transform = `translate(${tf.dx.toFixed(1)}px, ${tf.dy.toFixed(1)}px) scale(2)`;
    });
    boardEl.querySelectorAll('.piece img').forEach((img) => {
      img.style.opacity = '0.25';
    });
    void boardEl.offsetHeight;

    // Dimensional rift instability sound
    SFX.charge();
    await wait(280);

    // Space unfolds: the 4 quadrants glide apart to their normal 8x8 slots, restoring 100% opacity
    SFX.dash();
    boardEl.querySelectorAll('.sq').forEach((cell) => {
      cell.style.transition = 'transform 650ms cubic-bezier(0.16, 1, 0.3, 1)';
      cell.style.transform = 'translate(0px, 0px) scale(1)';
    });
    boardEl.querySelectorAll('.piece img').forEach((img) => {
      img.style.transition = 'opacity 650ms ease';
      img.style.opacity = '1';
    });
    await wait(660);

    if (wrap) {
      wrap.classList.remove('slicing');
      wrap.classList.remove('four-dim-active');
    }
    isAnimatingFourDim = false;
    displayBoard = null;
    renderBoard();
    SFX.slam();
    await shakeElement(wrap, 700, 14, 'hard-to-soft');
  }

  function handleFourDimUnmerge(s) {
    if (!s.fourDimUnmerge) return false;
    if (lastFourDimUnmergeId === s.fourDimUnmerge.id) return false;
    lastFourDimUnmergeId = s.fourDimUnmerge.id;

    (async () => {
      isAnimatingCards = true;
      await playFourDimUnmergeAnimation(s.fourDimUnmerge);
      displayBoard = null;
      isAnimatingCards = false;
      if (S.lmsActive) LMS.start();
      else LMS.stop();
      render();
      handleGameOver(S);
    })();
    return true;
  }

  function handleNotice(s) {
    if (!s.notice) return;
    if (lastNoticeId === s.notice.id) return;
    const first = lastNoticeId === null && s.moves.length > 0;
    lastNoticeId = s.notice.id;
    if (first) return;
    toast('📣', s.notice.text, '', 'common', 3000);
  }

  function toast(icon, title, msg, rarity, ms) {
    const t = document.createElement('div');
    t.className = `toast ${rarity}`;
    t.innerHTML = `<div class="ticon">${icon}</div><div><div class="ttitle">${esc(title)}</div>${msg ? `<div class="tmsg">${esc(msg)}</div>` : ''}</div>`;
    $('toasts').appendChild(t);
    setTimeout(() => {
      t.classList.add('out');
      setTimeout(() => t.remove(), 450);
    }, ms);
  }

  // ---------------- game over ----------------
  function resultText(r) {
    if (!r) return { title: '', reason: '' };
    const reason = { checkmate: 'by checkmate', 'king captured': 'king captured!', resignation: 'by resignation', abandonment: 'opponent abandoned', stalemate: 'by stalemate', agreement: 'by agreement', '50-move rule': 'by 50-move rule', 'threefold repetition': 'by repetition', 'insufficient material': 'insufficient material' }[r.reason] || r.reason;
    if (!r.winner) return { title: '🤝 Draw', reason, icon: '🤝' };
    return r.winner === S.you ? { title: '🏆 You won!', reason, icon: '🏆', win: true } : { title: '💀 You lost', reason, icon: '💀' };
  }

  function handleGameOver(s) {
    if (isAnimatingCards || s.phase !== 'over' || !s.result) return;
    const key = s.result.winner + s.result.reason + s.moves.length;
    if (key !== lastResultKey) {
      lastResultKey = key;
      modalDismissed = false;
      const rt = resultText(s.result);
      if (rt.win) SFX.win();
      else if (s.result.winner) SFX.lose();
    }
    if (modalDismissed) return;
    const rt = resultText(s.result);
    const m = $('modal');
    m.classList.remove('hidden');
    const oppWants = s.rematch[opp(s.you)];
    m.innerHTML = `
      <div class="modal-box">
        <button class="close" id="closeModal">✕</button>
        <div class="trophy">${rt.icon}</div>
        <h2>${rt.title.replace(/^\S+\s/, '')}</h2>
        <div class="reason">${esc(rt.reason)}</div>
        <div class="row">
          <button class="btn btn-green" id="mRematch" ${s.rematch[s.you] ? 'disabled' : ''}>${s.rematch[s.you] ? '⏳ Waiting…' : oppWants ? '↻ Accept Rematch' : '↻ Rematch'}</button>
          <button class="btn btn-gray" id="mLeave">New Room</button>
        </div>
        <div class="sub">${oppWants && !s.rematch[s.you] ? 'Opponent wants a rematch!' : ''}</div>
      </div>`;
    $('closeModal').onclick = () => {
      modalDismissed = true;
      m.classList.add('hidden');
    };
    $('mRematch').onclick = () => socket.emit('rematch');
    $('mLeave').onclick = leaveRoom;
  }

  // ---------------- buttons ----------------
  $('drawBtn').onclick = () => socket.emit('offerDraw');
  $('resignBtn').onclick = () => {
    if (confirm('Are you sure you want to resign?')) socket.emit('resign');
  };
  $('flipBtn').onclick = () => {
    userFlip = !userFlip;
    render();
  };
  $('soundBtn').onclick = () => {
    soundOn = !soundOn;
    localStorage.setItem('sbc_sound', soundOn ? 'on' : 'off');
    $('soundBtn').textContent = soundOn ? '🔊' : '🔇';
    LMS.syncVolume();
  };
  $('claimBtn').onclick = () => socket.emit('claimWin');
  $('rematchBtn').onclick = () => socket.emit('rematch');
  if ($('skipCardsBtn')) $('skipCardsBtn').onclick = () => socket.emit('skipToCards');
  if ($('testCardBtn')) $('testCardBtn').onclick = () => openDebugCardModal();
  if ($('forceLmsBtn')) $('forceLmsBtn').onclick = () => socket.emit('forceLastKing');

  function openDebugCardModal() {
    const allCards = (S && S.allCards) || [];
    if (!allCards.length) return;
    const m = $('debugCardModal');
    m.classList.remove('hidden');
    m.innerHTML = `
      <div class="modal-box debug-modal-box">
        <button class="close" id="closeDebugModal">✕</button>
        <h2>🧪 Test Any Card Immediately</h2>
        <div class="reason">Click any card below to cast it right now as your color (${S.you === 'w' ? 'White' : 'Black'}):</div>
        <div class="debug-card-grid">
          ${allCards
            .map(
              (c) => `
            <button class="debug-card-item ${c.rarity}" data-id="${c.id}">
              <div class="dc-top">
                <span class="dc-icon">${c.icon}</span>
                <span class="dc-rarity">${c.rarity}</span>
              </div>
              <div class="dc-name">${esc(c.name)}</div>
              <div class="dc-desc">${esc(c.desc)}</div>
            </button>`
            )
            .join('')}
        </div>
      </div>`;
    $('closeDebugModal').onclick = () => m.classList.add('hidden');
    m.onclick = (e) => {
      if (e.target === m) m.classList.add('hidden');
    };
    m.querySelectorAll('.debug-card-item').forEach((btn) => {
      btn.onclick = () => {
        m.classList.add('hidden');
        socket.emit('testCard', btn.dataset.id);
      };
    });
  }

  $('leaveBtn').onclick = () => {
    if (S && S.phase !== 'over' && S.phase !== 'waiting' && !confirm('Leave this game? You can rejoin with the Room ID.')) return;
    leaveRoom();
  };
  function leaveRoom() {
    socket.emit('leaveRoom');
    sessionStorage.removeItem('sbc_room');
    showLobby();
  }
  function copy(text, label) {
    (navigator.clipboard ? navigator.clipboard.writeText(text) : Promise.reject()).then(
      () => toast('📋', `${label} copied!`, text, 'common', 2000),
      () => prompt(`Copy this ${label}:`, text)
    );
  }
  const inviteLink = () => `${location.origin}/?room=${S.code}`;
  $('copyCodeBtn').onclick = () => copy(S.code, 'Room ID');
  $('copyCodeBtn2').onclick = () => copy(S.code, 'Room ID');
  $('copyLinkBtn').onclick = () => copy(inviteLink(), 'Invite link');
  $('chatForm').onsubmit = (e) => {
    e.preventDefault();
    const v = $('chatInput').value.trim();
    if (v) socket.emit('chat', v);
    $('chatInput').value = '';
  };
  window.addEventListener('resize', () => S && render());
})();
