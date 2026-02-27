// player.js — Experimental Mix Apparatus
// 3 stems, 6 states total (5 outer + center Full Fruit), Web Audio preload, smooth ramps.
// Adds an "Archive" FX bus (delay + highpass + lowpass + mild drive) only when state === "Archive".

const FILES = {
  perc: "audio/percussion.m4a",
  mass: "audio/mass.m4a",
  vox:  "audio/voxgtr.m4a",
};

// Settings
const RAMP_SECONDS = 0.05;
const FLOOR_DB = -120; // allows true mute
const FLOOR_GAIN = dbToGain(FLOOR_DB);

// Archive FX tuning (subtle by default)
const FX = {
  delayTime: 0.05,     // seconds
  feedback: 0.22,      // 0..0.9
  wet: 0.14,           // 0..1 (how much FX you hear in Archive)
  highpassHz: 600,     // Hz (new)
  lowpassHz: 1800,     // Hz
  drive: 0.4,         // 0..0.10 (subtle saturation)
};

// Presets in dB (edit freely)
const PRESETS_DB = {
  "Skeleton":   { perc: 0,    mass: -100, vox: -120 },
  "Narrator":   { perc: -120, mass: -100, vox: -3   },
  "Flesh":      { perc: -100, mass: 0,    vox: -120 },
  "Pulse":      { perc: -5,   mass: 0,    vox: -120 },
  "Archive":    { perc: -12,  mass: -59,  vox: -18  }, // outer state w/ FX
  "Full Fruit": { perc: 0,    mass: 0,    vox: -1   }, // center core
};

const PRESETS = Object.fromEntries(
  Object.entries(PRESETS_DB).map(([name, v]) => [name, {
    perc: clampGain(dbToGain(v.perc)),
    mass: clampGain(dbToGain(v.mass)),
    vox:  clampGain(dbToGain(v.vox)),
  }])
);

let audioCtx = null;
let buffers = null;
let sources = null;
let gains = null;
let master = null;

// FX nodes
let fx = null; // { dryGain, wetGain, delay, feedback, highpass, lowpass, shaper }

let isReady = false;
let isPlaying = false;
let startAt = 0;
let offset = 0;
let currentState = "Full Fruit";

// UI
const statusEl = document.getElementById("status");
const enterBtn = document.getElementById("enterBtn");
const playPauseBtn = document.getElementById("playPauseBtn");
const nowEl = document.getElementById("now");
const specEl = document.getElementById("spec");
const wrapEl = document.getElementById("wrap");
const stateReadoutEl = document.getElementById("stateReadout");

// Wedges + center core are all [data-state]
const controls = Array.from(document.querySelectorAll("[data-state]"));

enterBtn.addEventListener("click", onEnter);
playPauseBtn.addEventListener("click", togglePlay);
controls.forEach(el => el.addEventListener("click", () => setState(el.dataset.state)));

function setStatus(msg) {
  statusEl.textContent = msg;
}

function setState(name) {
  if (!isReady) return;
  if (!PRESETS[name]) return;

  currentState = name;
  applyPreset(name);

  stateReadoutEl.textContent = name.toUpperCase();
  nowEl.textContent = `State: ${name}`;

  // Archive FX on/off
  if (fx) {
    const wetTarget = (name === "Archive") ? FX.wet : 0.0;
    rampGain(fx.wetGain.gain, wetTarget);
  }

  controls.forEach(el => el.classList.toggle("active", el.dataset.state === name));
}

function applyPreset(name) {
  if (!gains) return;
  const p = PRESETS[name];
  rampGain(gains.perc.gain, p.perc);
  rampGain(gains.mass.gain, p.mass);
  rampGain(gains.vox.gain,  p.vox);
}

function rampGain(param, target) {
  const t0 = audioCtx.currentTime;
  const t1 = t0 + RAMP_SECONDS;
  param.cancelScheduledValues(t0);
  param.setValueAtTime(param.value, t0);
  param.linearRampToValueAtTime(target, t1);
}

