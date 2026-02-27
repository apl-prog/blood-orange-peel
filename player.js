// player.js — Experimental Mix Apparatus
// Archive: FX wet + almost-mono output + slight delay-time warble.

const FILES = {
  perc: "audio/percussion.m4a",
  mass: "audio/mass.m4a",
  vox:  "audio/voxgtr.m4a",
};

const RAMP_SECONDS = 0.05;
const FLOOR_DB = -120;
const FLOOR_GAIN = dbToGain(FLOOR_DB);

// Your current tuning
const FX = {
  delayTime: 0.05,
  feedback: 0.22,
  wet: 0.14,
  highpassHz: 600,
  lowpassHz: 1800,
  drive: 0.4,

  monoAmount: 0.85,
  warbleRate: 0.12,
  warbleDepth: 0.004,
};

const PRESETS_DB = {
  "Skeleton":   { perc: 0,    mass: -100, vox: -120 },
  "Narrator":   { perc: -120, mass: -100, vox: -3   },
  "Flesh":      { perc: -100, mass: 0,    vox: -120 },
  "Pulse":      { perc: -5,   mass: 0,    vox: -120 },
  "Archive":    { perc: -12,  mass: -59,  vox: -18  },
  "Full Fruit": { perc: 0,    mass: 0,    vox: -1   },
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

let fx = null;   // { dryGain, wetGain, delay, feedback, highpass, lowpass, shaper, lfo, lfoGain }
let out = null;  // { postIn, normalOut, monoOut }

let isReady = false;
let isPlaying = false;
let startAt = 0;
let offset = 0;
let currentState = "Full Fruit";

const statusEl = document.getElementById("status");
const enterBtn = document.getElementById("enterBtn");
const playPauseBtn = document.getElementById("playPauseBtn");
const nowEl = document.getElementById("now");
const specEl = document.getElementById("spec");
const wrapEl = document.getElementById("wrap");
const stateReadoutEl = document.getElementById("stateReadout");

const controls = Array.from(document.querySelectorAll("[data-state]"));

enterBtn.addEventListener("click", onEnter);
playPauseBtn.addEventListener("click", togglePlay);
controls.forEach(el => el.addEventListener("click", () => setState(el.dataset.state)));

function setStatus(msg) {
  statusEl.textContent = msg;

  const isLoading =
    msg === "INITIALIZING" ||
    msg === "LOADING";

  statusEl.classList.toggle("loading", isLoading);
}

function setSpec(statusWord, sessionId) {
  const sid = sessionId || "----";
  specEl.innerHTML = `SESSION: ${sid} · CHANNELS: 3 · CONFIGS: 5 · STATUS: ${statusWord} · RECOVERY TEAM: <a href="https://liberandos.com" target="_blank" class="la5">LA5</a>`;
}

function setState(name) {
  if (!isReady) return;
  if (!PRESETS[name]) return;

  currentState = name;
  applyPreset(name);

  stateReadoutEl.textContent = name.toUpperCase();
  nowEl.textContent = `State: ${name}`;

  const isArchive = (name === "Archive");

  if (fx) {
    rampGain(fx.wetGain.gain, isArchive ? FX.wet : 0.0);
    rampGain(fx.lfoGain.gain, isArchive ? FX.warbleDepth : 0.0);
  }

  if (out) {
    const monoAmt = isArchive ? FX.monoAmount : 0.0;
    rampGain(out.normalOut.gain, 1.0 - monoAmt);
    rampGain(out.monoOut.gain, monoAmt);
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

    // Output stage (mono crossfade)
    const postIn = audioCtx.createGain();
    postIn.gain.value = 1.0;

    const normalOut = audioCtx.createGain();
    const monoOut = audioCtx.createGain();
    normalOut.gain.value = 1.0;
    monoOut.gain.value = 0.0;

    postIn.connect(normalOut);
    normalOut.connect(audioCtx.destination);

    const splitter = audioCtx.createChannelSplitter(2);
    const lToSum = audioCtx.createGain();
    const rToSum = audioCtx.createGain();
    lToSum.gain.value = 0.5;
    rToSum.gain.value = 0.5;

    const monoSum = audioCtx.createGain();
    const merger = audioCtx.createChannelMerger(2);

    postIn.connect(splitter);
    splitter.connect(lToSum, 0);
    splitter.connect(rToSum, 1);
    lToSum.connect(monoSum);
    rToSum.connect(monoSum);

    monoSum.connect(merger, 0, 0);
    monoSum.connect(merger, 0, 1);

    merger.connect(monoOut);
    monoOut.connect(audioCtx.destination);

    out = { postIn, normalOut, monoOut };

    // FX bus: dry + wet into postIn
    const dryGain = audioCtx.createGain();
    const wetGain = audioCtx.createGain();
    dryGain.gain.value = 1.0;
    wetGain.gain.value = 0.0;

    dryGain.connect(out.postIn);
    wetGain.connect(out.postIn);

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

    delay.connect(feedback);
    feedback.connect(delay);

    delay.connect(highpass);
    highpass.connect(lowpass);
    lowpass.connect(shaper);
    shaper.connect(wetGain);

    // Warble: LFO -> lfoGain -> delay.delayTime
    const lfo = audioCtx.createOscillator();
    lfo.type = "sine";
    lfo.frequency.value = FX.warbleRate;

    const lfoGain = audioCtx.createGain();
    lfoGain.gain.value = 0.0;

    lfo.connect(lfoGain);
    lfoGain.connect(delay.delayTime);
    lfo.start();

    fx = { dryGain, wetGain, delay, feedback, highpass, lowpass, shaper, lfo, lfoGain };

    // Stem gain nodes
    gains = {
      perc: audioCtx.createGain(),
      mass: audioCtx.createGain(),
      vox:  audioCtx.createGain(),
    };

    gains.perc.connect(fx.dryGain);
    gains.mass.connect(fx.dryGain);
    gains.vox.connect(fx.dryGain);

    gains.perc.connect(fx.delay);
    gains.mass.connect(fx.delay);
    gains.vox.connect(fx.delay);

    isReady = true;

    wrapEl.classList.remove("standby");
    wrapEl.classList.add("active");

    const sid = makeSessionId();
    setSpec("ACTIVE", sid);

    playPauseBtn.disabled = false;

    setState("Full Fruit");
    setStatus("ACTIVE");
  } catch (err) {
    console.error(err);
    setStatus("ERROR");
    enterBtn.disabled = false;
    setSpec("ERROR", "----");
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
      // preserve link
      specEl.innerHTML = specEl.innerHTML.replace(/STATUS:\s*\w+/i, "STATUS: COMPLETE");
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
    specEl.innerHTML = specEl.innerHTML.replace(/STATUS:\s*\w+/i, "STATUS: RUNNING");
  } else {
    offset = audioCtx.currentTime - startAt;
    safeStopAll();
    isPlaying = false;
    playPauseBtn.textContent = "Play";
    setStatus("HOLD");
    specEl.innerHTML = specEl.innerHTML.replace(/STATUS:\s*\w+/i, "STATUS: HOLD");
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

(function initUI() {
  stateReadoutEl.textContent = "FULL FRUIT";
  nowEl.textContent = "State: Full Fruit";
  // initial footer text is OK; becomes linked on Enter
  controls.forEach(el => el.classList.toggle("active", el.dataset.state === "Full Fruit"));
})();
