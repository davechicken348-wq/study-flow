/**
 * StudyFlow — sounds.js
 *
 * Tiny WebAudio-based chime/alert generator so the focus timer can signal
 * phase changes without shipping any audio files. All behaviour is driven by
 * Settings (timerSound, timerVolume, timerVibrate).
 */

import Settings from './settings.js';

let ctx = null;

function audioCtx() {
  if (ctx) return ctx;
  const AC = window.AudioContext || window.webkitAudioContext;
  if (!AC) return null;
  ctx = new AC();
  return ctx;
}

function tone(freq, start, dur, gain) {
  const c = audioCtx();
  if (!c) return;
  const osc = c.createOscillator();
  const g = c.createGain();
  osc.type = 'sine';
  osc.frequency.value = freq;
  const t0 = c.currentTime + start;
  g.gain.setValueAtTime(0, t0);
  g.gain.linearRampToValueAtTime(gain, t0 + 0.01);
  g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
  osc.connect(g).connect(c.destination);
  osc.start(t0);
  osc.stop(t0 + dur + 0.02);
}

const PATTERNS = {
  chime: (v) => { tone(523.25, 0, 0.5, v); tone(659.25, 0.12, 0.5, v); tone(783.99, 0.24, 0.6, v); },
  bell:   (v) => { tone(440, 0, 1.2, v * 1.2); tone(880, 0.02, 1.2, v * 0.4); },
  beep:   (v) => { tone(880, 0, 0.12, v * 1.3); tone(880, 0.16, 0.12, v * 1.3); },
  digital:(v) => { tone(1200, 0, 0.06, v); tone(1600, 0.08, 0.06, v); tone(1200, 0.16, 0.06, v); },
};

export function playPhaseSound(kind = 'phase') {
  const sound = Settings.get('timerSound');
  const volume = (Settings.get('timerVolume') || 0) / 100;
  if (!sound || sound === 'off' || volume <= 0) return;
  const c = audioCtx();
  if (c && c.state === 'suspended') c.resume().catch(() => {});
  const fn = PATTERNS[sound] || PATTERNS.chime;
  try { fn(volume); } catch { /* ignore */ }
  if (Settings.get('timerVibrate') && navigator.vibrate) {
    navigator.vibrate(kind === 'complete' ? [120, 60, 120, 60, 200] : [90, 40, 90]);
  }
}

export function unlockAudio() {
  const c = audioCtx();
  if (c && c.state === 'suspended') c.resume().catch(() => {});
}

/* ------------------------------------------------------------------ */
/* Focus soundscapes                                                   */
/*                                                                     */
/* Generated, offline-first ambient textures the student can play while */
/* studying. No audio files are shipped — everything is synthesised     */
/* with the WebAudio API so the feature works with or without a network. */
/* ------------------------------------------------------------------ */

// Each preset declares a category (used to group the UI) plus a `kind` that
// maps to a generator below. Presets sharing a kind reuse the same synth with
// different parameters.
export const SOUNDSCAPES = {
  none:   { label: 'Off',            icon: 'off',     category: 'none',    hue: 240, mood: 'Silence' },
  rain:   { label: 'Rain',           icon: 'cloud',   category: 'nature',  hue: 200, mood: 'Weather' },
  hum:    { label: 'Focus hum',      icon: 'circle',  category: 'ambient', hue: 260, mood: 'Drone' },
  lofi:   { label: 'Lo-fi waves',    icon: 'music',   category: 'ambient', hue: 320, mood: 'Chillhop' },
  uplift: { label: 'Uplift',         icon: 'uplift',  category: 'smart',   kind: 'smart', preset: 'uplift',    hue: 150, mood: 'Bright & warm' },
  cinematic:{ label: 'Cinematic',    icon: 'cinematic',category: 'smart',  kind: 'smart', preset: 'cinematic', hue: 280, mood: 'Epic & deep' },
  melody: { label: 'Melody',         icon: 'melody',  category: 'smart',   kind: 'smart', preset: 'melody',    hue: 30,  mood: 'Tender & lyrical' },
  beat:   { label: 'Soft beat',      icon: 'beat',    category: 'beats',   kind: 'beat', tempo: 72,  tone: 'soft', hue: 190, mood: 'Lo-fi groove' },
  beatUp: { label: 'Focus pulse',    icon: 'beat',    category: 'beats',   kind: 'beat', tempo: 96,  tone: 'pulse',hue: 350, mood: 'Pump it up' },
  jazz:   { label: 'Jazz chords',    icon: 'jazz',    category: 'jazz',    kind: 'jazz', tempo: 84, hue: 40, mood: 'Smooth ii-V' },
  jazzP:  { label: 'Jazz piano',     icon: 'jazz',    category: 'jazz',    kind: 'jazzp', tempo: 90, hue: 50, mood: 'After hours' },
  blues:  { label: 'Blues riff',     icon: 'blues',   category: 'blues',   kind: 'blues', tempo: 80, hue: 220, mood: '12-bar feel' },
  bluesS: { label: 'Blues shuffle',  icon: 'blues',   category: 'blues',   kind: 'bluess', tempo: 76, hue: 230, mood: 'Boogie' },
};

