/**
 * StudyFlow — storage.js
 * IndexedDB wrapper. All data access lives here.
 */

const DB_NAME = 'StudyFlowDB';
const DB_VERSION = 1;

const STORES = {
  subjects:  { keyPath: 'id', indexes: [{ name: 'name', unique: false }] },
  sessions:  { keyPath: 'id', indexes: [{ name: 'subjectId', unique: false }, { name: 'date', unique: false }] },
  notes:     { keyPath: 'id', indexes: [{ name: 'subjectId', unique: false }] },
  goals:     { keyPath: 'id', indexes: [] },
  settings:  { keyPath: 'key', indexes: [] },
};

class Storage {
  #db = null;
  #ready = null;

  constructor() {
    this.#ready = this.#open();
  }

  ready() { return this.#ready; }

  #open() {
    return new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);

      req.onupgradeneeded = (e) => {
        const db = e.target.result;
        for (const [name, cfg] of Object.entries(STORES)) {
          if (db.objectStoreNames.contains(name)) continue;
          const store = db.createObjectStore(name, { keyPath: cfg.keyPath });
          cfg.indexes.forEach((idx) => store.createIndex(idx.name, idx.name, { unique: idx.unique }));
        }
      };

      req.onsuccess = () => { this.#db = req.result; resolve(this); };
      req.onerror = () => reject(req.error);
    });
  }

  async #store(name, mode = 'readonly') {
    await this.ready();
    return this.#db.transaction(name, mode).objectStore(name);
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
    await this.ready();
    // Delete subject + all its sessions and notes in one transaction
    const tx = this.#db.transaction(['subjects', 'sessions', 'notes'], 'readwrite');
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
    if (!s.date && s.startTime) s.date = s.startTime.split('T')[0];
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
  deleteNote(id) { return this.delete('notes', id); }

  /* ---------- Goals ---------- */
  getAllGoals() { return this.getAll('goals'); }
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
    await this.ready();
    const tx = this.#db.transaction(['subjects', 'sessions', 'notes', 'goals', 'settings'], 'readwrite');
    ['subjects', 'sessions', 'notes', 'goals', 'settings'].forEach((s) => tx.objectStore(s).clear());
    return new Promise((res, rej) => { tx.oncomplete = res; tx.onerror = () => rej(tx.error); });
  }

  /* ---------- Export / Import ---------- */
  async exportAll() {
    const [subjects, sessions, notes, goals] = await Promise.all([
      this.getAllSubjects(), this.getAllSessions(), this.getAllNotes(), this.getAllGoals(),
    ]);
    return { subjects, sessions, notes, goals, exportedAt: new Date().toISOString() };
  }

  async importAll(data) {
    const saves = [];
    (data.subjects || []).forEach((x) => saves.push(this.saveSubject(x)));
    (data.sessions || []).forEach((x) => saves.push(this.saveSession(x)));
    (data.notes || []).forEach((x) => saves.push(this.saveNote(x)));
    (data.goals || []).forEach((x) => saves.push(this.saveGoal(x)));
    await Promise.all(saves);
  }
}

export default new Storage();
