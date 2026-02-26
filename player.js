// player.js
// Experimental Mix Apparatus: 3 stems, 5 preset mixes, Web Audio, full preload, smooth ramps.

const FILES = {
  perc: "audio/percussion.m4a",
  mass: "audio/mass.m4a",
  vox:  "audio/voxgtr.m4a",
};

// Settings
const RAMP_SECONDS = 0.05;
const FLOOR_DB = -120; // allows true mute (e.g., vocals in Skeleton)

// Presets in dB (committed)
const PRESETS_DB = {
  "Skeleton":   { perc: 0,   mass: -20, vox: -120 }, // vox drops out
  "Narrator":   { perc: -14, mass: -16, vox: 0   },
  "Flesh":      { perc: -10, mass: 0,   vox: -10 },
  "Pulse":      { perc: 0,   mass: -10, vox: -8  },
  "Full Fruit": { perc: 0,   mass: 0,   vox: 0   },
};

const FLOOR_GAIN = dbToGain(FLOOR_DB);

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

let isReady = false;
let isPlaying = false;
let startAt = 0;   // audioCtx.currentTime when playback started
let offset = 0;    // seconds into track when paused
let currentState = "Full Fruit";

// UI
const statusEl = document.getElementById("status");
const enterBtn = document.getElementById("enterBtn");
const playPauseBtn = document.getElementById("playPauseBtn");
const nowEl = document.getElementById("now");
const orangeLabel = document.getElementById("orangeLabel");
const wedges = Array.from(document.querySelectorAll(".wedge"));

const wrapEl = document.getElementById("wrap");
const specEl = document.getElementById("spec");

enterBtn.addEventListener("click", onEnter);
playPauseBtn.addEventListener("click", togglePlay);
wedges.forEach(w => w.addEventListener("click", () => setState(w.dataset.state)));

function setStatus(msg) {
  statusEl.textContent = msg;
}

function setState(name) {
  if (!isReady) return;
  if (!PRESETS[name]) return;

  currentState = name;
  applyPreset(name);

  // UI reflect
  orangeLabel.textContent = name.toUpperCase();
  nowEl.textContent = `State: ${name}`;

  wedges.forEach(w => w.classList.toggle("active", w.dataset.state === name));
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

    // Build graph
    master = audioCtx.createGain();
    master.gain.value = 1.0;
    master.connect(audioCtx.destination);

    gains = {
      perc: audioCtx.createGain(),
      mass: audioCtx.createGain(),
      vox:  audioCtx.createGain(),
    };

    gains.perc.connect(master);
    gains.mass.connect(master);
    gains.vox.connect(master);

    isReady = true;

    // Terminal activation feel + spec panel
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
    if (specEl) specEl.textContent = "SESSION: ---- · CHANNELS: 3 · CONFIGS: 5 · STATUS: ERROR";
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
      if (specEl) specEl.textContent = specEl.textContent.replace(/STATUS:\s*\w+/i, "STATUS: COMPLETE");
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
    if (specEl) specEl.textContent = specEl.textContent.replace(/STATUS:\s*\w+/i, "STATUS: RUNNING");
  } else {
    offset = audioCtx.currentTime - startAt;
    safeStopAll();
    isPlaying = false;
    playPauseBtn.textContent = "Play";
    setStatus("HOLD");
    if (specEl) specEl.textContent = specEl.textContent.replace(/STATUS:\s*\w+/i, "STATUS: HOLD");
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

// Default visual state before entering
(function initUI() {
  orangeLabel.textContent = "FULL FRUIT";
  nowEl.textContent = "State: Full Fruit";
  wedges.forEach(w => w.classList.toggle("active", w.dataset.state === "Full Fruit"));
})();
