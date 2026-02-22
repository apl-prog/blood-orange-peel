// Blood Orange Peel: 3 stems, 5 preset mixes, Web Audio, full preload, smooth ramps.

const FILES = {
  perc: "audio/percussion.m4a",
  mass: "audio/mass.m4a",
  vox: "audio/voxgtr.m4a",
};

// Settings
const RAMP_SECONDS = 0.05;
const FLOOR_DB = -100;
const FLOOR_GAIN = dbToGain(FLOOR_DB);

// Presets in dB (committed)
const PRESETS_DB = {
  "Skeleton":   { perc: 0,   mass: -70, vox: -100 },
  "Narrator":   { perc: -100, mass: -100, vox: -6   },
  "Flesh":      { perc: -100, mass: 0,   vox: -100 },
  "Pulse":      { perc: -10,   mass: 0, vox: -75  },
  "Full Fruit": { perc: 0,   mass: 0,   vox: -6   },
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
const mixBtns = Array.from(document.querySelectorAll(".mixBtn"));
const wedges = Array.from(document.querySelectorAll(".wedge"));
const orangeSvg = document.getElementById("orange");

enterBtn.addEventListener("click", onEnter);
playPauseBtn.addEventListener("click", togglePlay);

mixBtns.forEach(btn => btn.addEventListener("click", () => setState(btn.dataset.state)));
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
  orangeLabel.textContent = name;
  nowEl.textContent = `State: ${name}`;

  mixBtns.forEach(b => b.classList.toggle("active", b.dataset.state === name));
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
  // Avoid clicks by cancelling and ramping
  param.cancelScheduledValues(t0);
  // Set current value immediately (helps after cancel)
  param.setValueAtTime(param.value, t0);
  param.linearRampToValueAtTime(target, t1);
}

async function onEnter() {
  if (isReady) return;

  try {
    setStatus("Initializing audio...");
    enterBtn.disabled = true;

    audioCtx = new (window.AudioContext || window.webkitAudioContext)();

    // Preload and decode
    setStatus("Loading stems...");
    buffers = {
      perc: await fetchDecode(FILES.perc),
      mass: await fetchDecode(FILES.mass),
      vox:  await fetchDecode(FILES.vox),
    };

    // Build graph (but do not start)
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

    // Enable controls
    playPauseBtn.disabled = false;
    mixBtns.forEach(b => (b.disabled = false));

    // Default state UI + gains (before play)
    setState("Full Fruit");

    setStatus("Loaded. Tap Play.");
  } catch (err) {
    console.error(err);
    setStatus("Error loading audio. See console.");
    enterBtn.disabled = false;
  }
}

async function fetchDecode(url) {
  const res = await fetch(url, { cache: "no-store" });
  if (!res.ok) throw new Error(`Failed to load: ${url}`);
  const arr = await res.arrayBuffer();
  return await audioCtx.decodeAudioData(arr);
}

function buildSources() {
  // Create fresh sources every play (AudioBufferSourceNode is one-shot)
  const sPerc = audioCtx.createBufferSource();
  const sMass = audioCtx.createBufferSource();
  const sVox  = audioCtx.createBufferSource();

  sPerc.buffer = buffers.perc;
  sMass.buffer = buffers.mass;
  sVox.buffer  = buffers.vox;

  sPerc.connect(gains.perc);
  sMass.connect(gains.mass);
  sVox.connect(gains.vox);

  // When any ends, stop state
  sPerc.onended = () => {
    // If the track ended naturally (not paused), reset.
    if (isPlaying) {
      isPlaying = false;
      offset = 0;
      playPauseBtn.textContent = "Play";
      setStatus("Finished.");
    }
  };

  sources = { perc: sPerc, mass: sMass, vox: sVox };
}

function togglePlay() {
  if (!isReady) return;

  if (!isPlaying) {
    // Start / resume
    if (audioCtx.state === "suspended") audioCtx.resume();

    buildSources();

    const when = audioCtx.currentTime + 0.02; // tiny scheduling offset
    startAt = when - offset;

    // Ensure current preset is applied (in case user clicked before play)
    applyPreset(currentState);

    sources.perc.start(when, offset);
    sources.mass.start(when, offset);
    sources.vox.start(when, offset);

    isPlaying = true;
    playPauseBtn.textContent = "Pause";
    setStatus("Playing.");
  } else {
    // Pause: stop sources and store offset
    offset = audioCtx.currentTime - startAt;
    safeStopAll();
    isPlaying = false;
    playPauseBtn.textContent = "Play";
    setStatus("Paused.");
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

// Initialize UI active state (visual only)
setState("Full Fruit");