async function onEnter() {
  if (isReady) return;

  try {
    setStatus("INITIALIZING");
    enterBtn.disabled = true;

    audioCtx = new (window.AudioContext || window.webkitAudioContext)();

    setStatus("LOADING");
    buffers = {
      perc: await fetchDecode(FILES.perc),
      mass: await fetchDecode(FILES.mass),
      vox:  await fetchDecode(FILES.vox),
    };

    // Master
    master = audioCtx.createGain();
    master.gain.value = 1.0;
    master.connect(audioCtx.destination);

    // FX bus: dry + wet (delay + highpass + lowpass + mild drive)
    const dryGain = audioCtx.createGain();
    const wetGain = audioCtx.createGain();
    dryGain.gain.value = 1.0;
    wetGain.gain.value = 0.0; // default off

    const delay = audioCtx.createDelay(1.0);
    delay.delayTime.value = FX.delayTime;

    const feedback = audioCtx.createGain();
    feedback.gain.value = FX.feedback;

    const highpass = audioCtx.createBiquadFilter();
    highpass.type = "highpass";
    highpass.frequency.value = FX.highpassHz;
    highpass.Q.value = 0.7;

    const lowpass = audioCtx.createBiquadFilter();
    lowpass.type = "lowpass";
    lowpass.frequency.value = FX.lowpassHz;
    lowpass.Q.value = 0.7;

    const shaper = audioCtx.createWaveShaper();
    shaper.curve = makeSoftClipCurve(FX.drive);
    shaper.oversample = "2x";

    // feedback loop: delay -> feedback -> delay
    delay.connect(feedback);
    feedback.connect(delay);

    // wet chain: delay -> highpass -> lowpass -> shaper -> wetGain
    delay.connect(highpass);
    highpass.connect(lowpass);
    lowpass.connect(shaper);
    shaper.connect(wetGain);

    // to master
    dryGain.connect(master);
    wetGain.connect(master);

    fx = { dryGain, wetGain, delay, feedback, highpass, lowpass, shaper };

    // Stem gain nodes
    gains = {
      perc: audioCtx.createGain(),
      mass: audioCtx.createGain(),
      vox:  audioCtx.createGain(),
    };

    // Dry routing
    gains.perc.connect(fx.dryGain);
    gains.mass.connect(fx.dryGain);
    gains.vox.connect(fx.dryGain);

    // FX send (post-gain tap)
    gains.perc.connect(fx.delay);
    gains.mass.connect(fx.delay);
    gains.vox.connect(fx.delay);

    isReady = true;

    // Terminal activation + spec
    wrapEl.classList.remove("standby");
    wrapEl.classList.add("active");
    specEl.textContent = `SESSION: ${makeSessionId()} · CHANNELS: 3 · CONFIGS: 5 · STATUS: ACTIVE`;

    playPauseBtn.disabled = false;

    setState("Full Fruit");
    setStatus("ACTIVE");
  } catch (err) {
    console.error(err);
    setStatus("ERROR");
    enterBtn.disabled = false;
    specEl.textContent = "SESSION: ---- · CHANNELS: 3 · CONFIGS: 5 · STATUS: ERROR";
  }
}

async function fetchDecode(url) {
  const res = await fetch(url, { cache: "no-store" });
  if (!res.ok) throw new Error(`Failed to load: ${url}`);
  const arr = await res.arrayBuffer();
  return await audioCtx.decodeAudioData(arr);
}

function buildSources() {
  const sPerc = audioCtx.createBufferSource();
  const sMass = audioCtx.createBufferSource();
  const sVox  = audioCtx.createBufferSource();

  sPerc.buffer = buffers.perc;
  sMass.buffer = buffers.mass;
  sVox.buffer  = buffers.vox;

  sPerc.connect(gains.perc);
  sMass.connect(gains.mass);
  sVox.connect(gains.vox);

  sPerc.onended = () => {
    if (isPlaying) {
      isPlaying = false;
      offset = 0;
      playPauseBtn.textContent = "Play";
      setStatus("FINISHED");
      specEl.textContent = specEl.textContent.replace(/STATUS:\s*\w+/i, "STATUS: COMPLETE");
    }
  };

  sources = { perc: sPerc, mass: sMass, vox: sVox };
}

function togglePlay() {
  if (!isReady) return;

  if (!isPlaying) {
    if (audioCtx.state === "suspended") audioCtx.resume();

    buildSources();

    const when = audioCtx.currentTime + 0.02;
    startAt = when - offset;

    applyPreset(currentState);

    sources.perc.start(when, offset);
    sources.mass.start(when, offset);
    sources.vox.start(when, offset);

    isPlaying = true;
    playPauseBtn.textContent = "Pause";
    setStatus("RUNNING");
    specEl.textContent = specEl.textContent.replace(/STATUS:\s*\w+/i, "STATUS: RUNNING");
  } else {
    offset = audioCtx.currentTime - startAt;
    safeStopAll();
    isPlaying = false;
    playPauseBtn.textContent = "Play";
    setStatus("HOLD");
    specEl.textContent = specEl.textContent.replace(/STATUS:\s*\w+/i, "STATUS: HOLD");
  }
}

function safeStopAll() {
  if (!sources) return;
  try { sources.perc.stop(); } catch {}
  try { sources.mass.stop(); } catch {}
  try { sources.vox.stop(); } catch {}
  sources = null;
}

function dbToGain(db) {
  return Math.pow(10, db / 20);
}

function clampGain(g) {
  return Math.max(FLOOR_GAIN, Math.min(1.0, g));
}

function makeSessionId() {
  const hex = Math.random().toString(16).slice(2, 8).toUpperCase();
  const d = new Date();
  const yy = String(d.getFullYear()).slice(-2);
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${yy}${mm}${dd}-${hex}`;
}

function makeSoftClipCurve(amount) {
  // amount ~0.0 to 0.1 for subtle
  const n = 44100;
  const curve = new Float32Array(n);
  const k = Math.max(0.0001, amount * 100);
  const norm = Math.tanh(k);
  for (let i = 0; i < n; i++) {
    const x = (i * 2) / n - 1;
    curve[i] = Math.tanh(k * x) / norm;
  }
  return curve;
}

// Default visuals before entering
(function initUI() {
  stateReadoutEl.textContent = "FULL FRUIT";
  nowEl.textContent = "State: Full Fruit";
  controls.forEach(el => el.classList.toggle("active", el.dataset.state === "Full Fruit"));
})();
