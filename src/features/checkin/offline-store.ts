"use client";

import type { CheckinResult } from "@/generated/prisma/browser";
import type { OfflineEntry, OfflinePackage } from "@/server/services/checkin";
import { syncOfflineAction } from "./actions";

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

/**
 * Lê e grava uma chave numa única transação: o IndexedDB serializa transações de escrita no
 * mesmo store (também entre abas), então nenhuma outra escrita cai entre a leitura e a gravação.
 */
async function update<T>(key: string, fn: (current: T | undefined) => T): Promise<T> {
  const db = await open();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, "readwrite");
    const store = tx.objectStore(STORE);
    let next: T;
    const req = store.get(key);
    req.onsuccess = () => {
      next = fn(req.result as T | undefined);
      store.put(next, key);
    };
    tx.oncomplete = () => {
      db.close();
      resolve(next);
    };
    tx.onerror = tx.onabort = () => {
      db.close();
      reject(tx.error);
    };
  });
}

/** Todas as chaves e valores guardados (para limpezas seletivas). */
async function entries(): Promise<[string, unknown][]> {
  const db = await open();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE);
    const store = tx.objectStore(STORE);
    const keysReq = store.getAllKeys();
    const valuesReq = store.getAll();
    tx.oncomplete = () => {
      db.close();
      resolve((keysReq.result as IDBValidKey[]).map((k, i) => [String(k), valuesReq.result[i]]));
    };
    tx.onerror = tx.onabort = () => {
      db.close();
      reject(tx.error);
    };
  });
}

async function remove(keys: string[]): Promise<void> {
  const db = await open();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, "readwrite");
    for (const k of keys) tx.objectStore(STORE).delete(k);
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

/** `by`: conta que fez a leitura. Leituras antigas (sem `by`) valem para qualquer conta. */
export type QueuedEntry = OfflineEntry & { localResult: CheckinResult; by?: string };

/**
 * A leitura é desta conta? Só ela pode enviar (o servidor registra a entrada em nome de
 * quem envia) ou apagar ao sair; leituras de outra conta do mesmo aparelho ficam guardadas.
 */
export const queuedBy = (userId: string) => (e: QueuedEntry) => !e.by || e.by === userId;

export const offlineStore = {
  getPackage: (eventId: string) => get<OfflinePackage>(`pkg:${eventId}`),
  setPackage: (eventId: string, pkg: OfflinePackage) => set(`pkg:${eventId}`, pkg),
  /** Hashes que este aparelho já liberou (online ou offline) desde o download. */
  getUsed: async (eventId: string) => new Set((await get<string[]>(`used:${eventId}`)) ?? []),
  setUsed: (eventId: string, used: Set<string>) => set(`used:${eventId}`, [...used]),
  getQueue: async (eventId: string) => (await get<QueuedEntry[]>(`queue:${eventId}`)) ?? [],
  setQueue: (eventId: string, queue: QueuedEntry[]) => set(`queue:${eventId}`, queue),
  /** Acrescenta uma leitura à fila (atômico) e devolve a fila nova. */
  appendToQueue: (eventId: string, entry: QueuedEntry) => update<QueuedEntry[]>(`queue:${eventId}`, (q) => [...(q ?? []), entry]),
  /**
   * Tira da fila as leituras enviadas, comparando cada uma (não pela quantidade): leituras
   * novas, ou já tiradas por outro envio, nunca são apagadas sem ter chegado ao servidor.
   */
  removeFromQueue: (eventId: string, sent: QueuedEntry[]) =>
    update<QueuedEntry[]>(`queue:${eventId}`, (q) => {
      const rest = [...(q ?? [])];
      for (const s of sent) {
        const i = rest.findIndex((e) => e.payload === s.payload && e.scannedAt === s.scannedAt && e.localResult === s.localResult);
        if (i >= 0) rest.splice(i, 1);
      }
      return rest;
    }),
};

/**
 * Um envio da fila por vez, por evento, também entre abas (o leitor ao reconectar e o
 * "Enviar e sair"): sem isso, os dois mandariam as mesmas leituras ao servidor.
 * Sem Web Locks (navegador antigo), cai numa trava só desta aba.
 */
const localLocks = new Map<string, Promise<unknown>>();
export function withQueueLock<T>(eventId: string, fn: () => Promise<T>): Promise<T> {
  const name = `qqpega-checkin-sync:${eventId}`;
  if (typeof navigator !== "undefined" && navigator.locks) return navigator.locks.request(name, fn) as Promise<T>;
  const run = (localLocks.get(name) ?? Promise.resolve()).catch(() => {}).then(fn);
  localLocks.set(name, run);
  return run;
}

/**
 * Há algo do check-in offline guardado neste aparelho? Barato: não abre (nem cria) o banco
 * quando o navegador sabe listar os bancos existentes.
 */
