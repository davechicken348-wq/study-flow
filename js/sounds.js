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

export default { playPhaseSound, unlockAudio };