export const SOUNDSCAPE_CATEGORIES = [
  { id: 'nature',  label: 'Nature' },
  { id: 'ambient', label: 'Ambient' },
  { id: 'smart',   label: 'Smart Music' },
  { id: 'beats',   label: 'Beats' },
  { id: 'jazz',    label: 'Jazz' },
  { id: 'blues',   label: 'Blues' },
];

// Cached noise buffers. `brown` is integrated (low rumble) noise; `white` is
// flat-spectrum noise used for rain / hats / vinyl texture.
let brownBuffer = null;
let whiteBuffer = null;

function makeNoiseBuffer(c, integrator) {
  const len = c.sampleRate * 2;
  const buf = c.createBuffer(1, len, c.sampleRate);
  const data = buf.getChannelData(0);
  let last = 0;
  for (let i = 0; i < len; i++) {
    const white = Math.random() * 2 - 1;
    if (integrator) {
      last = (last + 0.02 * white) / 1.02;
      data[i] = last * 3.5;
    } else {
      data[i] = white;
    }
  }
  return buf;
}

function getNoiseBuffer(c) {
  if (!brownBuffer) brownBuffer = makeNoiseBuffer(c, true);
  return brownBuffer;
}

function getWhiteBuffer(c) {
  if (!whiteBuffer) whiteBuffer = makeNoiseBuffer(c, false);
  return whiteBuffer;
}

export function __probe() {
  const c = audioCtx();
  const wb = getWhiteBuffer(c);
  const bb = getNoiseBuffer(c);
  const rms = (b) => { const d = b.getChannelData(0); let s = 0; for (const v of d) s += v * v; return Math.sqrt(s / d.length); };
  return { sampleRate: c.sampleRate, whiteRms: rms(wb), brownRms: rms(bb) };
}

export function __probeNoise(key) {
  const c = audioCtx();
  const an = c.createAnalyser(); an.fftSize = 2048;
  const master = c.createGain(); master.gain.value = 1; master.connect(an);
  GENERATORS.noise(c, master, SOUNDSCAPES[key] || {}, key);
  const buf = new Float32Array(an.fftSize); an.getFloatTimeDomainData(buf);
  let s = 0; for (const v of buf) s += v * v;
  return { key, rms: Math.sqrt(s / buf.length) };
}

// ── Musical helpers (for beats / jazz / blues) ────────────────────────────
// A small scheduler that fires a callback on every beat. Each callback gets
// the AudioContext, the master gain, the beat index and the time (in seconds)
// of that beat so it can schedule notes precisely.

// One plucked/struck note with a short percussive envelope.
function note(c, dest, freq, when, dur, { type = 'sine', gain = 0.2, detune = 0 } = {}) {
  const osc = c.createOscillator();
  const g = c.createGain();
  osc.type = type;
  osc.frequency.value = freq;
  if (detune) osc.detune.value = detune;
  osc.connect(g).connect(dest);
  g.gain.setValueAtTime(0.0001, when);
  g.gain.exponentialRampToValueAtTime(gain, when + 0.012);
  g.gain.exponentialRampToValueAtTime(0.0001, when + dur);
  osc.start(when);
  osc.stop(when + dur + 0.05);
}

// A single percussive "tick" from filtered noise (used for beats/hats).
function tick(c, dest, when, { freq = 4000, q = 1, gain = 0.18, dur = 0.06 } = {}) {
  const src = c.createBufferSource();
  src.buffer = getWhiteBuffer(c);
  const bp = c.createBiquadFilter();
  bp.type = 'bandpass'; bp.frequency.value = freq; bp.Q.value = q;
  const g = c.createGain();
  src.connect(bp).connect(g).connect(dest);
  g.gain.setValueAtTime(gain, when);
  g.gain.exponentialRampToValueAtTime(0.0001, when + dur);
  src.start(when);
  src.stop(when + dur + 0.05);
}

