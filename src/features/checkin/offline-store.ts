"use client";

import type { CheckinResult } from "@/generated/prisma/browser";
import type { OfflineEntry, OfflinePackage } from "@/server/services/checkin";

// Armazenamento do check-in offline no aparelho (IndexedDB, sem dependência nova):
// a lista baixada (hashes dos QR), os ingressos que ESTE aparelho já liberou e a fila de
// leituras para enviar. Tudo por evento. Falha do navegador (modo privado, bloqueio) vira
// "sem modo offline", nunca erro na leitura online.

const DB = "qqpega-checkin";
const STORE = "kv";

function open(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function get<T>(key: string): Promise<T | undefined> {
  const db = await open();
  return new Promise((resolve, reject) => {
    const req = db.transaction(STORE).objectStore(STORE).get(key);
    req.onsuccess = () => resolve(req.result as T | undefined);
    req.onerror = () => reject(req.error);
  });
}

async function set(key: string, value: unknown): Promise<void> {
  const db = await open();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, "readwrite");
    tx.objectStore(STORE).put(value, key);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

export type QueuedEntry = OfflineEntry & { localResult: CheckinResult };

export const offlineStore = {
  getPackage: (eventId: string) => get<OfflinePackage>(`pkg:${eventId}`),
  setPackage: (eventId: string, pkg: OfflinePackage) => set(`pkg:${eventId}`, pkg),
  /** Hashes que este aparelho já liberou (online ou offline) desde o download. */
  getUsed: async (eventId: string) => new Set((await get<string[]>(`used:${eventId}`)) ?? []),
  setUsed: (eventId: string, used: Set<string>) => set(`used:${eventId}`, [...used]),
  getQueue: async (eventId: string) => (await get<QueuedEntry[]>(`queue:${eventId}`)) ?? [],
  setQueue: (eventId: string, queue: QueuedEntry[]) => set(`queue:${eventId}`, queue),
};

/** SHA-256 (hex) do token, igual ao offlineTokenHash do servidor. Exige contexto seguro (HTTPS/localhost). */
export async function tokenHash(token: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
