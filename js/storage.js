/**
 * StudyFlow — storage.js
 * IndexedDB wrapper. All data access lives here.
 */

const DB_NAME = 'StudyFlowDB';
const DB_VERSION = 2;

const STORES = {
  subjects:  { keyPath: 'id', indexes: [{ name: 'name', unique: false }] },
  sessions:  { keyPath: 'id', indexes: [{ name: 'subjectId', unique: false }, { name: 'date', unique: false }] },
  notes:     { keyPath: 'id', indexes: [{ name: 'subjectId', unique: false }] },
  goals:     { keyPath: 'id', indexes: [] },
  settings:  { keyPath: 'key', indexes: [] },
  recordings:{ keyPath: 'id', indexes: [{ name: 'noteId', unique: false }, { name: 'createdAt', unique: false }] },
};

class Storage {
  #db = null;
  #opening = null;

  constructor() { this.#ensureDB(); }

  ready() { return this.#ensureDB(); }

  #ensureDB() {
    if (this.#db) return Promise.resolve();
    if (this.#opening) return this.#opening;
    this.#opening = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = (e) => {
        const db = e.target.result;
        for (const [name, cfg] of Object.entries(STORES)) {
          if (db.objectStoreNames.contains(name)) continue;
          const store = db.createObjectStore(name, { keyPath: cfg.keyPath });
          cfg.indexes.forEach((idx) => store.createIndex(idx.name, idx.name, { unique: idx.unique }));
        }
      };
      req.onsuccess = () => {
        this.#db = req.result;
        this.#opening = null;
        this.#db.onversionchange = () => { this.#db.close(); this.#db = null; };
        this.#db.onclose = () => { this.#db = null; };
        resolve();
      };
      req.onerror = () => { this.#opening = null; reject(req.error); };
    });
    return this.#opening;
  }

  async #tx(stores, mode = 'readonly') {
    await this.#ensureDB();
    try {
      const names = Array.isArray(stores) ? stores : [stores];
      return this.#db.transaction(names, mode);
    } catch (e) {
      if (e instanceof DOMException) {
        this.#db = null;
        await this.#ensureDB();
        const names = Array.isArray(stores) ? stores : [stores];
        return this.#db.transaction(names, mode);
      }
      throw e;
    }
  }

  async #store(name, mode = 'readonly') {
    return (await this.#tx(name, mode)).objectStore(name);
  }