// Run a beat scheduler. `onBeat(beatIndex, time)` schedules audio. Returns a
// controller with stop().
function scheduler(c, master, tempo, onBeat) {
  const secondsPerBeat = 60 / tempo;
  let next = c.currentTime + 0.1;
  let beat = 0;
  const interval = setInterval(() => {
    // Schedule a small look-ahead window so timing stays smooth.
    while (next < c.currentTime + 0.25) {
      try { onBeat(beat, next); } catch {}
      next += secondsPerBeat;
      beat += 1;
    }
  }, 60);
  return {
    stop() { clearInterval(interval); },
  };
}

// Note tables (frequencies, Hz).
const N = {
  C3: 130.81, Eb3: 155.56, E3: 164.81, F3: 174.61, G3: 196.0, A3: 220.0, Bb3: 233.08, B3: 246.94,
  C4: 261.63, Db4: 277.18, D4: 293.66, Eb4: 311.13, E4: 329.63, F4: 349.23, Gb4: 369.99,
  G4: 392.0, Ab4: 415.30, A4: 440.0, Bb4: 466.16, B4: 493.88,
  C5: 523.25, D5: 587.33, Eb5: 622.25, E5: 659.25, G5: 783.99,
};

// Build a music-style soundscape. Returns [{stop}] so the caller can tear it
// down like any other node.
function buildMusic(c, cfg, master) {
  const ctrl = scheduler(c, master, cfg.tempo, (beat, t) => {
    cfg.onBeat({ c, master, t, beat, note, tick, N });
  });
  return [ctrl];
}

// ── Preset generators ─────────────────────────────────────────────────────

