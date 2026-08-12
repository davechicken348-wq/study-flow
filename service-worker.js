const CACHE = 'studyflow-v7';
const VERSIONED = CACHE;
const ILLUSTRATIONS = [
  'Bills-Payment-01--Streamline-Bangalore.png',
  'Business-Business-Graph-Negative-01--Streamline-Bangalore.png',
  'Business-Charts-Pie-And-Bars--Streamline-Bangalore.png',
  'Communication-Contact-Post-It-To-Do-Notes-01--Streamline-Bangalore.png',
  'Designer-Creative--Streamline-Bangalore.png',
  'Development-Code-Learning-01--Streamline-Bangalore.png',
  'Documents-4--Streamline-Bangalore.png',
  'Drawing-Painting--Streamline-Bangalore.png',
  'Education-Online-Learning-02--Streamline-Bangalore.png',
  'Hr-Human-Resources-2--Streamline-Bangalore.png',
  'I-Have-A-Question-2--Streamline-Bangalore.png',
  'Laptop-Workspace-3--Streamline-Ux.png',
  'No-Drafts-01--Streamline-Bangalore.png',
  'Pin-Post-It-Note--Streamline-Ux.png',
  'Robot-Learning-From-Human--Streamline-Bangalore.png',
  'Start-Up-Team--Streamline-Bangalore.png',
  'Time-In-For-Work--Streamline-Bangalore.png',
  'Work-Being-Creative-01--Streamline-Bangalore.png',
];
const SUBJECT_ILLUSTRATIONS = [
  'Astronaut--Streamline-Bangalore.png',
  'Be-Patient--Streamline-Bangalore.png',
  'Business-Go-To-Market-Strategy-01--Streamline-Bangalore.png',
  'Collaboration--Streamline-Bangalore.png',
  'Content-Creation-2--Streamline-Bangalore.png',
  'Content-Creation-Writing--Streamline-Bangalore.png',
  'Design-Design-Thinking-01--Streamline-Bangalore.png',
  'Education-Graduation-01--Streamline-Bangalore.png',
  'Education-Online-Exams-Tests-01--Streamline-Bangalore.png',
  'Education-Student-Active-01--Streamline-Bangalore.png',
  'Qa-Engineer-2--Streamline-Bangalore.png',
  'Sharing-Ideas-2--Streamline-Bangalore.png',
  'Users-People-Protect-Privacy-01--Streamline-Bangalore.png',
  'Users-People-Trophy-Awards-01--Streamline-Bangalore.png',
  'Work-Being-Creative-01--Streamline-Bangalore.png',
  'Working-Together--Streamline-Bangalore.png',
];
const PRECACHE = [
  './',
  './index.html',
  './css/main.css',
  './js/utils.js',
  './js/storage.js',
  './js/app.js',
  './manifest.json',
  './assets/vendor/chart.umd.min.js',
  ...ILLUSTRATIONS.map((f) => `./assets/illustrations/${f}`),
  ...SUBJECT_ILLUSTRATIONS.map((f) => `./assets/subject_illustrations/${f}`),
  './assets/icons/favicon-16x16.png',
  './assets/congrats_illustration/Being-Happy-2--Streamline-Barcelona.png',
  './assets/congrats_illustration/Graduation-1--Streamline-Barcelona.png',
  './assets/congrats_illustration/Showing-Pride-1--Streamline-Barcelona.png',
  './assets/icons/favicon-32x32.png',
  './assets/icons/favicon.ico',
  './assets/icons/apple-touch-icon.png',
  './assets/icons/android-chrome-192x192.png',
  './assets/icons/android-chrome-512x512.png',
];

// Cache each precache entry individually so a single 404 doesn't abort the
// whole install (which would leave the offline cache empty).
self.addEventListener('install', (e) => {
  e.waitUntil(
    caches.open(CACHE).then(async (c) => {
      await Promise.allSettled(
        PRECACHE.map((url) =>
          fetch(url)
            .then((res) => { if (res.status === 200) return c.put(url, res); })
            .catch(() => {})
        )
      );
    })
  );
  self.skipWaiting();
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))
    )
  );
  self.clients.claim();
});

function isIllustration(url) {
  return url.pathname.includes('/assets/illustrations/') ||
         url.pathname.includes('/assets/subject_illustrations/') ||
         url.pathname.includes('/assets/congrats_illustration/') ||
         url.pathname.includes('/assets/icons/');
}