  #wrap(req) {
    return new Promise((resolve, reject) => {
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }

  async getAll(store) { return this.#wrap((await this.#store(store)).getAll()); }
  async get(store, id) { return this.#wrap((await this.#store(store)).get(id)); }
  async put(store, item) { return this.#wrap((await this.#store(store, 'readwrite')).put(item)); }
  async delete(store, id) { return this.#wrap((await this.#store(store, 'readwrite')).delete(id)); }

  /* ---------- Subjects ---------- */
  getAllSubjects() { return this.getAll('subjects'); }
  getSubject(id) { return this.get('subjects', id); }
  saveSubject(s) {
    if (!s.createdAt) s.createdAt = new Date().toISOString();
    return this.put('subjects', s);
  }
  async deleteSubject(id) {
    const tx = await this.#tx(['subjects', 'sessions', 'notes'], 'readwrite');
    const del = (store, index, value) => new Promise((res) => {
      const req = tx.objectStore(store).index(index).openCursor(IDBKeyRange.only(value));
      req.onsuccess = (e) => {
        const cursor = e.target.result;
        if (cursor) { cursor.delete(); cursor.continue(); } else res();
      };
    });
    await Promise.all([del('sessions', 'subjectId', id), del('notes', 'subjectId', id)]);
    tx.objectStore('subjects').delete(id);
    return new Promise((res, rej) => { tx.oncomplete = res; tx.onerror = () => rej(tx.error); });
  }

  /* ---------- Sessions ---------- */
  getAllSessions() { return this.getAll('sessions'); }
  getSession(id) { return this.get('sessions', id); }
  saveSession(s) {
    if (!s.createdAt) s.createdAt = new Date().toISOString();
    if (!s.date && s.startTime) {
      const d = new Date(s.startTime);
      s.date = d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
    }
    return this.put('sessions', s);
  }
  deleteSession(id) { return this.delete('sessions', id); }

  /* ---------- Notes ---------- */
  getAllNotes() { return this.getAll('notes'); }
  getNote(id) { return this.get('notes', id); }
  saveNote(n) {
    if (!n.createdAt) n.createdAt = new Date().toISOString();
    n.updatedAt = new Date().toISOString();
    return this.put('notes', n);
  }
  async markNoteViewed(id) {
    const n = await this.get('notes', id);
    if (!n) return;
    n.lastViewedAt = new Date().toISOString();
    return this.put('notes', n);
  }
  deleteNote(id) { return this.delete('notes', id); }

  /* ---------- Goals ---------- */
  getAllGoals() { return this.getAll('goals'); }
  getGoal(id) { return this.get('goals', id); }
  saveGoal(g) { return this.put('goals', g); }
  deleteGoal(id) { return this.delete('goals', id); }

  /* ---------- Settings ---------- */
  async getSetting(key) {
    const row = await this.get('settings', key);
    return row ? row.value : null;
  }
  setSetting(key, value) { return this.put('settings', { key, value }); }

  /* ---------- Clear All ---------- */
  async clearAll() {
    const tx = await this.#tx(['subjects', 'sessions', 'notes', 'goals', 'settings', 'recordings'], 'readwrite');
    ['subjects', 'sessions', 'notes', 'goals', 'settings', 'recordings'].forEach((s) => tx.objectStore(s).clear());
    return new Promise((res, rej) => { tx.oncomplete = res; tx.onerror = () => rej(tx.error); });
  }

  /* ---------- Reset Database ---------- */
  async resetDatabase() {
    if (this.#db) { this.#db.close(); this.#db = null; }
    this.#opening = null;
    await new Promise((resolve, reject) => {
      const req = indexedDB.deleteDatabase(DB_NAME);
      req.onsuccess = () => resolve();
      req.onerror = () => reject(req.error);
      req.onblocked = () => reject(new Error('Database reset blocked'));
    });
    await this.#ensureDB();
  }

  /* ---------- Export / Import ---------- */
  async exportAll() {
    const [subjects, sessions, notes, goals, recordings] = await Promise.all([
      this.getAllSubjects(), this.getAllSessions(), this.getAllNotes(), this.getAllGoals(), this.getAllRecordings(),
    ]);
    return { subjects, sessions, notes, goals, recordings, exportedAt: new Date().toISOString() };
  }

  async importAll(data) {
    const tx = await this.#tx(['subjects', 'sessions', 'notes', 'goals', 'recordings'], 'readwrite');
    ['subjects', 'sessions', 'notes', 'goals', 'recordings'].forEach((s) => tx.objectStore(s).clear());
    await new Promise((res, rej) => { tx.oncomplete = res; tx.onerror = () => rej(tx.error); });
    const saves = [];
    (data.subjects || []).forEach((x) => saves.push(this.saveSubject(x)));
    (data.sessions || []).forEach((x) => saves.push(this.saveSession(x)));
    (data.notes || []).forEach((x) => saves.push(this.saveNote(x)));
    (data.goals || []).forEach((x) => saves.push(this.saveGoal(x)));
    (data.recordings || []).forEach((x) => saves.push(this.saveRecording(x)));
    await Promise.all(saves);
  }

  /* ---------- Recordings ---------- */
  getAllRecordings() { return this.getAll('recordings'); }
  getRecording(id) { return this.get('recordings', id); }
  saveRecording(r) {
    if (!r.createdAt) r.createdAt = new Date().toISOString();
    return this.put('recordings', r);
  }
  deleteRecording(id) { return this.delete('recordings', id); }
  getRecordingsForNote(noteId) {
    return this.getAll('recordings').then(list => list.filter(r => r.noteId === noteId));
  }
}

export default new Storage();