const GENERATORS = {
  noise(c, master, cfg, key) {
    const src = c.createBufferSource();
    // White noise presets need the flat-spectrum buffer; brown/pink are tinted
    // from the integrated (brown) buffer.
    src.buffer = (key === 'white') ? getWhiteBuffer(c) : getNoiseBuffer(c);
    src.loop = true;
    const shaper = c.createBiquadFilter();
    if (key === 'brown') { shaper.type = 'lowpass'; shaper.frequency.value = 500; }
    else if (key === 'pink') { shaper.type = 'lowpass'; shaper.frequency.value = 1600; }
    else { shaper.type = 'highpass'; shaper.frequency.value = 2000; }
    src.connect(shaper).connect(master);
    src.start();
    return [src];
  },

  rain(c, master) {
    // Flat-spectrum (white) noise shaped into a soft "shhh" hiss, with a slow
    // LFO wobbling the band so it breathes like rainfall.
    const src = c.createBufferSource();
    src.buffer = getWhiteBuffer(c);
    src.loop = true;
    const hp = c.createBiquadFilter();
    hp.type = 'highpass'; hp.frequency.value = 1000;
    const lp = c.createBiquadFilter();
    lp.type = 'lowpass'; lp.frequency.value = 7000;
    const body = c.createBiquadFilter();
    body.type = 'bandpass'; body.frequency.value = 3200; body.Q.value = 0.5;
    const lfo = c.createOscillator();
    const lfoGain = c.createGain();
    lfo.frequency.value = 0.15; lfoGain.gain.value = 600;
    lfo.connect(lfoGain).connect(body.frequency);
    src.connect(hp).connect(lp).connect(body).connect(master);
    src.start(); lfo.start();
    return [src, lfo];
  },

  hum(c, master) {
    const osc = c.createOscillator();
    osc.type = 'sine'; osc.frequency.value = 196;
    const osc2 = c.createOscillator();
    osc2.type = 'sine'; osc2.frequency.value = 196.5;
    const g = c.createGain(); g.gain.value = 0.35;
    osc.connect(g); osc2.connect(g); g.connect(master);
    osc.start(); osc2.start();
    return [osc, osc2];
  },

  lofi(c, master) {
    const tones = [110, 164.81, 220];
    const oscs = tones.map((f, i) => {
      const osc = c.createOscillator();
      osc.type = 'sine'; osc.frequency.value = f;
      const g = c.createGain(); g.gain.value = i === 0 ? 0.5 : 0.22;
      osc.connect(g).connect(master);
      osc.start();
      return osc;
    });
    const src = c.createBufferSource();
    src.buffer = getWhiteBuffer(c); src.loop = true;
    const lp = c.createBiquadFilter();
    lp.type = 'lowpass'; lp.frequency.value = 1200;
    const ng = c.createGain(); ng.gain.value = 0.06;
    src.connect(lp).connect(ng).connect(master);
    src.start();
    return [...oscs, src];
  },

  smart(c, master, cfg) {
    const preset = cfg.preset || 'uplift';
    const nodes = [];
    const createDelay = (time, feedback = 0.3, mix = 0.2) => {
      const delay = c.createDelay();
      delay.delayTime.value = time;
      const fb = c.createGain();
      fb.gain.value = feedback;
      const mixGain = c.createGain();
      mixGain.gain.value = mix;
      delay.connect(fb).connect(delay);
      delay.connect(mixGain).connect(master);
      return { input: delay, output: mixGain };
    };
    const reverb = createDelay(0.15, 0.25, 0.15);

    const addPad = (freq, type = 'sine', gain = 0.08, dest = master) => {
      const osc = c.createOscillator();
      osc.type = type;
      osc.frequency.value = freq;
      const g = c.createGain();
      g.gain.value = gain;
      osc.connect(g).connect(dest);
      osc.start();
      nodes.push(osc, g);
      return { osc, gain: g };
    };

    if (preset === 'uplift') {
      const chords = [
        [N.C4, N.E4, N.G4],
        [N.A3, N.C4, N.E4],
        [N.F3, N.A3, N.C4],
        [N.G3, N.B3, N.D4],
      ];
      const bassNotes = [N.C3, N.A2, N.F2, N.G2];
      return buildMusic(c, { tempo: 72, onBeat: ({ t, beat, note }) => {
        const i = Math.floor(beat / 4) % chords.length;
        const chord = chords[i];
        if (beat % 4 === 0) {
          chord.forEach((f, idx) => {
            note(c, master, f, t + idx * 0.08, 60 / 72 * 3.2, { type: 'triangle', gain: 0.06 });
          });
          note(c, master, bassNotes[i], t, 60 / 72 * 3.6, { type: 'sine', gain: 0.1 });
        } else if (beat % 2 === 0) {
          chord.slice(0, 2).forEach((f, idx) => {
            note(c, master, f, t + idx * 0.05, 60 / 72 * 1.2, { type: 'triangle', gain: 0.04 });
          });
        }
      } }, master);
    } else if (preset === 'cinematic') {
      const layers = [
        { f: N.C3, type: 'sine', g: 0.1 },
        { f: N.G3, type: 'sine', g: 0.07 },
        { f: N.B3, type: 'triangle', g: 0.04 },
        { f: N.E4, type: 'sine', g: 0.03 },
        { f: N.C5, type: 'sine', g: 0.02 },
      ];
      layers.forEach((l) => {
        const osc = c.createOscillator();
        osc.type = l.type;
        osc.frequency.value = l.f;
        const g = c.createGain();
        g.gain.value = l.g;
        const lfo = c.createOscillator();
        const lfoG = c.createGain();
        lfo.frequency.value = 0.02 + Math.random() * 0.04;
        lfoG.gain.value = l.g * 0.4;
        lfo.connect(lfoG).connect(g.gain);
        lfo.start();
        osc.connect(g).connect(reverb.input);
        osc.start();
        nodes.push(osc, lfo, lfoG, g);
      });
      const drone = c.createOscillator();
      drone.type = 'sine';
      drone.frequency.value = N.C2;
      const droneGain = c.createGain();
      droneGain.gain.value = 0.06;
      drone.connect(droneGain).connect(master);
      drone.start();
      nodes.push(drone, droneGain);
    } else if (preset === 'melody') {
      const melody = [
        N.E4, N.G4, N.A4, N.G4, N.E4, N.D4, N.E4, N.G4,
        N.A4, N.C5, N.A4, N.G4, N.E4, N.D4, N.E4, N.G4,
      ];
      const harmony = [
        [N.C4, N.E4, N.G4],
        [N.A3, N.C4, N.E4],
        [N.F3, N.A3, N.C4],
        [N.G3, N.B3, N.D4],
      ];
      return buildMusic(c, { tempo: 88, onBeat: ({ t, beat, note }) => {
        const i = Math.floor(beat / 8) % harmony.length;
        if (beat % 8 === 0) {
          harmony[i].forEach((f, idx) => {
            note(c, master, f, t + idx * 0.06, 60 / 88 * 3.0, { type: 'sine', gain: 0.04 });
          });
          note(c, reverb.input, harmony[i][0] / 2, t, 60 / 88 * 3.5, { type: 'sine', gain: 0.05 });
        }
        if (beat % 2 === 0) {
          const mIdx = (Math.floor(beat / 2) % melody.length);
          note(c, master, melody[mIdx], t, 60 / 88 * 1.4, { type: 'triangle', gain: 0.08 });
        }
      } }, master);
    }
    return nodes;
  },

  // Soft kick + hat groove. `tone` shifts the mood (soft vs. pulse).
  beat(c, master, cfg) {
    const soft = cfg.tone === 'soft';
    return buildMusic(c, { tempo: cfg.tempo, onBeat: ({ t, beat, note, tick }) => {
      // Kick on beats 0 and 2 (4/4), hat on the off-beats.
      if (beat % 2 === 0) {
        const k = c.createOscillator();
        const g = c.createGain();
        k.type = 'sine';
        k.frequency.setValueAtTime(soft ? 120 : 150, t);
        k.frequency.exponentialRampToValueAtTime(45, t + 0.18);
        g.gain.setValueAtTime(soft ? 0.5 : 0.7, t);
        g.gain.exponentialRampToValueAtTime(0.0001, t + 0.22);
        k.connect(g).connect(master);
        k.start(t); k.stop(t + 0.25);
      }
      tick(c, master, t + (60 / cfg.tempo) / 2, { freq: soft ? 6000 : 8000, gain: soft ? 0.06 : 0.1, dur: 0.04 });
      // A low pad tone on the downbeat for warmth.
      if (beat % 4 === 0) note(c, master, soft ? N.C3 : N.Eb3, t, 60 / cfg.tempo * 2, { type: 'triangle', gain: 0.12 });
    } }, master);
  },

  // Jazzy sustained chords (ii-V-I-ish loop) with a walking-ish bass.
  jazz(c, master, cfg) {
    const chords = [
      [N.D4, N.F4, N.A4, N.C5],
      [N.G3, N.B3, N.D5, N.F4],
      [N.C4, N.E4, N.G4, N.B4],
      [N.A3, N.C4, N.E5, N.G4],
    ];
    const bass = [N.D4 / 2, N.G3 / 2, N.C4 / 2, N.A3 / 2];
    return buildMusic(c, { tempo: cfg.tempo, onBeat: ({ t, beat, note }) => {
      const i = Math.floor(beat / 4) % chords.length;
      if (beat % 4 === 0) {
        chords[i].forEach((f) => note(c, master, f, t, 60 / cfg.tempo * 3.6, { type: 'sine', gain: 0.07 }));
        note(c, master, bass[i], t, 60 / cfg.tempo * 1.8, { type: 'triangle', gain: 0.16 });
      } else if (beat % 2 === 0) {
        // comping stabs
        chords[i].slice(0, 2).forEach((f) => note(c, master, f, t, 0.5, { type: 'sine', gain: 0.05 }));
      }
    } }, master);
  },

  // Brighter jazz piano line with arpeggiated voicings.
  jazzp(c, master, cfg) {
    const voicings = [
      [N.C4, N.E4, N.G4, N.B4],
      [N.A3, N.D4, N.E4, N.G4],
      [N.F3, N.A3, N.C4, N.E4],
      [N.G3, N.B3, N.D4, N.F4],
    ];
    return buildMusic(c, { tempo: cfg.tempo, onBeat: ({ t, beat, note }) => {
      const i = Math.floor(beat / 4) % voicings.length;
      const v = voicings[i];
      // gentle arpeggio across the bar
      v.forEach((f, k) => {
        const when = t + (k * (60 / cfg.tempo)) / 2;
        note(c, master, f, when, 0.45, { type: 'triangle', gain: 0.06 });
      });
      note(c, master, v[0] / 2, t, 60 / cfg.tempo * 1.6, { type: 'sine', gain: 0.14 });
    } }, master);
  },

  // 12-bar-ish blues riff using a dominant-7 colour, swing feel.
  blues(c, master, cfg) {
    const riff = [N.E3, N.G3, N.A3, N.Bb3, N.A3, N.G3];
    return buildMusic(c, { tempo: cfg.tempo, onBeat: ({ t, beat, note, tick }) => {
      const step = riff[beat % riff.length];
      note(c, master, step, t, 0.4, { type: 'sawtooth', gain: 0.12, detune: -6 });
      note(c, master, step * 1.5, t + 0.02, 0.35, { type: 'sine', gain: 0.05 });
      if (beat % 2 === 1) tick(c, master, t + (60 / cfg.tempo) * 0.66, { freq: 5000, gain: 0.05, dur: 0.04 });
    } }, master);
  },

  // Laid-back blues shuffle: bass boogie + chord stabs.
  bluess(c, master, cfg) {
    const boogie = [N.E3, N.E3 * 1.5, N.G3, N.E3 * 1.5, N.A3, N.E3 * 1.5, N.B3, N.E3 * 1.5];
    return buildMusic(c, { tempo: cfg.tempo, onBeat: ({ t, beat, note }) => {
      const b = boogie[beat % boogie.length];
      note(c, master, b, t, 0.3, { type: 'triangle', gain: 0.15 });
      if (beat % 2 === 0) {
        [N.E4, N.G4, N.Bb4].forEach((f) => note(c, master, f, t, 0.5, { type: 'sine', gain: 0.05 }));
      }
    } }, master);
  },
};

