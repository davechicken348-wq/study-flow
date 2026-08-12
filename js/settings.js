/**
 * StudyFlow — settings.js
 *
 * The single source of truth for every user preference in the app.
 *
 * Design goals
 * ------------
 *  - Reactive: any module can subscribe to a key and receive the new value
 *    the moment it changes. Features "adapt to all changes" without the
 *    caller re-rendering or re-reading.
 *  - Declarative: every setting is defined once in SCHEMA with its type,
 *    default, and an `apply` function. New features register their own
 *    setting here; nothing is a magic string scattered across the codebase.
 *  - Migratable: settings live in a single versioned localStorage blob. Old
 *    values (theme, notificationsEnabled, and the legacy focusPreset blob in
 *    the IndexedDB `settings` store) are migrated forward automatically.
 *
 *  Note: runtime/legacy keys kept OUT of this SCHEMA (and therefore the
 *  Settings UI) on purpose:
 *    - focusEngine   : live timer state, persisted by app.persistEngine()
 *    - timerHelpSeen : one-time UI flag flipped in the Timer page
 *    - focusPreset   : legacy timer preset blob, migrated into focusLength/
 *                      breakLength/rounds and then discarded
 *  - Resilient: a corrupt blob or a missing key always falls back to the
 *    declared default, so the app can never get into an unrecoverable state.
 *
 * Storage shape (localStorage['studyflow.settings'])
 *   { v: <schemaVersion>, values: { key: value, ... } }
 */

const STORAGE_KEY = 'studyflow.settings';
const SCHEMA_VERSION = 1;

/* ------------------------------------------------------------------ */
/* Schema                                                              */
/* ------------------------------------------------------------------ */

/**
 * Each entry:
 *  - type: 'theme' | 'select' | 'switch' | 'number' | 'range' | 'text' | 'button'
 *  - default: default value
 *  - group: settings section id
 *  - options: for select/theme ('light'|'dark'|'system')
 *  - min/max/step: for number/range
 *  - apply(value, ctx): runs synchronously when value changes (may be async)
 *  - persisted: false => kept in memory only (none currently, but supported)
 */
