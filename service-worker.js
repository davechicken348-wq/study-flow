const CACHE = 'studyflow-v3';
const PRECACHE = [
  './',
  './index.html',
  './css/main.css',
  './js/utils.js',
  './js/storage.js',
  './js/app.js',
  './manifest.json',
  './assets/vendor/chart.umd.min.js',
  './assets/illustrations/Bills-Payment-01--Streamline-Bangalore.png',
  './assets/illustrations/Business-Business-Graph-Negative-01--Streamline-Bangalore.png',
  './assets/illustrations/Business-Charts-Pie-And-Bars--Streamline-Bangalore.png',
  './assets/illustrations/Communication-Contact-Post-It-To-Do-Notes-01--Streamline-Bangalore.png',
  './assets/illustrations/Development-Code-Learning-01--Streamline-Bangalore.png',
  './assets/illustrations/Education-Online-Learning-02--Streamline-Bangalore.png',
  './assets/illustrations/Robot-Learning-From-Human--Streamline-Bangalore.png',
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(PRECACHE)));
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

self.addEventListener('fetch', (e) => {
  if (e.request.method !== 'GET') return;
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
    const req = indexedDB.open('StudyFlowDB', 1);
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

  const [sessions, subjects] = await Promise.all([
    getAllFromStore(db, 'sessions'),
    getAllFromStore(db, 'subjects'),
  ]);

  const now = new Date();
  const today = getToday();

  for (const s of sessions) {
    if (s.date !== today || !s.startTime || s.endTime || s.notified) continue;
    const start = new Date(s.startTime);
    const diffMin = (start.getTime() - now.getTime()) / 60000;
    if (diffMin <= 0 || diffMin > 15) continue;

    const subj = subjects.find((x) => x.id === s.subjectId);
    const timeStr = start.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });

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

// Periodic Background Sync (Chrome/Edge where supported)
self.addEventListener('periodicsync', (e) => {
  if (e.tag === 'studyflow-check') e.waitUntil(checkAndNotify());
});

// Message from app to trigger an immediate check
self.addEventListener('message', (e) => {
  if (e.data === 'CHECK_SESSIONS') e.waitUntil(checkAndNotify());
});
