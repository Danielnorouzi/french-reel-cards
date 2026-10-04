// All cards live on the phone in IndexedDB — nothing is stored on the server.
const DB_NAME = 'french-reel-cards';
let dbp = null;

function open() {
  if (dbp) return dbp;
  dbp = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      const cards = db.createObjectStore('cards', { keyPath: 'id' });
      cards.createIndex('lemma', 'lemma', { unique: true });
      cards.createIndex('due', 'due');
      db.createObjectStore('meta');
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbp;
}

function tx(store, mode, fn) {
  return open().then(db => new Promise((resolve, reject) => {
    const t = db.transaction(store, mode);
    const s = t.objectStore(store);
    let result;
    Promise.resolve(fn(s)).then(r => { result = r; });
    t.oncomplete = () => resolve(result);
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error);
  }));
}
const req2p = r => new Promise((res, rej) => { r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });

export const db = {
  allCards: () => tx('cards', 'readonly', s => req2p(s.getAll())),
  putCard: card => tx('cards', 'readwrite', s => req2p(s.put(card))),
  deleteCard: id => tx('cards', 'readwrite', s => req2p(s.delete(id))),
  async addCards(cards) {
    return tx('cards', 'readwrite', async s => {
      let added = 0;
      for (const c of cards) {
        const exists = await req2p(s.index('lemma').count(c.lemma));
        if (!exists) { s.add(c); added++; }
      }
      return added;
    });
  },
  getMeta: key => tx('meta', 'readonly', s => req2p(s.get(key))),
  setMeta: (key, val) => tx('meta', 'readwrite', s => req2p(s.put(val, key))),

  // ---- backup and restore (see backup.js) ----
  // Everything a backup carries: all cards plus the listed settings.
  async snapshot(keys) {
    const d = await open();
    return new Promise((resolve, reject) => {
      const t = d.transaction(['cards', 'meta'], 'readonly');
      const out = { cards: [], meta: {} };
      t.objectStore('cards').getAll().onsuccess = e => { out.cards = e.target.result; };
      for (const k of keys) t.objectStore('meta').get(k).onsuccess = e => { if (e.target.result !== undefined) out.meta[k] = e.target.result; };
      t.oncomplete = () => resolve(out);
      t.onerror = t.onabort = () => reject(t.error);
    });
  },
  // Replaces the cards and the listed settings in ONE transaction: it either all happens or nothing changes.
  // `extra` holds other settings to write (or remove, when the value is undefined) in the same step.
  async replaceAll({ cards, meta }, keys, extra = {}) {
    const d = await open();
    return new Promise((resolve, reject) => {
      const t = d.transaction(['cards', 'meta'], 'readwrite');
      const c = t.objectStore('cards'), m = t.objectStore('meta');
      c.clear();
      for (const card of cards) c.put(card);
      for (const k of keys) { if (meta[k] === undefined) m.delete(k); else m.put(meta[k], k); }
      for (const [k, v] of Object.entries(extra)) { if (v === undefined) m.delete(k); else m.put(v, k); }
      t.oncomplete = () => resolve();
      t.onerror = t.onabort = () => reject(t.error);
    });
  }
};
