// IndexedDB 기반 캡처 타일 저장소.
// 거대한 전체 이미지를 메모리에 유지하지 않고, 완성된 세로 타일을 Blob으로 즉시 저장한다.
(function (root) {
  'use strict';

  const DB_NAME = 'sco-capture-db';
  const DB_VERSION = 1;
  const STORE = 'tiles';
  let dbPromise = null;

  function openDb() {
    if (dbPromise) return dbPromise;
    // 실패한 Promise를 캐싱하면 일시적 오류(onblocked 등)가 서비스 워커 수명 내내
    // 영구 장애로 굳어버리므로, 실패 시 다음 호출이 재시도할 수 있도록 캐시를 비운다.
    const attempt = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE);
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error || new Error('IndexedDB를 열 수 없습니다.'));
      req.onblocked = () => reject(new Error('IndexedDB 업그레이드가 차단되었습니다. 열려 있는 결과 창을 닫고 다시 시도하세요.'));
    });
    attempt.catch(() => { if (dbPromise === attempt) dbPromise = null; });
    dbPromise = attempt;
    return dbPromise;
  }

  async function transact(mode, fn) {
    const db = await openDb();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, mode);
      const store = tx.objectStore(STORE);
      let value;
      try { value = fn(store); } catch (e) { reject(e); return; }
      tx.oncomplete = () => resolve(value);
      tx.onerror = () => reject(tx.error || new Error('타일 저장소 작업에 실패했습니다.'));
      tx.onabort = () => reject(tx.error || new Error('타일 저장소 작업이 중단되었습니다.'));
    });
  }

  async function putBlob(key, blob) {
    if (!(blob instanceof Blob)) throw new TypeError('Blob만 저장할 수 있습니다.');
    await transact('readwrite', (store) => store.put(blob, key));
    return key;
  }

  async function getBlob(key) {
    const db = await openDb();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, 'readonly');
      const req = tx.objectStore(STORE).get(key);
      req.onsuccess = () => resolve(req.result || null);
      req.onerror = () => reject(req.error || new Error('캡처 타일을 읽을 수 없습니다.'));
    });
  }

  async function deleteKeys(keys) {
    const list = [...new Set((keys || []).filter(Boolean))];
    if (!list.length) return;
    await transact('readwrite', (store) => { for (const key of list) store.delete(key); });
  }

  async function hasKey(key) {
    const db = await openDb();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, 'readonly');
      const req = tx.objectStore(STORE).count(key);
      req.onsuccess = () => resolve(req.result > 0);
      req.onerror = () => reject(req.error || new Error('타일 존재 여부를 확인할 수 없습니다.'));
    });
  }

  async function listKeys() {
    const db = await openDb();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, 'readonly');
      const req = tx.objectStore(STORE).getAllKeys();
      req.onsuccess = () => resolve(req.result || []);
      req.onerror = () => reject(req.error || new Error('타일 목록을 읽을 수 없습니다.'));
    });
  }

  root.SCOStore = Object.freeze({ openDb, putBlob, getBlob, deleteKeys, hasKey, listKeys });
})(typeof self !== 'undefined' ? self : globalThis);