const SCHEMA = {
  /* ---- Appearance ---- */
  theme: {
    type: 'theme',
    default: 'system',
    group: 'appearance',
    options: ['light', 'dark', 'system'],
    apply: (v) => applyTheme(v),
  },
  fontSize: {
    type: 'range',
    default: 100,
    group: 'appearance',
    min: 85, max: 130, step: 5, unit: '%',
    label: 'Font size',
    help: 'Scales all text across the app.',
    apply: (v) => document.documentElement.style.setProperty('--font-scale', String(v / 100)),
  },
  density: {
    type: 'select',
    default: 'comfortable',
    group: 'appearance',
    options: { comfortable: 'Comfortable', compact: 'Compact' },
    apply: (v) => document.documentElement.setAttribute('data-density', v),
  },
  accentColor: {
    type: 'colors',
    default: 'indigo',
    group: 'appearance',
    options: {
      indigo:   { label: 'Indigo',   value: '#4f46e5' },
      violet:   { label: 'Violet',   value: '#7c3aed' },
      blue:     { label: 'Blue',     value: '#2563eb' },
      cyan:     { label: 'Cyan',     value: '#0891b2' },
      teal:     { label: 'Teal',     value: '#0d9488' },
      emerald:  { label: 'Emerald',  value: '#059669' },
      green:    { label: 'Green',    value: '#16a34a' },
      lime:     { label: 'Lime',     value: '#65a30d' },
      amber:    { label: 'Amber',    value: '#d97706' },
      orange:   { label: 'Orange',   value: '#ea580c' },
      rose:     { label: 'Rose',     value: '#e11d48' },
      pink:     { label: 'Pink',     value: '#db2777' },
      red:      { label: 'Red',      value: '#dc2626' },
      fuchsia:  { label: 'Fuchsia',  value: '#c026d3' },
      slate:    { label: 'Slate',    value: '#475569' },
    },
    apply: (v) => document.documentElement.setAttribute('data-accent', v),
  },
  reduceMotion: {
    type: 'switch',
    default: false,
    group: 'appearance',
    label: 'Reduce motion',
    help: 'Minimize animations and transitions.',
    apply: (v) => document.documentElement.setAttribute('data-reduce-motion', v ? 'true' : 'false'),
  },

  /* ---- Locale & format ---- */
  language: {
    type: 'select',
    default: 'en-US',
    group: 'locale',
    options: { 'en-US': 'English (US)', 'en-GB': 'English (UK)', 'de-DE': 'Deutsch', 'es-ES': 'Español', 'fr-FR': 'Français', 'pt-BR': 'Português (BR)', 'ja-JP': '日本語' },
    label: 'Language / locale',
    help: 'Used for dates, times and number formatting.',
  },
  clock: {
    type: 'select',
    default: 'auto',
    group: 'locale',
    options: { auto: 'Use locale default', '12h': '12-hour', '24h': '24-hour' },
    label: 'Time format',
  },
  weekStart: {
    type: 'select',
    default: 'auto',
    group: 'locale',
    options: { auto: 'Use locale default', sunday: 'Sunday', monday: 'Monday' },
    label: 'First day of week',
    help: 'Affects the Planner grid and weekly stats.',
  },

  /* ---- Focus Timer ---- */
  focusLength: {
    type: 'number',
    default: 25,
    group: 'timer',
    min: 1, max: 120, step: 1, unit: 'min',
    label: 'Focus length',
  },
  breakLength: {
    type: 'number',
    default: 5,
    group: 'timer',
    min: 1, max: 60, step: 1, unit: 'min',
    label: 'Break length',
  },
  rounds: {
    type: 'number',
    default: 4,
    group: 'timer',
    min: 1, max: 12, step: 1, unit: '×',
    label: 'Rounds per session',
  },
  longBreakLength: {
    type: 'number',
    default: 15,
    group: 'timer',
    min: 1, max: 60, step: 1, unit: 'min',
    label: 'Long break length',
  },
  longBreakEvery: {
    type: 'number',
    default: 4,
    group: 'timer',
    min: 2, max: 8, step: 1, unit: '×',
    label: 'Long break after every',
    help: 'Take an extended break after this many focus rounds.',
  },
  autoStartBreaks: {
    type: 'switch',
    default: true,
    group: 'timer',
    label: 'Auto-start breaks',
  },
  autoStartFocus: {
    type: 'switch',
    default: false,
    group: 'timer',
    label: 'Auto-start next focus round',
  },
  timerSound: {
    type: 'select',
    default: 'chime',
    group: 'timer',
    options: { off: 'Off', chime: 'Chime', bell: 'Bell', beep: 'Beep', digital: 'Digital' },
    label: 'Phase-end sound',
  },
  timerVolume: {
    type: 'range',
    default: 70,
    group: 'timer',
    min: 0, max: 100, step: 5, unit: '%',
    label: 'Sound volume',
  },
  timerVibrate: {
    type: 'switch',
    default: true,
    group: 'timer',
    label: 'Vibrate on phase change',
    help: 'On supported devices.',
  },
  timerPresets: {
    type: 'custom',
    default: [],
    group: 'timer',
    persisted: true,
  },

  /* ---- Notifications ---- */
  notificationsEnabled: {
    type: 'switch',
    default: false,
    group: 'notifications',
    label: 'Enable notifications',
  },
  notifySessionReminders: {
    type: 'switch',
    default: true,
    group: 'notifications',
    label: 'Session reminders',
    help: 'Warn before a planned session starts.',
  },
  notifyPhaseEnd: {
    type: 'switch',
    default: true,
    group: 'notifications',
    label: 'Timer phase-end alerts',
  },
  notifyGoalReached: {
    type: 'switch',
    default: true,
    group: 'notifications',
    label: 'Goal reached',
  },
  notifyLeadTime: {
    type: 'number',
    default: 15,
    group: 'notifications',
    min: 1, max: 60, step: 1, unit: 'min',
    label: 'Reminder lead time',
    help: 'How early to remind you before a planned session.',
  },
  notifyQuietStart: {
    type: 'text',
    default: '22:00',
    group: 'notifications',
    label: 'Quiet hours start',
    help: 'HH:MM — no notifications after this time.',
  },
  notifyQuietEnd: {
    type: 'text',
    default: '07:00',
    group: 'notifications',
    label: 'Quiet hours end',
    help: 'HH:MM — notifications resume after this time.',
  },

  /* ---- Notes & editor ---- */
  noteDefaultSubject: {
    type: 'select',
    default: '',
    group: 'notes',
    dynamic: 'subjects',
    label: 'Default subject for new notes',
  },
  noteAutosave: {
    type: 'switch',
    default: true,
    group: 'notes',
    label: 'Autosave notes while typing',
  },
  noteSpellcheck: {
    type: 'switch',
    default: true,
    group: 'notes',
    label: 'Spell check in editor',
  },
  noteOfflineMath: {
    type: 'switch',
    default: false,
    group: 'notes',
    label: 'Bundle math & fonts offline',
    help: 'Caches KaTeX/fonts locally so notes render without a network.',
  },
  noteDefaultLens: {
    type: 'select',
    default: 'affinity',
    group: 'notes',
    options: { affinity: 'Affinity', subject: 'Subject', recency: 'Recency', questions: 'Questions' },
    label: 'Default grouping',
  },
  affinityTightness: {
    type: 'range',
    default: 50,
    group: 'notes',
    min: 10, max: 90, step: 5, unit: '%',
    label: 'Note grouping tightness',
    help: 'Lower = looser, larger groups. Higher = tighter, smaller groups.',
  },
  affinityMaxGroup: {
    type: 'number',
    default: 8,
    group: 'notes',
    min: 3, max: 20, step: 1,
    label: 'Max notes per group',
  },

  /* ---- Quests ---- */
  goalUnit: {
    type: 'select',
    default: 'hours',
    group: 'goals',
    options: { hours: 'Hours', minutes: 'Minutes', sessions: 'Sessions' },
    label: 'Quest unit',
  },
  streakMinMinutes: {
    type: 'number',
    default: 1,
    group: 'goals',
    min: 1, max: 120, step: 1, unit: 'min',
    label: 'Minimum to count a day',
    help: 'Study time needed for a day to count toward a streak.',
  },
  streakFreeze: {
    type: 'switch',
    default: false,
    group: 'goals',
    label: 'Allow one rest day',
    help: 'Keep the streak alive across a single missed day.',
  },
  goalCelebrations: {
    type: 'switch',
    default: true,
    group: 'goals',
    label: 'Celebration overlay',
    help: 'Show a congrats animation when a quest is reached.',
  },
  goalCelebrationsReset: {
    type: 'button',
    default: 'reset',
    group: 'goals',
    label: 'Reset celebration flags',
    help: 'Re-allow celebration overlays you have already seen.',
  },
  questXpPerMinute: {
    type: 'number',
    default: 10,
    group: 'goals',
    min: 1, max: 100, step: 1, unit: 'xp',
    label: 'XP per minute studied',
    help: 'Drives your adventurer level. 1 focus minute = this many XP.',
  },
  questProfile: {
    type: 'custom',
    default: { xp: 0 },
    group: 'goals',
    persisted: true,
    label: 'Adventurer profile',
  },

  /* ---- Data ---- */
  dataExportFormat: {
    type: 'select',
    default: 'json',
    group: 'data',
    options: { json: 'JSON', csv: 'CSV (sessions)', markdown: 'Markdown (notes)' },
    label: 'Export format',
  },
  dataImportMode: {
    type: 'select',
    default: 'replace',
    group: 'data',
    options: { replace: 'Replace all', merge: 'Merge with existing' },
    label: 'Import mode',
    help: 'Merge keeps your current data and adds the file’s records.',
  },
  dataAutoBackup: {
    type: 'switch',
    default: false,
    group: 'data',
    label: 'Daily local backup',
    help: 'Keep a rolling backup in browser storage.',
  },

  /* ---- About ---- */
  aboutVersion: {
    type: 'button',
    default: 'info',
    group: 'about',
    label: 'Version',
  },
  aboutUpdate: {
    type: 'button',
    default: 'update',
    group: 'about',
    label: 'Check for updates',
    help: 'Apply the latest cached app version from the service worker.',
  },
  aboutClearCache: {
    type: 'button',
    default: 'clear',
    group: 'about',
    label: 'Clear app cache',
    help: 'Remove cached assets (re-downloaded on next use).',
  },
  resetSettings: {
    type: 'button',
    default: 'reset',
    group: 'about',
    label: 'Reset all settings',
    help: 'Restore every setting to its default.',
  },

  /* ---- Action rows (no stored value; handled by app) ---- */
  testNotification: {
    type: 'button',
    default: '',
    group: 'notifications',
    label: 'Test notification',
  },
  dailyGoalInline: {
    type: 'custom',
    default: '',
    group: 'goals',
  },
  exportData: {
    type: 'button',
    default: '',
    group: 'data',
    label: 'Export data',
  },
  importData: {
    type: 'button',
    default: '',
    group: 'data',
    label: 'Import data',
  },
  storageUsage: {
    type: 'button',
    default: '',
    group: 'data',
    label: 'Storage used',
  },
  backupNow: {
    type: 'button',
    default: '',
    group: 'data',
    label: 'Back up now',
  },
  clearAll: {
    type: 'button',
    default: '',
    group: 'danger',
    label: 'Clear all data',
    help: 'Permanently delete all subjects, sessions, notes and goals.',
  },
  resetDb: {
    type: 'button',
    default: '',
    group: 'danger',
    label: 'Reset database',
    help: 'Delete everything including schema.',
  },
};

