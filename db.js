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
  setMeta: (key, val) => tx('meta', 'readwrite', s => req2p(s.put(val, key)))
};