export async function hasOfflineCheckinData(): Promise<boolean> {
  try {
    if (typeof caches !== "undefined" && (await caches.keys()).some((k) => k.startsWith("qqpega-checkin"))) return true;
    if ("serviceWorker" in navigator && (await navigator.serviceWorker.getRegistrations()).some((r) => new URL(r.scope).pathname.startsWith("/check-in/"))) return true;
    if (typeof indexedDB === "undefined") return false;
    // Sem a lista de bancos (navegadores antigos), abre o banco para conferir.
    if ("databases" in indexedDB && !(await indexedDB.databases()).some((d) => d.name === DB)) return false;
    // Só fila pendente não conta: ela é mantida de propósito quando a sessão expira.
    return (await entries()).some(([k]) => !k.startsWith("queue:"));
  } catch {}
  return false;
}

/**
 * Esquece um evento neste aparelho (perdeu o acesso ou o evento não existe mais): lista,
 * marcações, fila e a cópia da página do leitor. A fila não pode mais ser enviada por esta
 * conta, e guardá-la manteria dados de ingressos de um evento a que ela não tem acesso.
 */
export async function forgetOfflineEvent(eventId: string): Promise<void> {
  const tasks: Promise<unknown>[] = [];
  if (typeof indexedDB !== "undefined") tasks.push(remove([`pkg:${eventId}`, `used:${eventId}`, `queue:${eventId}`]));
  if (typeof caches !== "undefined") {
    const page = `${location.origin}/check-in/${encodeURIComponent(eventId)}`;
    tasks.push(caches.keys().then((keys) => Promise.all(keys.filter((k) => k.startsWith("qqpega-checkin")).map(async (k) => (await caches.open(k)).delete(page)))));
  }
  await Promise.race([Promise.allSettled(tasks), new Promise((r) => setTimeout(r, 1500))]);
}

/** Leituras offline desta conta ainda não enviadas, por evento. */
export async function pendingOfflineCheckins(userId: string): Promise<{ eventId: string; count: number }[]> {
  try {
    if (typeof indexedDB === "undefined") return [];
    if ("databases" in indexedDB && !(await indexedDB.databases()).some((d) => d.name === DB)) return [];
    return (await entries())
      .filter(([k, v]) => k.startsWith("queue:") && Array.isArray(v))
      .map(([k, v]) => ({ eventId: k.slice("queue:".length), count: (v as QueuedEntry[]).filter(queuedBy(userId)).length }))
      .filter((q) => q.count > 0);
  } catch {
    return [];
  }
}

/**
 * Envia as leituras pendentes desta conta (de todos os eventos), como o leitor faz ao
 * reconectar. Remove da fila só o que o servidor recebeu. Devolve quantas ainda ficaram e o motivo.
 */
export async function sendPendingOfflineCheckins(userId: string): Promise<{ sent: number; remaining: number; error?: string }> {
  let sent = 0;
  let error: string | undefined;
  for (const { eventId } of await pendingOfflineCheckins(userId)) {
    await withQueueLock(eventId, async () => {
      // Lotes de até 500 (limite do servidor); para no primeiro erro deste evento.
      for (let i = 0; i < 20; i++) {
        const pending = (await offlineStore.getQueue(eventId)).filter(queuedBy(userId));
        if (!pending.length) break;
        const batch = pending.slice(0, 500);
        try {
          const r = await syncOfflineAction(eventId, batch);
          if (!r.ok) {
            error = r.error;
            break;
          }
        } catch {
          error = "Sem conexão com o servidor.";
          break;
        }
        await offlineStore.removeFromQueue(eventId, batch);
        sent += batch.length;
      }
    });
  }
  const remaining = (await pendingOfflineCheckins(userId)).reduce((n, q) => n + q.count, 0);
  return { sent, remaining, error: remaining ? error : undefined };
}

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
 *
 * `keepPendingQueues`: sessão expirada, guarda todas as leituras não enviadas.
 * `keepPendingOfOthers`: "Sair" desta conta, guarda só as leituras feitas por outras contas
 * do aparelho (as desta conta já foram enviadas ou a pessoa escolheu apagar).
 */
export async function clearOfflineCheckinData(opts: { keepPendingQueues?: boolean; keepPendingOfOthers?: string } = {}): Promise<void> {
  const tasks: Promise<unknown>[] = [];
  if (typeof indexedDB !== "undefined") {
    tasks.push(
      (async () => {
        // Leituras ainda não enviadas ficam (sem nomes; só o conteúdo dos QR lidos), para a
        // entrada de quem passou não se perder. Saem quando a conta que leu sincroniza.
        const others = opts.keepPendingOfOthers;
        const keep = (e: QueuedEntry) => (others ? !queuedBy(others)(e) : !!opts.keepPendingQueues);
        const pending =
          opts.keepPendingQueues || others
            ? (await entries().catch(() => []))
                .filter(([k, v]) => k.startsWith("queue:") && Array.isArray(v))
                .map(([k, v]) => [k, (v as QueuedEntry[]).filter(keep)] as const)
                .filter(([, v]) => v.length > 0)
            : [];
        await new Promise<void>((resolve) => {
          const req = indexedDB.deleteDatabase(DB);
          req.onsuccess = req.onerror = req.onblocked = () => resolve();
        });
        for (const [k, v] of pending) await set(k, v);
      })(),
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