// Build the audio graph for a given preset key. Returns an array of stoppable
// nodes/controllers connected (directly or via scheduling) to `master`.
function buildGraph(c, key, master) {
  const preset = SOUNDSCAPES[key];
  const kind = (preset && preset.kind) || key;
  const gen = GENERATORS[kind] || GENERATORS.noise;
  // All generators share the signature (c, master, cfg, key) where `c` is the
  // AudioContext, `master` the output gain, `cfg` the preset definition, and
  // `key` the preset id (used by the noise generator to pick its texture).
  return gen(c, master, preset || {}, key);
}

let currentKind = 'none';
let activeNodes = [];
let fadeTimer = null;

export async function playSoundscape(kind, volume = 0.6) {
  const c = audioCtx();
  if (!c) return;
  // Resume BEFORE building the graph so continuous sources start at a live
  // currentTime (a suspended context reports a frozen time and can drop them).
  if (c.state === 'suspended') { try { await c.resume(); } catch {} }
  stopSoundscape(true);
  if (!kind || kind === 'none') { currentKind = 'none'; return; }
  const master = c.createGain();
  const t0 = Math.max(c.currentTime, 0) + 0.05;
  master.gain.setValueAtTime(0.0001, t0);
  master.gain.exponentialRampToValueAtTime(Math.max(0.0001, volume), t0 + 0.4);
  master.connect(c.destination);
  if (typeof window !== 'undefined' && window.__AN) { try { master.connect(window.__AN); } catch (e) {} }
  let nodes = [];
  try {
    nodes = buildGraph(c, kind, master);
  } catch (e) {
    console.warn('[sounds] soundscape build failed', kind, e);
  }
  activeNodes = nodes;
  activeNodes.push(master);
  currentKind = kind;
  if (typeof window !== 'undefined') window.__dbg = { master };
}