/* ------------------------------------------------------------------ */
/* Reactive core                                                       */
/* ------------------------------------------------------------------ */

const listeners = new Map();      // key -> Set<fn(value, key)>
const anyListeners = new Set();   // fn(key, value) on every change
const values = {};                // resolved current values
let loaded = false;

function defaultValues() {
  const out = {};
  for (const [k, def] of Object.entries(SCHEMA)) out[k] = def.default;
  return out;
}

function readRaw() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || !parsed.values) return null;
    return parsed;
  } catch {
    return null;
  }
}

function writeRaw() {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ v: SCHEMA_VERSION, values }));
  } catch (e) {
    console.warn('[settings] failed to persist', e);
  }
}

/**
 * Pull legacy values from the old storage locations and fold them into the
 * new blob. Called once during load so existing users keep their preferences.
 */
async function migrateLegacy() {
  const migrators = [];

  // 1. localStorage.theme ('light'|'dark'|'system' implied)
  const legacyTheme = localStorage.getItem('theme');
  if (legacyTheme === 'light' || legacyTheme === 'dark' || legacyTheme === 'system') {
    values.theme = legacyTheme;
    localStorage.removeItem('theme');
  }

  // 2. localStorage.notificationsEnabled
  const legacyNotif = localStorage.getItem('notificationsEnabled');
  if (legacyNotif === 'true' || legacyNotif === 'false') {
    values.notificationsEnabled = legacyNotif === 'true';
    localStorage.removeItem('notificationsEnabled');
  }

  // 3. localStorage.goalCelebrations -> reset celebration flags
  if (localStorage.getItem('goalCelebrations')) {
    localStorage.removeItem('goalCelebrations');
  }

  // 4. IndexedDB `settings` store: only the legacy focusPreset blob is folded
  //    into the new schema. (focusEngine and timerHelpSeen are runtime/UI
  //    state that live in IndexedDB and are intentionally NOT settings.)
  try {
    const { default: Storage } = await import('./storage.js');
    const focusPreset = await Storage.getSetting('focusPreset');
    if (focusPreset && typeof focusPreset === 'object') {
      if (focusPreset.focusLength) values.focusLength = Math.round(focusPreset.focusLength / 60);
      if (focusPreset.breakLength) values.breakLength = Math.round(focusPreset.breakLength / 60);
      if (focusPreset.rounds) values.rounds = focusPreset.rounds;
      await Storage.setSetting('focusPreset', undefined);
    }
    const idbNotif = await Storage.getSetting('notificationsEnabled');
    if (idbNotif === 'true' || idbNotif === 'false') {
      values.notificationsEnabled = idbNotif === 'true';
    }
  } catch {
    /* storage unavailable */
  }

  return migrators;
}

