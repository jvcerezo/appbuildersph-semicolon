import { useCallback, useEffect, useState } from 'react';
import type { Card, SummaryEvent } from '@linaw/contract';
import type { Segment } from '../state/session';

/**
 * Past sessions, kept on this computer in IndexedDB. Nothing here is sent to
 * the backend: it is the user's own library of hearings.
 */

export interface SavedSummary {
  overview: string;
  events: SummaryEvent[];
  openIssue?: string;
  /** When the summary was made (ms since epoch). */
  at: number;
}

export interface SessionRecord {
  id: string;
  title: string;
  startedAt: number;
  endedAt: number | null;
  /** Listening time in seconds (excludes pauses after "Audio stopped"). */
  durationSec: number;
  source: 'tab' | 'system' | 'file';
  segments: Segment[];
  /** Newest first, as shown live. */
  cards: Card[];
  saved: string[];
  summary?: SavedSummary;
}

const DB_NAME = 'linaw';
const DB_VERSION = 1;
const STORE = 'sessions';

let dbPromise: Promise<IDBDatabase> | null = null;

function openDb(): Promise<IDBDatabase> {
  dbPromise ??= new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE)) {
        db.createObjectStore(STORE, { keyPath: 'id' }).createIndex('startedAt', 'startedAt');
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  return dbPromise;
}

function run<T>(mode: IDBTransactionMode, work: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  return openDb().then(
    (db) =>
      new Promise<T>((resolve, reject) => {
        const request = work(db.transaction(STORE, mode).objectStore(STORE));
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      }),
  );
}

export const historyStore = {
  /** Newest first. */
  async list(): Promise<SessionRecord[]> {
    const all = await run<SessionRecord[]>('readonly', (s) => s.getAll());
    return all.sort((a, b) => b.startedAt - a.startedAt);
  },
  get: (id: string) => run<SessionRecord | undefined>('readonly', (s) => s.get(id)),
  put: (record: SessionRecord) => run('readwrite', (s) => s.put(record)).then(() => notify()),
  remove: (id: string) => run('readwrite', (s) => s.delete(id)).then(() => notify()),
  async update(id: string, change: (record: SessionRecord) => SessionRecord): Promise<void> {
    const current = await historyStore.get(id);
    if (current) await historyStore.put(change(current));
  },
};

// ---- change notifications, so every view of the library stays current

const listeners = new Set<() => void>();
function notify(): void {
  listeners.forEach((listener) => listener());
}

/** All past sessions, refreshed whenever one is saved or deleted. */
export function useSessionHistory(): { sessions: SessionRecord[]; loaded: boolean } {
  const [state, setState] = useState<{ sessions: SessionRecord[]; loaded: boolean }>({ sessions: [], loaded: false });
  const refresh = useCallback(() => {
    historyStore
      .list()
      .then((sessions) => setState({ sessions, loaded: true }))
      .catch((err) => {
        console.warn('[linaw] could not read past sessions:', err);
        setState({ sessions: [], loaded: true });
      });
  }, []);
  useEffect(() => {
    refresh();
    listeners.add(refresh);
    return () => {
      listeners.delete(refresh);
    };
  }, [refresh]);
  return state;
}

export function newId(prefix: string): string {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
}
