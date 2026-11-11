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
    const tx = db.transaction(STORE);
    const req = tx.objectStore(STORE).get(key);
    req.onsuccess = () => resolve(req.result as T | undefined);
    req.onerror = () => reject(req.error);
    // Fecha ao terminar: conexão aberta impediria apagar o banco ao sair da conta.
    tx.oncomplete = tx.onabort = () => db.close();
  });
}

async function set(key: string, value: unknown): Promise<void> {
  const db = await open();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, "readwrite");
    tx.objectStore(STORE).put(value, key);
    tx.oncomplete = () => {
      db.close();
      resolve();
    };
    tx.onerror = () => {
      db.close();
      reject(tx.error);
    };
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

// ---------------------------------------------------------------------------
// Abrir o leitor sem internet (service worker em /check-in/sw.js)
// ---------------------------------------------------------------------------

const SW_URL = "/check-in/sw.js";
const SW_SCOPE = "/check-in/";

/**
 * Depois do download da lista: registra o service worker do leitor e guarda a página atual
 * e os arquivos que ela carregou, para o leitor abrir (ou recarregar) sem internet.
 * Navegador sem suporte ou sem HTTPS: segue sem isso, como antes.
 */
export async function prepareOfflineShell(): Promise<boolean> {
  if (!("serviceWorker" in navigator) || !window.isSecureContext) return false;
  try {
    const registered = await navigator.serviceWorker.register(SW_URL, { scope: SW_SCOPE });
    // Espera o worker ativar, com teto: preparar o leitor offline nunca trava a tela.
    const worker = registered.active ?? registered.installing ?? registered.waiting;
    if (worker && worker.state !== "activated") {
      await Promise.race([
        new Promise<void>((resolve) => worker.addEventListener("statechange", () => worker.state === "activated" && resolve())),
        new Promise((resolve) => setTimeout(resolve, 5000)),
      ]);
    }
    const reg = { active: registered.active };
    // Arquivos da página: os do HTML (<script>, <link>) e os carregados depois (a lista do
    // `performance` tem limite de entradas, então só ela pode deixar arquivos de fora).
    const fromDom = [...document.querySelectorAll<HTMLScriptElement>("script[src]")].map((s) => s.src).concat([...document.querySelectorAll<HTMLLinkElement>("link[href]")].map((l) => l.href));
    const assets = [...performance.getEntriesByType("resource").map((e) => e.name), ...fromDom]
      .filter((u) => {
        try {
          const url = new URL(u);
          return url.origin === location.origin && url.pathname.startsWith("/_next/static/");
        } catch {
          return false;
        }
      });
    reg.active?.postMessage({ type: "cache-urls", urls: [location.pathname, ...new Set(assets)] });
    return true;
  } catch {
    return false;
  }
}

/**
 * Apaga tudo o que o check-in offline guardou neste aparelho: lista (com nomes dos
 * titulares), fila, cópia das páginas do leitor e o service worker. Usado ao sair da conta.
 * Nunca lança: falha aqui não pode impedir o logout.
 */
export async function clearOfflineCheckinData(): Promise<void> {
  const tasks: Promise<unknown>[] = [];
  if (typeof indexedDB !== "undefined") {
    tasks.push(
      new Promise<void>((resolve) => {
        const req = indexedDB.deleteDatabase(DB);
        req.onsuccess = req.onerror = req.onblocked = () => resolve();
      }),
    );
  }
  if (typeof caches !== "undefined") {
    tasks.push(caches.keys().then((keys) => Promise.all(keys.filter((k) => k.startsWith("qqpega-checkin")).map((k) => caches.delete(k)))));
  }
  if ("serviceWorker" in navigator) {
    // O worker que ainda controla esta página para de guardar e se desregistra (a página
    // segue controlada até fechar; sem isso, ele recriaria a cópia ao buscar a próxima tela).
    navigator.serviceWorker.controller?.postMessage({ type: "clear" });
    tasks.push(navigator.serviceWorker.getRegistrations().then((regs) => Promise.all(regs.filter((r) => new URL(r.scope).pathname.startsWith(SW_SCOPE)).map((r) => {
              r.active?.postMessage({ type: "clear" });
              return r.unregister();
            }))));
  }
  // Teto de tempo: o logout segue mesmo se o navegador demorar.
  await Promise.race([Promise.allSettled(tasks), new Promise((r) => setTimeout(r, 1500))]);
}