function coerce(key, val) {
  const def = SCHEMA[key];
  if (!def) return val;
  switch (def.type) {
    case 'switch': return val === true;
    case 'number':
    case 'range': {
      const n = Number(val);
      if (Number.isNaN(n)) return def.default;
      if (def.min != null) return Math.min(def.max, Math.max(def.min, n));
      return n;
    }
    case 'select':
    case 'theme': {
      const opts = def.options;
      if (opts && typeof opts === 'object' && !Array.isArray(opts)) {
        return Object.prototype.hasOwnProperty.call(opts, val) ? val : def.default;
      }
      if (Array.isArray(opts)) return opts.includes(val) ? val : def.default;
      return val;
    }
    default: return val;
  }
}

async function load() {
  if (loaded) return;
  const defaults = defaultValues();
  Object.assign(values, defaults);

  const raw = readRaw();
  if (raw && raw.values) {
    for (const [k, v] of Object.entries(raw.values)) {
      if (k in SCHEMA) values[k] = coerce(k, v);
    }
  } else {
    // First run on this device → migrate from legacy locations.
    await migrateLegacy();
  }

  loaded = true;
  writeRaw();
  // Apply everything once on boot.
  for (const [k, def] of Object.entries(SCHEMA)) {
    if (typeof def.apply === 'function') {
      try { def.apply(values[k]); } catch (e) { console.warn('[settings] apply failed', k, e); }
    }
  }
}