self.addEventListener('fetch', (e) => {
  if (e.request.method !== 'GET') return;
  const url = new URL(e.request.url);
  if (url.origin !== self.location.origin) return;

  // Illustrations/icons: serve from cache first (offline-safe), and refresh in
  // the background. Anything not yet cached is fetched and stored for next time.
  if (isIllustration(url)) {
    e.respondWith(
      caches.match(e.request).then((cached) => {
        const network = fetch(e.request).then((res) => {
          if (res.status === 200) {
            caches.open(CACHE).then((c) => c.put(e.request, res.clone()));
          }
          return res;
        }).catch(() => cached);
        return cached || network;
      })
    );
    return;
  }

  e.respondWith(
    caches.match(e.request).then((cached) => {
      const fresh = fetch(e.request).then((res) => {
        if (res.status === 200) {
          caches.open(CACHE).then((c) => c.put(e.request, res.clone()));
        }
        return res;
      }).catch(() => cached);
      return cached || fresh;
    })
  );
});

// --- Background notification check ---

function openDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open('StudyFlowDB', 2);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function getAllFromStore(db, storeName) {
  return new Promise((resolve, reject) => {
    const req = db.transaction(storeName, 'readonly').objectStore(storeName).getAll();
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function putInStore(db, storeName, item) {
  return new Promise((resolve, reject) => {
    const req = db.transaction(storeName, 'readwrite').objectStore(storeName).put(item);
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error);
  });
}

function getSetting(db, key) {
  return new Promise((resolve, reject) => {
    const req = db.transaction('settings', 'readonly').objectStore('settings').get(key);
    req.onsuccess = () => resolve(req.result ? req.result.value : null);
    req.onerror = () => reject(req.error);
  });
}

function getToday() {
  const d = new Date();
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
}

async function checkAndNotify() {
  const clients = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
  if (clients.some((c) => c.focused)) return;

  let db;
  try { db = await openDB(); } catch { return; }

  const notifEnabled = await getSetting(db, 'notificationsEnabled');
  if (notifEnabled === 'false') return;
  const remindersOn = await getSetting(db, 'notifySessionReminders');
  if (remindersOn === 'false') return;

  const leadRaw = await getSetting(db, 'notifyLeadTime');
  const lead = leadRaw ? parseInt(leadRaw, 10) : 15;
  const quietStart = await getSetting(db, 'notifyQuietStart');
  const quietEnd = await getSetting(db, 'notifyQuietEnd');

  const [sessions, subjects] = await Promise.all([
    getAllFromStore(db, 'sessions'),
    getAllFromStore(db, 'subjects'),
  ]);

  const now = new Date();
  const today = getToday();

  const cur = now.getHours() * 60 + now.getMinutes();
  const parse = (str) => { const m = /^(\d{1,2}):(\d{2})$/.exec(str || ''); return m ? Math.min(1439, parseInt(m[1], 10) * 60 + parseInt(m[2], 10)) : null; };
  const qs = parse(quietStart), qe = parse(quietEnd);
  const inQuiet = qs != null && qe != null && (qs <= qe ? (cur >= qs && cur < qe) : (cur >= qs || cur < qe));
  if (inQuiet) return;

  for (const s of sessions) {
    if (s.date !== today || !s.startTime || s.endTime || s.notified) continue;
    const start = new Date(s.startTime);
    const diffMin = (start.getTime() - now.getTime()) / 60000;
    if (diffMin <= 0 || diffMin > lead) continue;

    const subj = subjects.find((x) => x.id === s.subjectId);
    const locale = (await getSetting(db, 'language')) || 'en-US';
    const timeStr = start.toLocaleTimeString(locale, { hour: 'numeric', minute: '2-digit' });

    try {
      if (Notification.permission === 'granted') {
        await self.registration.showNotification('Study session starting soon', {
          body: `${subj ? subj.name : 'Study'} at ${timeStr}`,
          icon: 'assets/icons/favicon-32x32.png',
          badge: 'assets/icons/favicon-32x32.png',
          tag: `session-${s.id}`,
        });
      }
    } catch {
      // Notification API not available or permission denied
    }

    s.notified = true;
    await putInStore(db, 'sessions', s);
  }
}

self.addEventListener('message', (e) => {
  if (e.data === 'SKIP_WAITING') self.skipWaiting();
});

// Periodic Background Sync (Chrome/Edge where supported)
self.addEventListener('periodicsync', (e) => {
  if (e.tag === 'studyflow-check') e.waitUntil(checkAndNotify());
});

// Message from app to trigger an immediate check
self.addEventListener('message', (e) => {
  if (e.data === 'CHECK_SESSIONS') e.waitUntil(checkAndNotify());
});