export function setSoundscapeVolume(volume) {
  if (activeNodes.length) {
    const c = audioCtx();
    const master = activeNodes[activeNodes.length - 1];
    if (c && master) master.gain.setTargetAtTime(Math.max(0.0001, volume), c.currentTime, 0.1);
  }
}

export function stopSoundscape(immediate = false) {
  if (fadeTimer) { clearTimeout(fadeTimer); fadeTimer = null; }
  if (activeNodes.length === 0) return;
  const c = audioCtx();
  const master = activeNodes[activeNodes.length - 1];
  const nodes = activeNodes;
  activeNodes = [];
  currentKind = 'none';
  if (!c || immediate) {
    nodes.forEach((n) => { try { n.stop && n.stop(); } catch {} try { n.disconnect && n.disconnect(); } catch {} });
    return;
  }
  master.gain.cancelScheduledValues(c.currentTime);
  master.gain.setValueAtTime(master.gain.value, c.currentTime);
  master.gain.exponentialRampToValueAtTime(0.0001, c.currentTime + 0.3);
  fadeTimer = setTimeout(() => {
    nodes.forEach((n) => { try { n.stop && n.stop(); } catch {} try { n.disconnect && n.disconnect(); } catch {} });
  }, 350);
}

export function currentSoundscape() {
  return currentKind;
}

export default {
  playPhaseSound, unlockAudio,
  SOUNDSCAPES,
  playSoundscape, setSoundscapeVolume, stopSoundscape, currentSoundscape,
};