function get(key) {
  if (!(key in SCHEMA)) {
    console.warn('[settings] unknown key', key);
    return undefined;
  }
  return values[key];
}

function getAll() {
  return { ...values };
}

async function set(key, value) {
  if (!(key in SCHEMA)) {
    console.warn('[settings] refusing to set unknown key', key);
    return;
  }
  const next = coerce(key, value);
  const prev = values[key];
  values[key] = next;
  if (SCHEMA[key].persisted !== false) writeRaw();

  const def = SCHEMA[key];
  if (typeof def.apply === 'function') {
    try { def.apply(next); } catch (e) { console.warn('[settings] apply failed', key, e); }
  }
  const subs = listeners.get(key);
  if (subs) subs.forEach((fn) => { try { fn(next, key); } catch (e) { console.warn('[settings] listener failed', key, e); } });
  anyListeners.forEach((fn) => { try { fn(key, next, prev); } catch (e) { console.warn('[settings] any-listener failed', e); } });

  // Keep the legacy theme key in sync only for other code that may read it.
  if (key === 'theme') localStorage.setItem('theme', resolvedTheme());
}

async function setMany(obj) {
  for (const [k, v] of Object.entries(obj)) await set(k, v);
}

function subscribe(key, fn) {
  if (!listeners.has(key)) listeners.set(key, new Set());
  listeners.get(key).add(fn);
  return () => listeners.get(key)?.delete(fn);
}

function subscribeAny(fn) {
  anyListeners.add(fn);
  return () => anyListeners.delete(fn);
}

