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
  let currentUser = null;

  let S = null; // latest state from server
  let userFlip = false;
  let selected = null;
  let drag = null;
  let lastEffectsId = null;
  let lastShotgunId = null;
  let lastNoticeId = null;
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
    dog_spawn: () => {
      noise(1.2, 0.8);
      tone(60, 1.5, 'sawtooth', 0.4);
      tone(40, 2.0, 'sine', 0.5, 0.2);
    },
    dog_rift: () => {
      noise(0.6, 0.5);
      tone(350, 0.4, 'triangle', 0.3);
      tone(180, 0.6, 'sine', 0.35, 0.1);
    },
    dog_attack: () => {
      noise(0.8, 0.9);
      tone(120, 0.5, 'sawtooth', 0.5);
      tone(45, 0.8, 'sine', 0.6, 0.05);
    },
    dog_warn: () => {
      tone(880, 0.15, 'square', 0.25);
      tone(440, 0.25, 'sawtooth', 0.3, 0.1);
    },
    dog_hit: () => {
      noise(0.25, 0.6);
      tone(220, 0.2, 'sawtooth', 0.35);
      tone(90, 0.3, 'triangle', 0.4, 0.05);
    },
    dog_death: () => {
      noise(1.8, 0.8);
      tone(150, 1.2, 'sawtooth', 0.5);
      tone(50, 2.0, 'sine', 0.6, 0.3);
    },
    dog_death_impact: () => {
      noise(1.5, 1.0);
      tone(40, 2.5, 'sine', 0.8);
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

  // ---------------- Devourer of Gods Boss Music (dog_music.mp3 - Scourge of the Universe) ----------------
  const DOG_BGM = {
    active: false,
    audio: null,
    fadeTimer: null,
    start() {
      if (this.active) return;
      this.active = true;
      if (this.fadeTimer) {
        clearInterval(this.fadeTimer);
        this.fadeTimer = null;
      }
      try {
        const a = new Audio('sounds/dog_music.mp3');
        a.loop = true;
        a.volume = soundOn ? 0.75 : 0;
        this.audio = a;
        a.play().catch(() => {});
      } catch { /* ignore */ }
    },
    syncVolume() {
      if (this.audio) this.audio.volume = soundOn ? 0.75 : 0;
    },
    stop(immediate = false) {
      if (!this.active && !this.audio) return;
      this.active = false;
      if (this.fadeTimer) {
        clearInterval(this.fadeTimer);
        this.fadeTimer = null;
      }
      if (!this.audio) return;
      if (immediate || !soundOn) {
        this.audio.pause();
        this.audio = null;
        return;
      }
      // Smooth fade-out over ~1.2s upon boss defeat
      const a = this.audio;
      this.fadeTimer = setInterval(() => {
        if (!a) {
          clearInterval(this.fadeTimer);
          return;
        }
        if (a.volume > 0.06) {
          a.volume = Math.max(0, a.volume - 0.06);
        } else {
          clearInterval(this.fadeTimer);
          this.fadeTimer = null;
          a.pause();
          if (this.audio === a) this.audio = null;
        }
      }, 70);
    },
  };

  // ---------------- Devourer of Gods Serpentine Canvas Physics & Animation ----------------
  const DogWorm = {
    canvas: null,
    ctx: null,
    active: false,
    mode: 'idle', // 'idle' | 'coiling' | 'exiting_expo'
    segments: [], // 28 segments: { x, y, angle }
    headImg: null,
    bodyImg: null,
    tailImg: null,
    imagesLoaded: false,
    raf: 0,
    lastTime: 0,

    // Dynamic boundary steering & coiling parameters
    coilCenter: { x: 240, y: 240 },
    coilRadiusX: 110,
    coilRadiusY: 80,
    currentRegionKey: '',

    // Rushing waypoints parameters (for full 28-segment fast rushes)
    rushWaypointsList: [],
    rushIndex: 0,
    rushSpeed: 1400,
    onSquareHitCallback: null,
    hitSquaresSet: new Set(),
    rushPromiseResolve: null,
    rushDoneHeading: 0,

    // Path history trail buffer for offset sequence following
    trail: [],
    totalHeadDist: 0,

    // Entry from random direction parameters
    entryTarget: { x: 0, y: 0 },
    entrySpeed: 950,
    enterPromiseResolve: null,

    // Exit parameters ("face where the head is looking at and then ease expo in out of the board")
    exitStartTime: 0,
    exitDuration: 850, // ms
    exitHeading: 0,

    init() {
      this.canvas = $('dogCanvas');
      if (!this.canvas) return;
      this.ctx = this.canvas.getContext('2d');
      this.loadSprites();
      if (!this.segments.length) this.initSegments(28);
    },

    initTrail(x, y, angle) {
      this.trail = [];
      const SPACING = 14;
      const totalDist = (this.segments.length + 8) * SPACING;
      const steps = 80;
      for (let s = 0; s <= steps; s++) {
        const d = totalDist * (1 - s / steps);
        this.trail.push({
          x: x - Math.cos(angle) * d,
          y: y - Math.sin(angle) * d,
          angle: angle,
          dist: -d,
        });
      }
      this.totalHeadDist = 0;
    },

    loadSprites() {
      if (this.imagesLoaded) return;
      let count = 0;
      const done = () => {
        count++;
        if (count === 3) this.imagesLoaded = true;
      };
      this.headImg = new Image();
      this.headImg.onload = done;
      this.headImg.src = 'dog/head.png';

      this.bodyImg = new Image();
      this.bodyImg.onload = done;
      this.bodyImg.src = 'dog/body.png';

      this.tailImg = new Image();
      this.tailImg.onload = done;
      this.tailImg.src = 'dog/tail.png';
    },

    initSegments(num = 28) {
      this.segments = [];
      for (let i = 0; i < num; i++) {
        this.segments.push({ x: -300, y: -300, angle: 0 });
      }
    },

    resize() {
      if (!this.canvas) return;
      const rect = this.canvas.getBoundingClientRect();
      const dpr = window.devicePixelRatio || 1;
      const w = Math.round(rect.width || 480);
      const h = Math.round(rect.height || 480);
      if (this.canvas.width !== Math.round(w * dpr) || this.canvas.height !== Math.round(h * dpr)) {
        this.canvas.width = Math.round(w * dpr);
        this.canvas.height = Math.round(h * dpr);
      }
      if (this.ctx) {
        this.ctx.setTransform(1, 0, 0, 1, 0, 0);
        this.ctx.scale(dpr, dpr);
      }
    },

    startCoiling(regionSquares) {
      if (!regionSquares || !regionSquares.length) return Promise.resolve();
      const regionKey = regionSquares.slice().sort().join(',');
      const isNewRegion = this.currentRegionKey !== regionKey;
      if ((this.mode === 'coiling' || this.mode === 'entering_coil') && !isNewRegion) {
        return Promise.resolve();
      }
      return this.enterCoiling(regionSquares);
    },

    enterCoiling(regionSquares) {
      if (!regionSquares || !regionSquares.length) return Promise.resolve();
      this.init();
      this.resize();
      const rect = this.canvas ? this.canvas.getBoundingClientRect() : { width: 480, height: 480 };
      const W = rect.width || 480;
      const H = rect.height || 480;
      const sqW = W / 8;
      const sqH = H / 8;
      const fl = flipped();

      // Compute center and bounds of region squares
      let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
      const tileCoords = regionSquares.map((sq) => {
        const c = sq & 7;
        const r = sq >> 3;
        const gc = fl ? 7 - c : c;
        const gr = fl ? r : 7 - r;
        const px = gc * sqW + sqW / 2;
        const py = gr * sqH + sqH / 2;
        minX = Math.min(minX, px);
        maxX = Math.max(maxX, px);
        minY = Math.min(minY, py);
        maxY = Math.max(maxY, py);
        return { sq, px, py };
      });

      this.coilCenter = { x: (minX + maxX) / 2, y: (minY + maxY) / 2 };
      this.coilRadiusX = Math.max(sqW * 0.9, (maxX - minX) / 2 + sqW * 0.25);
      this.coilRadiusY = Math.max(sqH * 0.9, (maxY - minY) / 2 + sqH * 0.25);
      this.currentRegionKey = regionSquares.slice().sort().join(',');

      // Pick a random target tile from the curling region ("into a part of the tiles")
      const targetTile = tileCoords[Math.floor(Math.random() * tileCoords.length)];

      // Pick a random direction from which to enter
      const randomAngle = Math.random() * Math.PI * 2;
      const D = 380; // Distance off-board
      const startX = targetTile.px - Math.cos(randomAngle) * D;
      const startY = targetTile.py - Math.sin(randomAngle) * D;

      return new Promise((resolve) => {
        let resolved = false;
        const finish = () => {
          if (resolved) return;
          resolved = true;
          this.enterPromiseResolve = null;
          clearTimeout(timeoutId);
          resolve();
        };
        const timeoutId = setTimeout(finish, 2500);

        this.mode = 'entering_coil';
        this.entryTarget = { x: targetTile.px, y: targetTile.py };
        this.entrySpeed = 950; // px/sec fast, smooth swoop into the tiles
        this.enterPromiseResolve = finish;

        const head = this.segments[0];
        head.x = startX;
        head.y = startY;
        head.angle = randomAngle;

        this.initTrail(startX, startY, randomAngle);
        const SPACING = 14;
        for (let i = 1; i < this.segments.length; i++) {
          this.segments[i].x = startX - Math.cos(randomAngle) * (i * SPACING);
          this.segments[i].y = startY - Math.sin(randomAngle) * (i * SPACING);
          this.segments[i].angle = randomAngle;
        }

        SFX.dog_rift();
        this.startLoop();
      });
    },

    rushWaypoints(waypoints, speed = 1400, onSquareHit = null) {
      if (!waypoints || waypoints.length < 2) return Promise.resolve();
      this.init();
      this.resize();
      return new Promise((resolve) => {
        let resolved = false;
        const finish = () => {
          if (resolved) return;
          resolved = true;
          this.mode = 'idle';
          clearTimeout(timeoutId);
          resolve();
        };
        const timeoutId = setTimeout(finish, 3500);

        this.mode = 'rushing';
        this.rushWaypointsList = waypoints;
        this.rushIndex = 0;
        this.rushSpeed = speed;
        this.onSquareHitCallback = onSquareHit;
        this.hitSquaresSet = new Set();
        this.rushPromiseResolve = finish;

        const p0 = waypoints[0];
        const p1 = waypoints[1];
        const initAngle = Math.atan2(p1.y - p0.y, p1.x - p0.x);
        const head = this.segments[0];
        head.x = p0.x;
        head.y = p0.y;
        head.angle = initAngle;
        this.rushDoneHeading = initAngle;

        this.initTrail(p0.x, p0.y, initAngle);
        const SPACING = 14;
        for (let i = 1; i < this.segments.length; i++) {
          this.segments[i].x = p0.x - Math.cos(initAngle) * (i * SPACING);
          this.segments[i].y = p0.y - Math.sin(initAngle) * (i * SPACING);
          this.segments[i].angle = initAngle;
        }

        this.startLoop();
      });
    },

    triggerExpoExit() {
      if (this.mode === 'exiting_expo' || this.mode === 'idle') return;
      this.mode = 'exiting_expo';
      this.exitStartTime = performance.now();
      const head = this.segments[0];
      // Face where the head is currently looking at!
      this.exitHeading = head.angle;
      SFX.dog_rift();
    },

    startLoop() {
      if (this.active) return;
      this.active = true;
      this.lastTime = performance.now();
      const tick = (now) => {
        if (!this.active) return;
        const dt = Math.min(0.06, (now - this.lastTime) / 1000);
        this.lastTime = now;
        this.update(dt, now);
        this.draw();
        this.raf = requestAnimationFrame(tick);
      };
      this.raf = requestAnimationFrame(tick);
    },

    stop() {
      this.active = false;
      this.mode = 'idle';
      this.currentRegionKey = '';
      this.trail = [];
      this.totalHeadDist = 0;
      this.enterPromiseResolve = null;
      cancelAnimationFrame(this.raf);
      if (this.ctx && this.canvas) {
        const rect = this.canvas.getBoundingClientRect();
        this.ctx.clearRect(0, 0, rect.width || 480, rect.height || 480);
      }
    },

    update(dt, now) {
      if (this.mode === 'idle') return;
      const head = this.segments[0];
      const oldHeadX = head.x;
      const oldHeadY = head.y;

      if (this.mode === 'coiling') {
        const speed = 80; // px/sec: moves slowly in the curling stage
        head.x += Math.cos(head.angle) * speed * dt;
        head.y += Math.sin(head.angle) * speed * dt;

        // Progressive edge-proximity steering: the closer it is to the edges of the region, the faster it turns
        const dx = (head.x - this.coilCenter.x) / this.coilRadiusX;
        const dy = (head.y - this.coilCenter.y) / this.coilRadiusY;
        const distNorm = Math.hypot(dx, dy);

        const edgeCloseness = Math.max(0, (distNorm - 0.30) / 0.70);
        if (edgeCloseness > 0.01) {
          const targetAngle = Math.atan2(this.coilCenter.y - head.y, this.coilCenter.x - head.x);
          let diff = targetAngle - head.angle;
          diff = Math.atan2(Math.sin(diff), Math.cos(diff));

          const extraOut = Math.max(0, distNorm - 1.0);
          const turnRate = Math.min(18.0, 1.8 * edgeCloseness + 14.0 * Math.pow(edgeCloseness, 2.2) + extraOut * 28.0);
          const turnStep = Math.sign(diff) * Math.min(Math.abs(diff), turnRate * dt);
          head.angle += turnStep;
        } else {
          // Inside central region: slow, smooth natural slither wave
          head.angle += Math.sin(now * 0.0022) * 0.38 * dt;
        }
      } else if (this.mode === 'entering_coil') {
        const dx = this.entryTarget.x - head.x;
        const dy = this.entryTarget.y - head.y;
        const dist = Math.hypot(dx, dy);
        const step = this.entrySpeed * dt;
        if (dist <= step) {
          head.x = this.entryTarget.x;
          head.y = this.entryTarget.y;
          this.mode = 'coiling';
          SFX.dash();
          if (this.enterPromiseResolve) {
            const r = this.enterPromiseResolve;
            this.enterPromiseResolve = null;
            r();
          }
        } else {
          head.x += Math.cos(head.angle) * step;
          head.y += Math.sin(head.angle) * step;
          if (Math.random() < 0.25) {
            const rect = this.canvas ? this.canvas.getBoundingClientRect() : { width: 480, height: 480 };
            const W = rect.width || 480, H = rect.height || 480;
            if (head.x >= 0 && head.x <= W && head.y >= 0 && head.y <= H) {
              const sqW = W / 8, sqH = H / 8;
              const gc = Math.floor(head.x / sqW);
              const gr = Math.floor(head.y / sqH);
              const fl = flipped();
              const c = fl ? 7 - gc : gc;
              const r = fl ? gr : 7 - gr;
              const sq = r * 8 + c;
              if (sq >= 0 && sq < 64) spawnStarlightDust(sq, 2);
            }
          }
        }
      } else if (this.mode === 'rushing') {
        const target = this.rushWaypointsList[this.rushIndex + 1];
        if (target) {
          const dx = target.x - head.x;
          const dy = target.y - head.y;
          const dist = Math.hypot(dx, dy);
          const step = this.rushSpeed * dt;
          if (dist <= step) {
            head.x = target.x;
            head.y = target.y;
            this.rushIndex++;
            if (this.rushIndex < this.rushWaypointsList.length - 1) {
              const nextTarget = this.rushWaypointsList[this.rushIndex + 1];
              head.angle = Math.atan2(nextTarget.y - head.y, nextTarget.x - head.x);
              this.rushDoneHeading = head.angle;
            } else {
              this.rushDoneHeading = head.angle;
            }
          } else {
            const angle = Math.atan2(dy, dx);
            head.angle = angle;
            head.x += Math.cos(angle) * step;
            head.y += Math.sin(angle) * step;
          }
        } else {
          // Finished waypoints: move head forward until tail clears the board
          const step = this.rushSpeed * dt;
          const heading = this.rushDoneHeading || head.angle;
          head.x += Math.cos(heading) * step;
          head.y += Math.sin(heading) * step;
          head.angle = heading;

          const rect = this.canvas ? this.canvas.getBoundingClientRect() : { width: 480, height: 480 };
          const W = rect.width || 480, H = rect.height || 480;
          const tail = this.segments[this.segments.length - 1];
          const cosH = Math.cos(heading);
          const sinH = Math.sin(heading);
          let tailCleared = false;
          if (cosH > 0.3 && tail.x > W + 140) tailCleared = true;
          if (cosH < -0.3 && tail.x < -140) tailCleared = true;
          if (sinH > 0.3 && tail.y > H + 140) tailCleared = true;
          if (sinH < -0.3 && tail.y < -140) tailCleared = true;
          if (tailCleared) {
            this.mode = 'idle';
            if (this.rushPromiseResolve) {
              const r = this.rushPromiseResolve;
              this.rushPromiseResolve = null;
              r();
            }
          }
        }

        // Trigger onSquareHit when head passes over board squares with ray interpolation for fast dashes
        if (this.onSquareHitCallback) {
          const rect = this.canvas ? this.canvas.getBoundingClientRect() : { width: 480, height: 480 };
          const W = rect.width || 480, H = rect.height || 480;
          const sqW = W / 8, sqH = H / 8;
          const fl = flipped();
          const checkPoint = (px, py) => {
            if (px >= 0 && px <= W && py >= 0 && py <= H) {
              const gc = Math.floor(px / sqW);
              const gr = Math.floor(py / sqH);
              const c = fl ? 7 - gc : gc;
              const r = fl ? gr : 7 - gr;
              const sq = r * 8 + c;
              if (sq >= 0 && sq < 64 && !this.hitSquaresSet.has(sq)) {
                this.hitSquaresSet.add(sq);
                this.onSquareHitCallback(sq);
              }
            }
          };
          const moveDist = Math.hypot(head.x - oldHeadX, head.y - oldHeadY);
          const steps = Math.max(1, Math.ceil(moveDist / 12));
          for (let s = 1; s <= steps; s++) {
            const frac = s / steps;
            checkPoint(oldHeadX + frac * (head.x - oldHeadX), oldHeadY + frac * (head.y - oldHeadY));
          }
        }
      } else if (this.mode === 'exiting_expo') {
        const elapsed = now - this.exitStartTime;
        const p = Math.min(1.0, elapsed / this.exitDuration);
        // Exponential ease-in: p === 0 ? 0 : Math.pow(2, 10 * (p - 1))
        const ease = p === 0 ? 0 : Math.pow(2, 10 * (p - 1));
        const currentSpeed = 160 + ease * 2500;
        head.x += Math.cos(this.exitHeading) * currentSpeed * dt;
        head.y += Math.sin(this.exitHeading) * currentSpeed * dt;
        head.angle = this.exitHeading;

        const rect = this.canvas ? this.canvas.getBoundingClientRect() : { width: 480, height: 480 };
        const W = rect.width || 480;
        const H = rect.height || 480;
        const margin = 140;
        const tail = this.segments[this.segments.length - 1];
        const cosE = Math.cos(this.exitHeading);
        const sinE = Math.sin(this.exitHeading);
        let tailCleared = false;
        if (cosE > 0.3 && tail.x > W + margin) tailCleared = true;
        if (cosE < -0.3 && tail.x < -margin) tailCleared = true;
        if (sinE > 0.3 && tail.y > H + margin) tailCleared = true;
        if (sinE < -0.3 && tail.y < -margin) tailCleared = true;
        if (tailCleared) {
          this.stop();
          return;
        }
      }

      // Offset sequence follower: each segment traces the exact trajectory of the head, offset in sequence
      const SPACING = 14;
      const moved = Math.hypot(head.x - oldHeadX, head.y - oldHeadY);
      if (moved > 0.0001) {
        this.totalHeadDist += moved;
        this.trail.unshift({
          x: head.x,
          y: head.y,
          angle: head.angle,
          dist: this.totalHeadDist,
        });

        // Trim trail points older than the tail
        const tailTargetDist = this.totalHeadDist - (this.segments.length + 4) * SPACING;
        while (this.trail.length > 50 && this.trail[this.trail.length - 2].dist < tailTargetDist) {
          this.trail.pop();
        }
      }

      // Position each segment along the head's recorded path offset by i * SPACING
      let j = 0;
      for (let i = 1; i < this.segments.length; i++) {
        const targetDist = this.totalHeadDist - i * SPACING;
        while (j < this.trail.length - 2 && this.trail[j + 1].dist > targetDist) {
          j++;
        }
        const pA = this.trail[j];
        const pB = this.trail[j + 1];
        const span = pA.dist - pB.dist;
        const t = span > 0.0001 ? Math.max(0, Math.min(1, (targetDist - pB.dist) / span)) : 0;
        const cur = this.segments[i];
        cur.x = pB.x + t * (pA.x - pB.x);
        cur.y = pB.y + t * (pA.y - pB.y);

        let diff = pA.angle - pB.angle;
        diff = Math.atan2(Math.sin(diff), Math.cos(diff));
        cur.angle = pB.angle + t * diff;
      }
    },

    draw() {
      if (!this.ctx || !this.canvas) return;
      const rect = this.canvas.getBoundingClientRect();
      const W = rect.width || 480;
      const H = rect.height || 480;
      this.ctx.clearRect(0, 0, W, H);
      if (this.mode === 'idle') return;

      // Draw segments in reverse so head is always in front
      for (let i = this.segments.length - 1; i >= 0; i--) {
        const seg = this.segments[i];
        this.ctx.save();
        this.ctx.translate(seg.x, seg.y);
        // Calamity pixel sprites naturally face North (upward, -Y).
        // Since motion angle theta is 0 for East (+X), rotate by theta + PI/2.
        this.ctx.rotate(seg.angle + Math.PI / 2);

        let img = this.bodyImg;
        let w = 34, h = 24;
        if (i === 0) {
          img = this.headImg;
          w = 38; h = 44;
        } else if (i === this.segments.length - 1) {
          img = this.tailImg;
          w = 30; h = 28;
        } else {
          const taper = 1.0 - (i / this.segments.length) * 0.18;
          w = Math.round(w * taper);
          h = Math.round(h * taper);
        }

        if (img && img.complete) {
          this.ctx.shadowColor = '#38bdf8';
          this.ctx.shadowBlur = i === 0 ? 10 : 5;
          this.ctx.drawImage(img, -w / 2, -h / 2, w, h);
        }
        this.ctx.restore();
      }
    },
  };
  DogWorm.init();

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
    if (currentUser && currentUser.username) {
      return currentUser.username;
    }
    const n = $('nameInput').value.trim() || 'Player' + Math.floor(Math.random() * 900 + 100);
    localStorage.setItem('sbc_name', n);
    return n;
  }

  function setCurrentUser(user) {
    if (!user) {
      currentUser = null;
      try { localStorage.removeItem('sbc_user'); } catch {}
      const guestBox = $('accountGuestBox');
      const userBox = $('accountUserBox');
      if (guestBox) guestBox.classList.remove('hidden');
      if (userBox) userBox.classList.add('hidden');
      $('nameInput').disabled = false;
      const savedName = localStorage.getItem('sbc_name');
      if (savedName) $('nameInput').value = savedName;
      return;
    }

    // Merge defensively so partial updates never drop skills or equippedSkill
    const prevSkills = (currentUser && currentUser.id === user.id && Array.isArray(currentUser.skills)) ? currentUser.skills : [];
    const prevEquipped = (currentUser && currentUser.id === user.id) ? currentUser.equippedSkill : null;

    const newSkills = Array.isArray(user.skills) && user.skills.length ? user.skills : prevSkills;
    const rawEquipped = user.equippedSkill !== undefined ? user.equippedSkill : prevEquipped;
    const newEquipped = (typeof rawEquipped === 'object' && rawEquipped) ? rawEquipped.id : (rawEquipped || null);

    currentUser = {
      ...user,
      skills: Array.isArray(newSkills) ? [...newSkills] : [],
      equippedSkill: newEquipped,
    };
    try { localStorage.setItem('sbc_user', JSON.stringify(currentUser)); } catch {}

    const guestBox = $('accountGuestBox');
    const userBox = $('accountUserBox');
    if (!guestBox || !userBox) return;

    guestBox.classList.add('hidden');
    userBox.classList.remove('hidden');
    $('accountUsername').textContent = currentUser.username;
    $('accountTitleBadge').textContent = currentUser.customTitle || 'Novice Wizard';
    const stats = currentUser.stats || { wins: 0, losses: 0, draws: 0, winRate: 0 };
    $('statWins').textContent = stats.wins || 0;
    $('statLosses').textContent = stats.losses || 0;
    $('statDraws').textContent = stats.draws || 0;
    $('statWinRate').textContent = stats.winRate || 0;
    if ($('statCoins')) $('statCoins').textContent = currentUser.coins || 0;
    $('nameInput').value = currentUser.username;
    $('nameInput').disabled = true;
  }

  // Restore cached account immediately on load so UI doesn't flicker when reloading/changing files
  try {
    const cachedUser = JSON.parse(localStorage.getItem('sbc_user') || 'null');
    if (cachedUser && cachedUser.username) {
      setCurrentUser(cachedUser);
    }
  } catch {}

  function showAuthTab(tab) {
    const isLogin = tab === 'login';
    const tabLogin = $('tabLoginBtn');
    const tabReg = $('tabRegisterBtn');
    const formLogin = $('loginForm');
    const formReg = $('registerForm');
    if (tabLogin) tabLogin.classList.toggle('active', isLogin);
    if (tabReg) tabReg.classList.toggle('active', !isLogin);
    if (formLogin) formLogin.classList.toggle('hidden', !isLogin);
    if (formReg) formReg.classList.toggle('hidden', isLogin);
    if ($('loginError')) $('loginError').textContent = '';
    if ($('regError')) $('regError').textContent = '';
  }

  // Auth UI Event Listeners
  if ($('openAuthBtn')) {
    $('openAuthBtn').onclick = () => {
      showAuthTab('login');
      $('authModal').classList.remove('hidden');
    };
  }
  if ($('closeAuthBtn')) {
    $('closeAuthBtn').onclick = () => {
      $('authModal').classList.add('hidden');
    };
  }
  if ($('tabLoginBtn')) $('tabLoginBtn').onclick = () => showAuthTab('login');
  if ($('tabRegisterBtn')) $('tabRegisterBtn').onclick = () => showAuthTab('register');

  if ($('loginForm')) {
    $('loginForm').onsubmit = (e) => {
      e.preventDefault();
      if ($('loginError')) $('loginError').textContent = '';
      const username = $('loginUsername').value.trim();
      const password = $('loginPassword').value;
      if (!username || !password) return;
      socket.emit('auth:login', { username, password }, (res) => {
        if (!res || !res.success) {
          if ($('loginError')) $('loginError').textContent = res?.error || 'Login failed.';
          return;
        }
        localStorage.setItem('sbc_auth_token', res.token);
        setCurrentUser(res.user);
        $('authModal').classList.add('hidden');
        $('loginPassword').value = '';
        toast('Logged in as ' + res.user.username, 'Welcome Back', 'epic');
      });
    };
  }

  if ($('registerForm')) {
    $('registerForm').onsubmit = (e) => {
      e.preventDefault();
      if ($('regError')) $('regError').textContent = '';
      const username = $('regUsername').value.trim();
      const password = $('regPassword').value;
      const confirm = $('regConfirm').value;
      if (password !== confirm) {
        if ($('regError')) $('regError').textContent = 'Passwords do not match.';
        return;
      }
      socket.emit('auth:register', { username, password }, (res) => {
        if (!res || !res.success) {
          if ($('regError')) $('regError').textContent = res?.error || 'Registration failed.';
          return;
        }
        localStorage.setItem('sbc_auth_token', res.token);
        setCurrentUser(res.user);
        $('authModal').classList.add('hidden');
        $('regPassword').value = '';
        $('regConfirm').value = '';
        toast('Account created! Welcome, ' + res.user.username + '!', 'Registered', 'legendary');
      });
    };
  }

  if ($('logoutBtn')) {
    $('logoutBtn').onclick = () => {
      const authToken = localStorage.getItem('sbc_auth_token');
      if (authToken) socket.emit('auth:logout', { authToken });
      localStorage.removeItem('sbc_auth_token');
      setCurrentUser(null);
      toast('You have been logged out.', 'Account', 'common');
    };
  }

  // Shop UI Event Listeners & Rendering
  let cachedShopCatalog = [];
  function renderShop(catalog) {
    if (catalog) cachedShopCatalog = catalog;
    const grid = $('shopGrid');
    if (!grid) return;
    $('shopCoinBalance').textContent = currentUser ? (currentUser.coins || 0) : 0;
    grid.innerHTML = '';

    cachedShopCatalog.forEach((card) => {
      const userSkills = (currentUser && Array.isArray(currentUser.skills)) ? currentUser.skills : [];
      const equippedId = currentUser && (typeof currentUser.equippedSkill === 'object' && currentUser.equippedSkill ? currentUser.equippedSkill.id : currentUser.equippedSkill);
      const owned = userSkills.includes(card.id);
      const equipped = equippedId === card.id;
      const canAfford = currentUser && (currentUser.coins || 0) >= card.cost;

      let actionHtml = '';
      if (!currentUser) {
        actionHtml = `<button class="btn btn-purple btn-sm" onclick="document.getElementById('openAuthBtn').click()">Log in to Buy</button>`;
      } else if (equipped) {
        actionHtml = `<span class="equipped-tag">Equipped</span>`;
      } else if (owned) {
        actionHtml = `<button class="btn btn-green btn-sm equip-btn" data-id="${card.id}">Equip</button>`;
      } else {
        actionHtml = `<button class="btn btn-purple btn-sm buy-btn" data-id="${card.id}" ${canAfford ? '' : 'disabled'}>Buy (🪙 ${card.cost})</button>`;
      }

      const item = document.createElement('div');
      item.className = 'shop-item' + (equipped ? ' equipped' : '');
      item.innerHTML = `
        <div class="shop-item-left">
          <div class="shop-item-icon">${card.icon || '🃏'}</div>
          <div class="shop-item-details">
            <div class="shop-item-name">
              <span>${esc(card.name)}</span>
              ${owned ? '<span class="player-stat-tag">✓ Owned</span>' : ''}
            </div>
            <div class="shop-item-desc">${esc(card.desc)}</div>
          </div>
        </div>
        <div class="shop-item-right">
          ${!owned ? `<div class="shop-item-cost">🪙 ${card.cost}</div>` : ''}
          ${actionHtml}
        </div>`;
      grid.appendChild(item);
    });

    grid.querySelectorAll('.buy-btn').forEach((btn) => {
      btn.onclick = () => {
        const skillId = btn.dataset.id;
        socket.emit('shop:buySkill', { skillId }, (res) => {
          if (!res || res.error) {
            toast(res?.error || 'Purchase failed', 'Shop', 'common');
            return;
          }
          setCurrentUser(res.user);
          toast(`Purchased ${res.skill?.name || 'Skill Card'}!`, 'Shop', 'legendary');
          renderShop();
        });
      };
    });

    grid.querySelectorAll('.equip-btn').forEach((btn) => {
      btn.onclick = () => {
        const skillId = btn.dataset.id;
        socket.emit('shop:equipSkill', { skillId }, (res) => {
          if (!res || res.error) {
            toast(res?.error || 'Equip failed', 'Shop', 'common');
            return;
          }
          setCurrentUser(res.user);
          toast('Equipped Skill Card!', 'Shop', 'epic');
          renderShop();
        });
      };
    });
  }

  function openShop() {
    socket.emit('shop:getCatalog', (res) => {
      if (res) {
        if (res.user) setCurrentUser(res.user);
        if (res.catalog) renderShop(res.catalog);
      }
    });
    $('shopModal').classList.remove('hidden');
  }

  if ($('openShopBtn')) $('openShopBtn').onclick = openShop;
  if ($('guestShopBtn')) $('guestShopBtn').onclick = openShop;
  if ($('closeShopBtn')) $('closeShopBtn').onclick = () => $('shopModal').classList.add('hidden');
  if ($('useSkillBtn')) {
    $('useSkillBtn').onclick = () => {
      socket.emit('useSkill', {}, (res) => {
        if (res && res.error) {
          toast('⚠️', res.error, '', 'common', 3000);
        }
      });
    };
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
      authToken: localStorage.getItem('sbc_auth_token') || null,
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
      authToken: localStorage.getItem('sbc_auth_token') || null,
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
    socket.emit('join', {
      code,
      name: getName(),
      token,
      authToken: localStorage.getItem('sbc_auth_token') || null,
    });
  }
  $('joinBtn').onclick = join;
  $('codeInput').addEventListener('keydown', (e) => e.key === 'Enter' && join());
  $('codeInput').addEventListener('input', (e) => (e.target.value = e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, '')));

  preloadAllSounds();

  socket.on('connect', async () => {
    await preloadAllSounds();
    const savedAuthToken = localStorage.getItem('sbc_auth_token');
    if (savedAuthToken) {
      socket.emit('auth:verifyToken', { authToken: savedAuthToken }, (res) => {
        if (res && res.success && res.user) {
          setCurrentUser(res.user);
        } else if (res && res.invalid) {
          localStorage.removeItem('sbc_auth_token');
          setCurrentUser(null);
        }
      });
    }
    const code = sessionStorage.getItem('sbc_room');
    if (code) {
      socket.emit('join', {
        code,
        name: getName(),
        token,
        authToken: localStorage.getItem('sbc_auth_token') || null,
      });
    }
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
      (!s.shotgunFire || s.shotgunFire.id === lastShotgunId)
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
      lastDogDashId = s.dogDash ? s.dogDash.id : null;
      dogDeathHandled = false;
      lastDogHp = s.dog ? s.dog.hp : null;
      eventHorizonPendingCut = false;
      currentEffectEventHorizon = 0;
      lastNoticeId = prev && prev.code === s.code ? lastNoticeId : null;
      lastResultKey = null;
      modalDismissed = false;
      selected = null;
      displayBoard = null;
      isAnimatingCards = false;
      cardUI = { id: null, revealed: false, raf: 0 };
      if (prev && prev.code === s.code) { $('modal').classList.add('hidden'); }
    }
    if (prev && prev.you !== s.you) userFlip = false;
    if (s.legal.length === 0) selected = null;

    if (s.lmsActive) LMS.start();

    // Devourer of Gods BGM (Scourge of the Universe) & Serpentine Animation
    const hasPendingEffects = !!(s.effects && lastEffectsId !== s.effects.id);
    const hasPendingDogDash = !!(s.dogDash && lastDogDashId !== s.dogDash.id);
    const isCardsPendingOrActive = isAnimatingCards || hasPendingEffects || s.phase === 'cards';

    if (s.dog && s.dog.active) {
      DOG_BGM.start();
      if (
        s.dog.phase === 'coiled' &&
        s.dog.segments &&
        s.dog.segments.length > 0 &&
        !isCardsPendingOrActive &&
        !hasPendingDogDash
      ) {
        const regionSquares = s.dog.curlCycle || s.dog.segments.map((seg) => seg.sq);
        DogWorm.startCoiling(regionSquares);
      } else if (s.dog.phase === 'telegraph' && !isCardsPendingOrActive && !hasPendingDogDash) {
        if (DogWorm.mode === 'coiling') {
          DogWorm.triggerExpoExit();
        } else if (DogWorm.mode !== 'exiting_expo') {
          DogWorm.stop();
        }
      }
    } else {
      DOG_BGM.stop();
      DogWorm.stop();
    }

    // Check if DoG just died
    if (s.dog && !s.dog.active && s.dog.phase === 'dead' && !dogDeathHandled) {
      dogDeathHandled = true;
      DOG_BGM.stop();
      DogWorm.stop();
      SFX.dog_death();
      setTimeout(() => SFX.dog_death_impact(), 900);
      shakeElement($('boardWrap'), 1600, 24, 'hard-to-soft');
      document.querySelectorAll('.dog-segment').forEach((el) => {
        el.classList.add('dog-wither-anim');
        const sq = Number(el.closest('.sq')?.dataset?.sq);
        if (!isNaN(sq)) spawnStarlightDust(sq, 20);
      });
    }

    playMoveSounds(s);
    handleCards(s);
    const animStarted = handleShotgun(s) || handleEffects(s) || handleDogDash(s);
    if (!animStarted) {
      if (!s.lmsActive) LMS.stop();
      if (!s.dog || !s.dog.active) {
        DOG_BGM.stop();
        DogWorm.stop();
      }
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
      } else if (m.san && m.san.includes('xDoG')) {
        SFX.dog_hit();
        shakeElement($('boardWrap'), 350, 7, 'hard-to-soft');
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

  let lastDogHp = null;
  function renderDogBossBar() {
    const wrap = $('dogBossWrap');
    if (!wrap) return;
    if (!S || !S.dog || (!S.dog.active && S.dog.phase !== 'dead')) {
      wrap.classList.add('hidden');
      lastDogHp = null;
      return;
    }
    wrap.classList.remove('hidden');
    const d = S.dog;
    const hp = Math.max(0, d.hp);
    const maxHp = d.maxHp || 100;
    const pct = Math.max(0, Math.min(100, (hp / maxHp) * 100));

    const statusEl = $('dogBossStatus');
    if (statusEl) {
      if (d.phase === 'dead') {
        statusEl.textContent = '• WITHERED';
        statusEl.style.color = '#a855f7';
      } else if (d.phase === 'coiled') {
        statusEl.textContent = '• ATTACK NOW!';
        statusEl.style.color = '#ef4444';
      } else if (d.phase === 'telegraph' && d.telegraph) {
        const lane = d.telegraph.type === 'rank' ? `R${d.telegraph.index + 1}` : `F${FILES[d.telegraph.index].toUpperCase()}`;
        statusEl.textContent = `• TARGET: ${lane} (${d.turnsUntilAttack}T)`;
        statusEl.style.color = '#f43f5e';
      } else {
        statusEl.textContent = `• VOID (${d.turnsUntilAttack}T)`;
        statusEl.style.color = '#38bdf8';
      }
    }

    const fillEl = $('dogBossFill');
    const catchupEl = $('dogBossCatchup');
    const textEl = $('dogBossHpText');
    if (fillEl) fillEl.style.width = `${pct}%`;
    if (catchupEl) catchupEl.style.width = `${pct}%`;
    if (textEl) textEl.textContent = `${hp} / ${maxHp}`;

    if (d.lastHit && lastDogHp !== null && d.hp < lastDogHp) {
      const inner = $('dogBossInner');
      if (inner) {
        inner.classList.remove('dog-bar-hit-shake');
        void inner.offsetWidth;
        inner.classList.add('dog-bar-hit-shake');
      }
      spawnFloatingDamage(d.lastHit.sq, d.lastHit.dmg);
    }
    lastDogHp = d.hp;
  }

  function spawnFloatingDamage(sq, dmg) {
    const cell = sqEl(sq);
    if (!cell) return;
    const dmgEl = document.createElement('div');
    dmgEl.className = 'dog-dmg-float';
    dmgEl.textContent = `Hit! -${dmg}`;
    cell.appendChild(dmgEl);
    setTimeout(() => dmgEl.remove(), 1200);
  }

  function render() {
    if (!S) return;
    renderBoard();
    renderDogBossBar();
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
  let ehFlickerTimer = null;
  let ehFlickerRaf = null;
  let ehFlickerActive = false;

  function stopEventHorizonFlicker() {
    ehFlickerActive = false;
    if (ehFlickerTimer) {
      clearTimeout(ehFlickerTimer);
      ehFlickerTimer = null;
    }
    if (ehFlickerRaf) {
      cancelAnimationFrame(ehFlickerRaf);
      ehFlickerRaf = null;
    }
  }

  function startEventHorizonFlicker(bar) {
    stopEventHorizonFlicker();
    const wrap = bar.querySelector('.eh-rects-wrap');
    if (!wrap) return;
    ehFlickerActive = true;

    function step() {
      if (!ehFlickerActive || !bar.isConnected) return;

      // Draw MANY random wide rectangles (3 to 5) every single frame continuously without pausing:
      const numRects = Math.floor(Math.random() * 3) + 3;
      let html = '';
      for (let i = 0; i < numRects; i++) {
        const widthPct = Math.floor(Math.random() * 36) + 50; // 50% to 86% (very wide)
        const maxLeft = Math.max(0, 100 - widthPct);
        const leftPct = Math.floor(Math.random() * (maxLeft + 1));
        const hPx = Math.floor(Math.random() * 16) + 18; // 18px to 34px
        // Random Y offset so each rectangle shifts vertically while staying connected to the middle line (no gap):
        const maxOffsetY = Math.floor((hPx - 8) / 2) + 2;
        const offsetY = Math.floor((Math.random() * 2 - 1) * maxOffsetY);

        html += `<div class="eh-black-rect" style="width:${widthPct}%;left:${leftPct}%;height:${hPx}px;transform:translateY(calc(-50% + ${offsetY}px));"></div>`;
      }
      wrap.innerHTML = html;

      ehFlickerRaf = requestAnimationFrame(step);
    }

    ehFlickerRaf = requestAnimationFrame(step);
  }

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

  function syncEventHorizonBarrier() {
    const wrap = $('boardWrap');
    const layer = $('vfxLayer');
    if (isAnimatingEventHorizon || eventHorizonPendingCut) {
      if (wrap) wrap.classList.remove('eh-active');
      const bar = layer ? layer.querySelector('.eh-barrier') : null;
      if (bar) bar.remove();
      stopEventHorizonFlicker();
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
        bar.innerHTML = `
          <div class="eh-black-line"></div>
          <div class="eh-rects-wrap"></div>
          <span class="eh-turns" title="Event Horizon: ${turns} turn${turns === 1 ? '' : 's'} remaining">${turns}</span>
        `;
        layer.appendChild(bar);
        startEventHorizonFlicker(bar);
      } else {
        const turnsEl = bar.querySelector('.eh-turns');
        if (turnsEl) {
          turnsEl.textContent = String(turns);
          turnsEl.title = `Event Horizon: ${turns} turn${turns === 1 ? '' : 's'} remaining`;
        }
      }
    } else if (bar) {
      bar.remove();
      stopEventHorizonFlicker();
    }
  }

  function positionDogLaneElement(el, tele, fl, badgeText) {
    if (!el || !tele) return;
    if (tele.type === 'rank') {
      const gr = fl ? tele.index : 7 - tele.index;
      el.className = 'dog-telegraph-lane';
      el.style.top = (gr * 12.5) + '%';
      el.style.left = '0%';
      el.style.width = '100%';
      el.style.height = '12.5%';
      el.style.transform = '';
      if (badgeText !== undefined) {
        el.innerHTML = badgeText ? `<span class="dog-telegraph-badge">${badgeText}</span>` : '';
      }
    } else if (tele.type === 'file') {
      const gc = fl ? 7 - tele.index : tele.index;
      el.className = 'dog-telegraph-lane';
      el.style.top = '0%';
      el.style.left = (gc * 12.5) + '%';
      el.style.width = '12.5%';
      el.style.height = '100%';
      el.style.transform = '';
      if (badgeText !== undefined) {
        el.innerHTML = badgeText ? `<span class="dog-telegraph-badge">${badgeText}</span>` : '';
      }
    } else {
      let sqs = tele.squares;
      if (!sqs || !sqs.length) {
        sqs = [];
        const k = tele.index;
        for (let r = 0; r < 8; r++) {
          const c = tele.type === 'diagMain' ? r + k : k - r;
          if (c >= 0 && c < 8) sqs.push(r * 8 + c);
        }
      }
      if (!sqs.length) return;
      el.className = 'dog-telegraph-lane diagonal-squares-container';
      el.style.top = '0%';
      el.style.left = '0%';
      el.style.width = '100%';
      el.style.height = '100%';
      el.style.transform = '';

      const midIdx = Math.floor(sqs.length / 2);
      let squaresHtml = '';
      for (let idx = 0; idx < sqs.length; idx++) {
        const sq = sqs[idx];
        const r = sq >> 3, c = sq & 7;
        const gr = fl ? r : 7 - r;
        const gc = fl ? 7 - c : c;
        const isMid = idx === midIdx;
        const badgeContent = (isMid && badgeText) ? `<span class="dog-telegraph-badge">${badgeText}</span>` : '';
        squaresHtml += `<div class="dog-telegraph-square" style="left:${gc * 12.5}%;top:${gr * 12.5}%;width:12.5%;height:12.5%;">${badgeContent}</div>`;
      }
      el.innerHTML = squaresHtml;
    }
  }

  function getDogDashWaypoints(tele, fl, W, H) {
    const sqW = W / 8;
    const sqH = H / 8;
    if (!tele) {
      return [{ x: -240, y: H / 2 }, { x: W + 240, y: H / 2 }];
    }
    if (tele.type === 'rank') {
      const gr = fl ? tele.index : 7 - tele.index;
      const y = gr * sqH + sqH / 2;
      return [{ x: -240, y }, { x: W + 240, y }];
    }
    if (tele.type === 'file') {
      const gc = fl ? 7 - tele.index : tele.index;
      const x = gc * sqW + sqW / 2;
      return [{ x, y: -240 }, { x, y: H + 240 }];
    }
    // Diagonals (diagMain / diagAnti)
    let sqs = tele.squares;
    if (!sqs || !sqs.length) {
      sqs = [];
      const k = tele.index;
      for (let r = 0; r < 8; r++) {
        const c = tele.type === 'diagMain' ? r + k : k - r;
        if (c >= 0 && c < 8) sqs.push(r * 8 + c);
      }
    }
    if (!sqs.length) {
      return [{ x: -240, y: -240 }, { x: W + 240, y: H + 240 }];
    }
    const firstSq = sqs[0];
    const lastSq = sqs[sqs.length - 1];
    const r1 = firstSq >> 3, c1 = firstSq & 7;
    const r2 = lastSq >> 3, c2 = lastSq & 7;
    const gr1 = fl ? r1 : 7 - r1, gc1 = fl ? 7 - c1 : c1;
    const gr2 = fl ? r2 : 7 - r2, gc2 = fl ? 7 - c2 : c2;
    const p1x = gc1 * sqW + sqW / 2, p1y = gr1 * sqH + sqH / 2;
    const p2x = gc2 * sqW + sqW / 2, p2y = gr2 * sqH + sqH / 2;
    const dx = p2x - p1x, dy = p2y - p1y;
    const len = Math.hypot(dx, dy);
    let ux = 0, uy = 0;
    if (len < 0.001) {
      const dirX = tele.type === 'diagMain' ? (fl ? -1 : 1) : (fl ? 1 : -1);
      const dirY = fl ? 1 : -1;
      ux = dirX * Math.SQRT1_2;
      uy = dirY * Math.SQRT1_2;
    } else {
      ux = dx / len;
      uy = dy / len;
    }
    return [
      { x: p1x - ux * 240, y: p1y - uy * 240 },
      { x: p2x + ux * 240, y: p2y + uy * 240 },
    ];
  }

  function syncDogTelegraph() {
    const layer = $('vfxLayer');
    if (!layer) return;
    const existing = layer.querySelector('.dog-telegraph-lane');
    if (!S || !S.dog || !S.dog.active || !S.dog.telegraph || isAnimatingCards) {
      if (existing) existing.remove();
      return;
    }
    const fl = flipped();
    const tele = S.dog.telegraph;
    let teleEl = existing;
    if (!teleEl) {
      teleEl = document.createElement('div');
      teleEl.className = 'dog-telegraph-lane';
      layer.appendChild(teleEl);
    }
    const badgeText = `⚠️ STRIKE IN ${S.dog.turnsUntilAttack} TURNS`;
    positionDogLaneElement(teleEl, tele, fl, badgeText);
  }

  function spawnWormhole(sqOrSqs, durationMs = 1500) {
    const layer = $('vfxLayer');
    if (!layer) return;
    const sqs = Array.isArray(sqOrSqs) ? sqOrSqs : [sqOrSqs];
    if (!sqs.length) return;

    const fl = flipped();
    let minGr = 8, maxGr = -1, minGc = 8, maxGc = -1;
    for (const sq of sqs) {
      const r = sq >> 3, c = sq & 7;
      const gr = fl ? r : 7 - r;
      const gc = fl ? 7 - c : c;
      minGr = Math.min(minGr, gr);
      maxGr = Math.max(maxGr, gr);
      minGc = Math.min(minGc, gc);
      maxGc = Math.max(maxGc, gc);
    }

    const left = minGc * 12.5;
    const top = minGr * 12.5;
    const width = (maxGc - minGc + 1) * 12.5;
    const height = (maxGr - minGr + 1) * 12.5;
    const isMultiTile = sqs.length > 1;

    const wh = document.createElement('div');
    wh.className = 'dog-wormhole' + (isMultiTile ? ' dog-wormhole-dual' : '');
    wh.style.left = `${left}%`;
    wh.style.top = `${top}%`;
    wh.style.width = `${width}%`;
    wh.style.height = `${height}%`;
    layer.appendChild(wh);
    setTimeout(() => wh.remove(), durationMs);
  }

  function spawnStarlightDust(sq, count = 12) {
    const cell = sqEl(sq);
    if (!cell) return;
    for (let i = 0; i < count; i++) {
      const p = document.createElement('div');
      p.className = 'dog-particle';
      const angle = Math.random() * Math.PI * 2;
      const dist = 30 + Math.random() * 60;
      p.style.setProperty('--dx', `${Math.cos(angle) * dist}px`);
      p.style.setProperty('--dy', `${Math.sin(angle) * dist}px`);
      p.style.background = i % 2 === 0 ? '#38bdf8' : '#c084fc';
      cell.appendChild(p);
      setTimeout(() => p.remove(), 1800);
    }
  }

  function renderBoard(boardOverride) {
    const bArr = boardOverride || displayBoard || S.board;
    const board = $('board');
    board.innerHTML = '';
    const fl = flipped();
    const targets = selected != null ? targetsOf(selected).map((m) => m.to) : [];
    for (let i = 0; i < 64; i++) {
      const gr = Math.floor(i / 8);
      const gc = i % 8;
      const r = fl ? gr : 7 - gr;
      const f = fl ? 7 - gc : gc;
      const sq = r * 8 + f;
      const el = document.createElement('div');
      el.className = 'sq ' + ((r + f) % 2 === 0 ? 'dark' : 'light') + (gr < 4 ? ' eh-top' : ' eh-bot');
      el.dataset.sq = sq;
      if (!isAnimatingCards && S.lastMove && (S.lastMove.from === sq || S.lastMove.to === sq)) el.classList.add('hl');
      if (selected === sq) el.classList.add('sel');
      if (!isAnimatingCards && S.checkSq === sq) el.classList.add('check');
      if (gc === 0) el.insertAdjacentHTML('beforeend', `<span class="coord rank">${r + 1}</span>`);
      if (gr === 7) el.insertAdjacentHTML('beforeend', `<span class="coord file">${FILES[f]}</span>`);
      if (S.mines.includes(sq)) el.insertAdjacentHTML('beforeend', '<span class="mine">💣</span>');

      const p = bArr[sq];
      const dogSeg = S && S.dog && S.dog.active && S.dog.segments ? S.dog.segments.find((seg) => seg.sq === sq) : null;
      const isDogCurledSq = S && S.dog && S.dog.active && S.dog.phase === 'coiled' && (dogSeg || (S.dog.curlCycle && S.dog.curlCycle.includes(sq)));
      if (isDogCurledSq) el.classList.add('dog-curled-sq');
      if (p) {
        const pe = document.createElement('div');
        pe.className = 'piece';
        if (p.frozen) pe.classList.add('frozen');
        if (p.shield) pe.classList.add('shield');
        if (p.pink) pe.classList.add('pink');
        if (p.shotgun) pe.classList.add('shotgun');
        if (dogSeg) pe.classList.add('dog-trapped');
        if (p.t === 'k' && p.shotgun && S.lmsActive && S.lmsColor === p.c) pe.classList.add('lms-king');
        if (drag && drag.from === sq) pe.classList.add('dragging');
        let extraHtml = '';
        if (p.shotgun) extraHtml += '<span class="sg-badge" title="King with a Shotgun">🔫</span>';
        extraHtml += renderHpBarHtml(p);
        pe.innerHTML = `${renderPieceImgsHtml(p)}${extraHtml}`;
        el.appendChild(pe);
      }
      if (dogSeg) {
        const canAttack = targets.includes(sq);
        if (canAttack) {
          el.classList.add('dog-targetable');
        }
      }
      if (targets.includes(sq)) {
        if (dogSeg) {
          el.insertAdjacentHTML('beforeend', '<span class="ring" style="border-color:#ef4444;box-shadow:0 0 12px #ef4444;"></span>');
        } else {
          el.insertAdjacentHTML('beforeend', p ? '<span class="ring"></span>' : '<span class="dot"></span>');
        }
      }
      board.appendChild(el);
    }
    syncEventHorizonBarrier();
    syncDogTelegraph();
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
    if (info && info.user) {
      if (info.user.customTitle) {
        tags.push(`<span class="player-title-tag">${esc(info.user.customTitle)}</span>`);
      }
      if (info.user.stats) {
        tags.push(`<span class="player-stat-tag">(${info.user.stats.wins}W/${info.user.stats.losses}L · 🪙${info.user.coins || 0})</span>`);
      }
      if (isYou && currentUser && info.user.id === currentUser.id) {
        setCurrentUser(info.user);
      }
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

    // skill card panel
    const skillPanel = $('skillCardPanel');
    if (skillPanel) {
      const mySeat = S.players && S.players[S.you];
      const myUser = mySeat && mySeat.user;
      const skill = S.equippedSkill || (myUser && (myUser.skillCard || (typeof myUser.equippedSkill === 'object' ? myUser.equippedSkill : null)));
      if (!skill) {
        skillPanel.classList.add('hidden');
      } else {
        skillPanel.classList.remove('hidden');
        if ($('skillCardIcon')) $('skillCardIcon').textContent = skill.icon || '⚡';
        if ($('skillCardName')) $('skillCardName').textContent = skill.name || 'Skill';
        if ($('skillCardDesc')) $('skillCardDesc').textContent = skill.desc || '';
        const used = !!myUser.skillUsed;
        const badge = $('skillBadgeStatus');
        const btn = $('useSkillBtn');
        if (badge) {
          badge.className = used ? 'skill-badge-used' : 'skill-badge-ready';
          badge.textContent = used ? 'Used' : 'Ready (1x)';
        }
        if (btn) {
          const canUse = !used && S.phase === 'play' && S.turn === S.you && !isAnimatingCards;
          btn.disabled = !canUse;
          btn.textContent = used ? 'Used' : '⚡ Use';
        }
      }
    }

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
      ghost.className = 'ghost';
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
    cardUI = { id: null, revealed: false, raf: 0 };
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
        stopEventHorizonFlicker();

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
      eventHorizonPendingCut = true;
      displayBoard = e.before ? e.before.map((p) => (p ? { ...p } : null)) : null;
      renderBoard();
      const existingBar = layer ? layer.querySelector('.eh-barrier') : null;
      if (existingBar) existingBar.remove();
      stopEventHorizonFlicker();

      // 1) Impact frame: background and board turn black, pieces hidden, white line across board from side to side for 0.1s
      const rectBW = wrap ? wrap.getBoundingClientRect() : null;
      const impact = document.createElement('div');
      impact.className = 'eh-impact-frame';
      const whiteLine = document.createElement('div');
      whiteLine.className = 'eh-impact-white-line';
      if (rectBW && rectBW.width > 0) {
        whiteLine.style.left = rectBW.left + 'px';
        whiteLine.style.width = rectBW.width + 'px';
        whiteLine.style.top = (rectBW.top + rectBW.height * 0.5 - 1.5) + 'px';
      } else {
        whiteLine.style.left = '0%';
        whiteLine.style.width = '100%';
        whiteLine.style.top = '50%';
      }
      impact.appendChild(whiteLine);
      document.body.appendChild(impact);
      await wait(100); // exactly 0.1 second!
      impact.remove();

      // 2) The black line appears with CRAZY shakes!
      SFX.slice();

      if (layer) {
        const blackCut = document.createElement('div');
        blackCut.className = 'eh-black-line-cut';
        layer.appendChild(blackCut);
        setTimeout(() => blackCut.remove(), 1200);
      }

      if (wrap) {
        wrap.classList.remove('eh-active');
        wrap.classList.add('slicing');
      }

      // CRAZY SHAKE 1
      shakeElement(wrap, 900, 32, 'hard-to-soft');

      boardEl.querySelectorAll('.sq').forEach((cell) => {
        const isTop = cell.classList.contains('eh-top');
        cell.classList.add('quad-cut');
        cell.style.transition = 'transform 300ms cubic-bezier(0.16, 1, 0.3, 1)';
        cell.style.transform = `translateY(${isTop ? -18 : 18}px)`;
      });
      await wait(360);

      // Settle into 10-turn Event Horizon separation
      boardEl.querySelectorAll('.sq').forEach((cell) => {
        const isTop = cell.classList.contains('eh-top');
        cell.style.transition = 'transform 260ms cubic-bezier(0.16, 1, 0.3, 1)';
        cell.style.transform = `translateY(${isTop ? -9 : 9}px)`;
      });
      await wait(260);
      SFX.slam();

      if (wrap) wrap.classList.remove('slicing');
      isAnimatingEventHorizon = false;
      eventHorizonPendingCut = false;
      currentEffectEventHorizon = 10;
      displayBoard = e.after ? e.after.map((p) => (p ? { ...p } : null)) : null;
      renderBoard();
      // CRAZY SHAKE 2
      await shakeElement(wrap, 1000, 35, 'hard-to-soft');
      return;
    }

    // 0c) THE DEVOURER OF GODS (Event Boss Card):
    //     Initial cosmic strike: DoG rushes through rank 4 (left to right) and then rank 5 (right to left) with full 28 segments, devouring pieces with starlight bursts!
    if (id === 'devourerOfGods') {
      displayBoard = e.before ? e.before.map((p) => (p ? { ...p } : null)) : null;
      renderBoard();
      const wrap = $('boardWrap');
      SFX.dog_spawn();
      SFX.dog_rift();

      // Open 2 cosmic wormhole portals taking 2 tiles of space each (left & right sides of ranks 4 & 5)
      spawnWormhole([24, 32], 3000); // Left 2-tile portal on file a (a4 & a5)
      spawnWormhole([31, 39], 3000); // Right 2-tile portal on file h (h4 & h5)
      await wait(450);

      const fl = flipped();
      const rect = $('boardWrap')?.getBoundingClientRect() || { width: 480, height: 480 };
      const W = rect.width || 480;
      const H = rect.height || 480;
      const sqH = H / 8;

      const gr4 = fl ? 3 : 4;
      const gr5 = fl ? 4 : 3;
      const y4 = gr4 * sqH + sqH / 2;
      const y5 = gr5 * sqH + sqH / 2;

      // --- Stage 1: Full 28-segment Rush through Rank 4 (Left -> Right) ---
      SFX.dog_attack();
      await DogWorm.rushWaypoints(
        [{ x: -220, y: y4 }, { x: W + 220, y: y4 }],
        1400,
        (sq) => {
          const pe = pieceEl(sq);
          if (pe) {
            pe.classList.add('dog-wither-anim');
            spawnStarlightDust(sq, 14);
            SFX.capture();
            shakeElement(wrap, 150, 7, 'hard-to-soft');
          }
        }
      );

      // Loop around right portal into Rank 5
      SFX.dog_rift();
      await wait(180);

      // --- Stage 2: Full 28-segment Rush through Rank 5 (Right -> Left) ---
      SFX.dog_attack();
      await DogWorm.rushWaypoints(
        [{ x: W + 220, y: y5 }, { x: -220, y: y5 }],
        1400,
        (sq) => {
          const pe = pieceEl(sq);
          if (pe) {
            pe.classList.add('dog-wither-anim');
            spawnStarlightDust(sq, 14);
            SFX.capture();
            shakeElement(wrap, 150, 7, 'hard-to-soft');
          }
        }
      );

      SFX.dash();
      await shakeElement(wrap, 900, 20, 'hard-to-soft');
      displayBoard = e.after ? e.after.map((p) => (p ? { ...p } : null)) : null;
      renderBoard();
      renderDogBossBar();
      DOG_BGM.start();
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
      stopEventHorizonFlicker();
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
      currentEffectEventHorizon = S.status && S.status.eventHorizon ? S.status.eventHorizon : 0;
      if (S.lmsActive) LMS.start();
      else LMS.stop();
      render();
      if (S && S.dogDash && lastDogDashId !== S.dogDash.id) {
        handleDogDash(S);
      } else {
        if (S && S.dog && S.dog.active && S.dog.phase === 'coiled' && S.dog.segments && S.dog.segments.length > 0) {
          const regionSquares = S.dog.curlCycle || S.dog.segments.map((seg) => seg.sq);
          DogWorm.startCoiling(regionSquares);
        }
        handleGameOver(S);
      }
    })();
    return true;
  }

  let lastDogDashId = null;
  let dogDeathHandled = false;

  function handleDogDash(s) {
    if (!s.dogDash) return false;
    if (lastDogDashId === s.dogDash.id) return false;
    lastDogDashId = s.dogDash.id;

    (async () => {
      isAnimatingCards = true;
      SFX.dog_rift();
      const tele = s.dogDash.lane;
      const layer = $('vfxLayer');
      const wrap = $('boardWrap');
      const rect = $('boardWrap')?.getBoundingClientRect() || { width: 480, height: 480 };
      const W = rect.width || 480;
      const H = rect.height || 480;
      const fl = flipped();

      if (layer && tele) {
        const beam = document.createElement('div');
        beam.className = 'dog-telegraph-lane';
        positionDogLaneElement(beam, tele, fl, '');
        layer.appendChild(beam);
        setTimeout(() => beam.remove(), 1200);
      }
      await wait(350);

      // --- Stage 1: Full 28-segment Attack Dash along telegraphed lane ---
      SFX.dog_attack();
      const dashWaypoints = getDogDashWaypoints(tele, fl, W, H);
      await DogWorm.rushWaypoints(dashWaypoints, 1600, (sq) => {
        if (s.dogDash.wipedSquares && s.dogDash.wipedSquares.some((w) => w.sq === sq)) {
          const pe = pieceEl(sq);
          if (pe) pe.classList.add('dog-wither-anim');
          spawnStarlightDust(sq, 14);
          SFX.capture();
          shakeElement(wrap, 160, 8, 'hard-to-soft');
        }
      });

      await shakeElement(wrap, 500, 16, 'hard-to-soft');
      await wait(200);

      // --- Stage 2: Move from a random direction into a part of the tiles and coil! ---
      if (s.dogDash.segments && s.dogDash.segments.length > 0) {
        await DogWorm.enterCoiling(s.dogDash.segments.map((x) => x.sq));
      } else {
        DogWorm.stop();
      }

      isAnimatingCards = false;
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
    if (s.notice.text && s.notice.text.toLowerCase().includes('devourer of gods')) {
      // User request: remove notification for this boss cuz it's covering the screen
      return;
    }
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
    if (s.phase === 'over') DogWorm.stop();
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
    const mySeat = s.players && s.players[s.you];
    let statsNotice = '';
    let coinsBanner = '';
    if (s.result.winner === s.you && s.result.coinsAwarded > 0) {
      const coinMsg = s.result.isDefaultRarity ? '+5 Coins (Default Rarity Win)' : '+1 Coin (Custom Rarity Win)';
      coinsBanner = `<div style="color:#fbbf24;font-weight:900;font-size:15px;margin:2px 0 6px;">🪙 ${coinMsg}</div>`;
    }
    if (mySeat && mySeat.user && mySeat.user.stats) {
      const st = mySeat.user.stats;
      statsNotice = `<div style="color:#c084fc;font-weight:800;font-size:13px;margin:4px 0 10px;">Record: ${st.wins}W - ${st.losses}L - ${st.draws}D (${st.winRate || 0}%) · 🪙 ${mySeat.user.coins || 0} Coins</div>`;
      if (currentUser && mySeat.user.id === currentUser.id) {
        setCurrentUser(mySeat.user);
      }
    }
    m.innerHTML = `
      <div class="modal-box">
        <button class="close" id="closeModal">✕</button>
        <div class="trophy">${rt.icon}</div>
        <h2>${rt.title.replace(/^\S+\s/, '')}</h2>
        <div class="reason">${esc(rt.reason)}</div>
        ${coinsBanner}
        ${statsNotice}
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
    DOG_BGM.syncVolume();
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
            .map((c) => {
              const isDogActive = c.id === 'devourerOfGods' && S && S.dog && S.dog.active;
              const disabledAttr = isDogActive ? 'disabled' : '';
              const disabledClass = isDogActive ? 'disabled' : '';
              const activeTag = isDogActive ? '<span class="dc-active-tag">ALREADY ACTIVE</span>' : '';
              return `
            <button class="debug-card-item ${c.rarity} ${disabledClass}" data-id="${c.id}" ${disabledAttr}>
              <div class="dc-top">
                <span class="dc-icon">${c.icon}</span>
                <span class="dc-rarity">${c.rarity}${activeTag}</span>
              </div>
              <div class="dc-name">${esc(c.name)}</div>
              <div class="dc-desc">${esc(c.desc)}</div>
            </button>`;
            })
            .join('')}
        </div>
      </div>`;
    $('closeDebugModal').onclick = () => m.classList.add('hidden');
    m.onclick = (e) => {
      if (e.target === m) m.classList.add('hidden');
    };
    m.querySelectorAll('.debug-card-item:not(:disabled)').forEach((btn) => {
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
    DOG_BGM.stop(true);
    DogWorm.stop();
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
