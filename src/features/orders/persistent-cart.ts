"use client";

import { useCallback, useMemo, useSyncExternalStore, type SetStateAction } from "react";
const fallback = new Map<string, string>();
const eventName = "evento-brasil-cart-change";
function subscribe(onChange: () => void) { window.addEventListener("storage", onChange); window.addEventListener(eventName, onChange); return () => { window.removeEventListener("storage", onChange); window.removeEventListener(eventName, onChange); }; }
function read(key: string) { try { return window.localStorage.getItem(key); } catch { return fallback.get(key) ?? null; } }
function parse<T>(raw: string | null, initial: T): T { if (!raw) return initial; try { return JSON.parse(raw) as T; } catch { return initial; } }
/** Persists only ticket selection; no passwords, CPF, DOB or address enter browser storage. */
export function usePersistentCartState<T>(eventId: string, field: string, initial: T): [T, (value: SetStateAction<T>) => void] {
  const key = `eb-cart:${eventId}:${field}`;
  const snapshot = useSyncExternalStore(subscribe, useCallback(() => read(key), [key]), () => null);
  const value = useMemo(() => parse(snapshot, initial), [snapshot, initial]);
  const setValue = (next: SetStateAction<T>) => {
    const current = parse(read(key), initial);
    const resolved = typeof next === "function" ? (next as (current: T) => T)(current) : next;
    const serialized = JSON.stringify(resolved);
    try { window.localStorage.setItem(key, serialized); } catch { fallback.set(key, serialized); }
    window.dispatchEvent(new Event(eventName));
  };
  return [value, setValue];
}