function reset(key) {
  return set(key, SCHEMA[key].default);
}

function resetAll() {
  return setMany(defaultValues());
}

/* ------------------------------------------------------------------ */
/* Helpers shared across the app                                       */
/* ------------------------------------------------------------------ */

function resolvedTheme() {
  const t = values.theme || 'system';
  if (t === 'system') {
    return window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  }
  return t;
}

function applyTheme(value) {
  const resolved = value === 'system'
    ? (window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light')
    : value;
  document.documentElement.setAttribute('data-theme', resolved);
  localStorage.setItem('theme', resolved);
}

function locale() {
  return values.language || 'en-US';
}

function hour12() {
  if (values.clock === '12h') return true;
  if (values.clock === '24h') return false;
  try { return new Intl.DateTimeFormat(locale(), { hour: 'numeric' }).resolvedOptions().hour12; } catch { return true; }
}

function weekStartDay() {
  if (values.weekStart === 'sunday') return 0;
  if (values.weekStart === 'monday') return 1;
  try { return new Intl.Locale(locale()).weekInfo?.firstDay ?? 0; } catch { return 0; }
}

function fmtDate(iso) {
  if (!iso) return '';
  return new Date(iso).toLocaleDateString(locale(), { month: 'short', day: 'numeric', year: 'numeric' });
}

function fmtTime(iso) {
  if (!iso) return '';
  return new Date(iso).toLocaleTimeString(locale(), { hour: 'numeric', minute: '2-digit', hour12: hour12() });
}

function fmtDateTime(iso) {
  if (!iso) return '';
  return new Date(iso).toLocaleString(locale(), { hour: 'numeric', minute: '2-digit', hour12: hour12() });
}

/* ------------------------------------------------------------------ */
/* Quest / level helpers (XP-based progression)                        */
/* ------------------------------------------------------------------ */

// XP curve: each level needs progressively more XP.
// Level N (1-based) requires cumulative sum of (100 * N) XP.
function xpForLevel(level) {
  const l = Math.max(1, level);
  return 50 * l * (l - 1); // cumulative XP needed to *reach* level l
}

function levelFromXp(xp) {
  const x = Math.max(0, Number(xp) || 0);
  // Inverse of xpForLevel (50*l*(l-1)): largest level l whose threshold <= x.
  const l = Math.floor((1 + Math.sqrt(1 + (2 * x) / 25)) / 2);
  return Math.max(1, l);
}

function questLevelInfo(xp) {
  const level = levelFromXp(xp);
  const cur = xpForLevel(level);
  const next = xpForLevel(level + 1);
  const into = Math.max(0, xp - cur);
  const span = Math.max(1, next - cur);
  return {
    level,
    xp: Math.max(0, xp),
    cur,
    next,
    into,
    span,
    pct: Math.min(100, Math.round((into / span) * 100)),
    toNext: Math.max(0, next - xp),
  };
}

// Read the adventurer profile (always returns a valid {xp}).
function questProfile() {
  const p = values.questProfile;
  return { xp: Math.max(0, Number(p && p.xp) || 0) };
}

// Award XP, returning { before, after, leveledUp, level }.
async function questAddXp(amount) {
  const before = questProfile().xp;
  const after = before + Math.max(0, Math.floor(amount));
  const prevLevel = levelFromXp(before);
  const newLevel = levelFromXp(after);
  values.questProfile = { xp: after };
  writeRaw();
  return { before, after, leveledUp: newLevel > prevLevel, level: newLevel };
}

const Settings = {
  SCHEMA,
  load,
  get,
  getAll,
  set,
  setMany,
  subscribe,
  subscribeAny,
  reset,
  resetAll,
  defaultValues,
  resolvedTheme,
  locale,
  hour12,
  weekStartDay,
  fmtDate,
  fmtTime,
  fmtDateTime,
  xpForLevel,
  levelFromXp,
  questLevelInfo,
  questProfile,
  questAddXp,
};

export default Settings;
