'use client';

import type { AthleteDto } from '@/shared/api/types';

const DB_NAME = 'sports-management-offline';
const DB_VERSION = 1;
const ATHLETES_STORE = 'athletes';
const OUTBOX_STORE = 'outbox';

type OutboxOperation = {
  id?: number;
  path: string;
  method: 'POST' | 'PATCH' | 'DELETE';
  body?: unknown;
  createdAt: number;
};

let dbPromise: Promise<IDBDatabase> | null = null;

function openDb(): Promise<IDBDatabase> {
  if (typeof window === 'undefined' || !('indexedDB' in window)) {
    return Promise.reject(new Error('IndexedDB غير متاح في هذا المتصفح'));
  }
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(ATHLETES_STORE)) db.createObjectStore(ATHLETES_STORE, { keyPath: 'id' });
      if (!db.objectStoreNames.contains(OUTBOX_STORE)) {
        const store = db.createObjectStore(OUTBOX_STORE, { keyPath: 'id', autoIncrement: true });
        store.createIndex('createdAt', 'createdAt');
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('تعذر فتح قاعدة البيانات المحلية'));
  });
  return dbPromise;
}

function transaction<T>(storeName: string, mode: IDBTransactionMode, work: (store: IDBObjectStore) => IDBRequest | void): Promise<T> {
  return openDb().then((db) => new Promise<T>((resolve, reject) => {
    const tx = db.transaction(storeName, mode);
    const result = work(tx.objectStore(storeName)) as IDBRequest | void;
    tx.oncomplete = () => resolve((result as IDBRequest | undefined)?.result as T);
    tx.onerror = () => reject(tx.error ?? new Error('فشلت عملية قاعدة البيانات المحلية'));
  }));
}

export async function cacheAthletes(rows: AthleteDto[]): Promise<void> {
  await openDb().then((db) => new Promise<void>((resolve, reject) => {
    const tx = db.transaction(ATHLETES_STORE, 'readwrite');
    const store = tx.objectStore(ATHLETES_STORE);
    for (const row of rows) store.put(row);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  }));
}

export function readCachedAthletes(): Promise<AthleteDto[]> {
  return transaction<AthleteDto[]>(ATHLETES_STORE, 'readonly', (store) => store.getAll());
}

export async function removeCachedAthletes(ids: string[]): Promise<void> {
  await openDb().then((db) => new Promise<void>((resolve, reject) => {
    const tx = db.transaction(ATHLETES_STORE, 'readwrite');
    const store = tx.objectStore(ATHLETES_STORE);
    ids.forEach((id) => store.delete(id));
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  }));
}

export function queueOfflineOperation(operation: Omit<OutboxOperation, 'id' | 'createdAt'>): Promise<void> {
  return transaction(OUTBOX_STORE, 'readwrite', (store) => store.add({ ...operation, createdAt: Date.now() }));
}

export function pendingOfflineOperations(): Promise<number> {
  return transaction<number>(OUTBOX_STORE, 'readonly', (store) => store.count());
}

async function readOutbox(): Promise<OutboxOperation[]> {
  return transaction<OutboxOperation[]>(OUTBOX_STORE, 'readonly', (store) => store.getAll());
}

async function deleteOutbox(id: number): Promise<void> {
  await transaction(OUTBOX_STORE, 'readwrite', (store) => store.delete(id));
}

/** يرسل العمليات بالترتيب؛ أول فشل يبقي العملية في الصندوق لإعادة المحاولة لاحقًا. */
export async function flushOfflineOperations(): Promise<number> {
  if (typeof navigator !== 'undefined' && !navigator.onLine) return 0;
  let flushed = 0;
  for (const operation of await readOutbox()) {
    if (operation.id === undefined) continue;
    try {
      const response = await fetch(`/api/v1${operation.path}`, {
        method: operation.method,
        headers: { Accept: 'application/json', 'Content-Type': 'application/json', 'Idempotency-Key': `offline-${operation.id}` },
        credentials: 'same-origin',
        body: operation.body === undefined ? undefined : JSON.stringify(operation.body),
      });
      if (!response.ok && response.status >= 500) break;
      if (!response.ok && response.status !== 409 && response.status !== 404) break;
      await deleteOutbox(operation.id);
      flushed += 1;
    } catch {
      break;
    }
  }
  return flushed;
}

export async function syncCachedAthletes(): Promise<AthleteDto[]> {
  const response = await fetch('/api/v1/athletes?page=1&pageSize=1000&sort=-createdAt', { credentials: 'same-origin', headers: { Accept: 'application/json' } });
  if (!response.ok) throw new Error('تعذر مزامنة الرياضيين');
  const payload = (await response.json()) as { data: AthleteDto[] };
  await cacheAthletes(payload.data);
  return payload.data;
}

export function startOfflineSync(): () => void {
  const sync = () => { void flushOfflineOperations().then(() => { if (navigator.onLine) void syncCachedAthletes().catch(() => undefined); }); };
  window.addEventListener('online', sync);
  const timer = window.setInterval(sync, 30_000);
  if (navigator.onLine) sync();
  return () => { window.removeEventListener('online', sync); window.clearInterval(timer); };
}
